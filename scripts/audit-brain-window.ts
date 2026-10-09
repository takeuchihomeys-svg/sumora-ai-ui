// scripts/audit-brain-window.ts — ブレインの窓（直近 N 通）と会話のセーブデータ（15通ごとの要約）の間でこぼれる発言を測る（読むだけ・LLM なし）
//   2026-10-08 竹内さんの決定「ブレインの窓を 15→20 通にして、会話の要約（15通ごと）との間でこぼれる発言を塞ぐ」
//   判断1件ごとに: その時の総通数（analyzed_msg_ts まで）・その時の最新のセーブデータの位置（message_count_at_creation）
//     こぼれ = 総通数 − セーブの位置 − 窓（正の時だけ）。セーブが無い会話は 総通数 − 窓（11通未満はセーブを作らない）
//   増える通（16〜20通目）の字数 → 入力トークンの増え方の見込み
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-window.ts [--since=2026-09-23] [--n=400]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const SINCE = arg("since", "2026-09-23T00:00:00+09:00");
const N = Number(arg("n", "400"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type D = { conversation_id: string; created_at: string; analyzed_msg_ts: string | null };
async function main() {
  const all: D[] = [];
  for (let i = 0; i < 50_000; i += 1000) {
    const r = await sb.from("brain_decision_logs").select("conversation_id, created_at, analyzed_msg_ts").gte("created_at", SINCE).order("created_at").range(i, i + 999);
    if (r.error) throw new Error(r.error.message);
    all.push(...((r.data ?? []) as D[]));
    if ((r.data ?? []).length < 1000) break;
    await sleep(200);
  }
  const rows = all.filter((d) => !isTestConversation(d.conversation_id));
  // 等間隔に N 件
  const step = Math.max(1, Math.floor(rows.length / N));
  const sample = rows.filter((_, i) => i % step === 0).slice(0, N);
  const windows = [15, 20, 25];
  const spill: Record<number, number[]> = { 15: [], 20: [], 25: [] };
  const gaps: number[] = [];
  let noCp = 0;
  const hasCp: boolean[] = [];
  const extraChars: number[] = [];
  for (const d of sample) {
    const at = d.analyzed_msg_ts ?? d.created_at;
    const [cnt, cp, recent] = await Promise.all([
      sb.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", d.conversation_id).lte("created_at", at),
      sb.from("conversation_checkpoints").select("message_count_at_creation").eq("conversation_id", d.conversation_id).lte("created_at", d.created_at).order("checkpoint_index", { ascending: false }).limit(1).maybeSingle(),
      sb.from("messages").select("text").eq("conversation_id", d.conversation_id).lte("created_at", at).order("created_at", { ascending: false }).range(15, 19),
    ]);
    const total = cnt.count ?? 0;
    const cpAt = (cp.data as { message_count_at_creation: number } | null)?.message_count_at_creation ?? null;
    if (cpAt == null) noCp++;
    hasCp.push(cpAt != null);
    const gap = total - (cpAt ?? 0);
    gaps.push(gap);
    for (const w of windows) spill[w].push(Math.max(0, gap - w));
    const ex = ((recent.data ?? []) as Array<{ text: string | null }>).reduce((s, m) => s + (m.text ?? "（画像/添付）").length + 20, 0);
    extraChars.push(ex);
    await sleep(60);
  }
  const pct = (a: number[], f: (x: number) => boolean) => `${a.filter(f).length}/${a.length}（${Math.round((a.filter(f).length / Math.max(1, a.length)) * 1000) / 10}%）`;
  const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
  console.log(`判断 ${rows.length} 件（テスト除く・${SINCE}〜）から ${sample.length} 件`);
  console.log(`セーブデータ無し（その時点）: ${noCp}`);
  console.log(`セーブの位置からの通数 gap: 中央 ${q(gaps, 0.5)}・90% ${q(gaps, 0.9)}・99% ${q(gaps, 0.99)}・最大 ${Math.max(...gaps)}`);
  for (const w of windows) {
    const s = spill[w];
    console.log(`窓 ${w} 通: こぼれる判断 ${pct(s, (x) => x > 0)}・こぼれる通の合計 ${s.reduce((a, b) => a + b, 0)}・セーブ有り ${pct(s.filter((_, i) => hasCp[i]), (x) => x > 0)}・セーブ無し ${pct(s.filter((_, i) => !hasCp[i]), (x) => x > 0)}`);
  }
  const avgEx = extraChars.reduce((a, b) => a + b, 0) / Math.max(1, extraChars.length);
  console.log(`16〜20通目の字数（1判断あたり・見出し込みの目安）: 平均 ${Math.round(avgEx)}・中央 ${q(extraChars, 0.5)}・90% ${q(extraChars, 0.9)}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
