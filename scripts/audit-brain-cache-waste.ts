// ブレインのキャッシュが元を取れているか・キャッシュに乗せ直せる材料がどれだけあるかを測る（読み取りのみ）
// 2026-09-23 竹内「これプロンプトキャッシュ効くからもっと節約できるのでは？」
//   ① 5分キャッシュ（今回の発言の層の土台）は、5分以内にもう一度読まれているか（読まれないなら書き込み代の丸損）
//   ② 会話ごとに変わらない材料（アクションのルール・勝率表）がキャッシュの外（不一致側）にどれだけあるか
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-cache-waste.ts [DAYS=14]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const BRAIN_ROUTES = ["/api/generate-draft-bg-async", "/api/line-webhook", "/api/send-line-message", "/api/cron/brain-sweep", "/api/cron/generate-pending-drafts"];
const SONNET = { in: 3, read: 0.3, write: 3.75, out: 15 };
const DS = { in: 0.66, read: 0.022, write: 0.66, out: 1.98 };
type Row = { created_at: string; model: string; conversation_id: string | null; input_uncached: number | null; cache_read: number | null; cache_write: number | null; output_tokens: number | null; route: string };
const med = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;

async function main() {
  const days = Number(process.env.DAYS ?? 14);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Row[] = [];
  for (let p = 0; p < 40; p++) {
    const { data } = await sb.from("llm_usage_logs").select("created_at, model, conversation_id, input_uncached, cache_read, cache_write, output_tokens, route")
      .in("route", BRAIN_ROUTES).gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as Row[]; rows.push(...r); if (r.length < 1000) break;
  }
  const brain = rows.filter((r) => /sonnet/.test(r.model ?? "") && (r.output_tokens ?? 0) > 100);
  console.log(`直近${days}日のブレイン ${brain.length}回\n`);

  // ① 5分キャッシュ: 同じ会話の次の呼び出しまでの間隔
  const byConv = new Map<string, number[]>();
  for (const r of brain) { const k = r.conversation_id ?? "?"; if (!byConv.has(k)) byConv.set(k, []); byConv.get(k)!.push(new Date(r.created_at).getTime()); }
  let within5 = 0, within60 = 0, total = 0;
  for (const ts of byConv.values()) {
    ts.sort((a, b) => a - b);
    for (let i = 1; i < ts.length; i++) { total++; const d = ts[i] - ts[i - 1]; if (d <= 5 * 60_000) within5++; if (d <= 60 * 60_000) within60++; }
  }
  const writeMed = med(brain.map((r) => r.cache_write ?? 0));
  console.log(`① 5分キャッシュ（今回の発言の層の土台・書き込み中央値 ${writeMed} トークン）`);
  console.log(`   同じ会話の連続呼び出し ${total}回のうち 5分以内 ${within5}回（${((within5 / Math.max(total, 1)) * 100).toFixed(1)}%）／1時間以内 ${within60}回（${((within60 / Math.max(total, 1)) * 100).toFixed(1)}%）`);
  const writeCost = (writeMed * SONNET.write) / 1e6, plainCost = (writeMed * SONNET.in) / 1e6, readCost = (writeMed * SONNET.read) / 1e6;
  console.log(`   1回の書き込み代 $${writeCost.toFixed(4)} ／ キャッシュに載せず普通に送ると $${plainCost.toFixed(4)} ／ 2回目に読む時 $${readCost.toFixed(4)}`);
  console.log(`   → 5分以内の再利用が ${((plainCost - readCost) > 0 ? ((writeCost - plainCost) / (plainCost - readCost)) : 0).toFixed(2)} 回を超えないと元が取れない`);

  // ② キャッシュの外（不一致側）の大きさ
  const unc = med(brain.map((r) => r.input_uncached ?? 0));
  console.log(`\n② キャッシュの外（会話ごとに変わる入力）の中央値 ${unc} トークン`);
  console.log(`   Claude では $${((unc * SONNET.in) / 1e6).toFixed(4)}／回（1回 $${med(brain.map((r) => ((r.input_uncached ?? 0) * SONNET.in + (r.cache_read ?? 0) * SONNET.read + (r.cache_write ?? 0) * SONNET.write + (r.output_tokens ?? 0) * SONNET.out) / 1e6)).toFixed(4)} のうち）`);
  console.log(`   DeepSeek では $${((unc * DS.in) / 1e6).toFixed(4)}／回`);
  const moveTokens = 3000;   // アクションのルール4,212字＋勝率表362字 ≒ 3,000トークン（会話が変わっても同じ内容）
  console.log(`\n③ 会話が変わっても同じ材料（アクションのルール・勝率表 ≒ ${moveTokens} トークン）をキャッシュ側へ移した場合の1回あたりの差`);
  console.log(`   Claude   $${((moveTokens * (SONNET.in - SONNET.read)) / 1e6).toFixed(4)} 減 ／ DeepSeek $${((moveTokens * (DS.in - DS.read)) / 1e6).toFixed(4)} 減`);
  const perMonth = (brain.length / days) * 30;
  console.log(`   1か月（ブレイン ${Math.round(perMonth)}回）: Claude $${((moveTokens * (SONNET.in - SONNET.read)) / 1e6 * perMonth).toFixed(0)} 減 ／ DeepSeek $${((moveTokens * (DS.in - DS.read)) / 1e6 * perMonth).toFixed(0)} 減`);
}
main().catch((e) => { console.error(e); process.exit(1); });
