// scripts/audit-waited-gap.ts — 「お待たせ致しました」は前の文から3時間以上たった時（AIX の文だけ）の線を実送信で確かめる
// 実行: npx tsx --env-file=.env.local scripts/audit-waited-gap.ts [--days=120]
// 2026-10-06 竹内「お待たせ致しました は前の文から3時間以上経過したとき。AIXからの文にでるだけで通常の返信にはださない」
//   ① AIX の実送信（messages.is_aix_generated）で、前の発言からの間（3時間以上／未満）ごとに冒頭の「お待たせ」の率（AIX の種類ごと）
//   ② 新しい出口（3時間未満の AIX だけ消す・3時間以上は残す・通常返信は今まで通り）を全実送信に当てた時に「お待たせ」以外の字が変わる通の数（0 であるべき）
// 読み取りのみ
import { createClient } from "@supabase/supabase-js";
import { waitedGapAllowed, WAITED_GAP_MS } from "../app/lib/waited-scope";
import { WAITED_RE } from "../app/lib/greeting";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=120").split("=")[1]);
const since = new Date(Date.now() - days * 86400_000).toISOString();

async function pageAll<T>(q: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; ; p++) { const { data, error } = await q(p * 1000, p * 1000 + 999); if (error) throw new Error(error.message); if (!data?.length) break; out.push(...data); if (data.length < 1000) break; }
  return out;
}

async function main() {
  type M = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
  const msgs = await pageAll<M>((a, b) => sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated").gte("created_at", since).order("created_at").range(a, b));
  const aix = await pageAll<{ conversation_id: string; aix_type: string | null; sent_at: string | null; created_at: string }>((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, sent_at, created_at").gte("created_at", since).range(a, b));
  const byConv = new Map<string, M[]>();
  for (const m of msgs) byConv.set(m.conversation_id, [...(byConv.get(m.conversation_id) ?? []), m]);
  const aixTypeAt = (conv: string, at: string) => {
    const t = Date.parse(at);
    return aix.filter((r) => r.conversation_id === conv && Math.abs(Date.parse(r.sent_at ?? r.created_at) - t) < 3 * 60_000).map((r) => r.aix_type)[0] ?? "(不明)";
  };
  const stat: Record<string, { ge: number; geW: number; lt: number; ltW: number }> = {};
  let replyWaited = 0, replyN = 0;
  for (const [conv, list] of byConv) {
    list.forEach((m, i) => {
      if (m.sender === "customer" || !m.text || /^\[(?:画像|動画|スタンプ|ファイル)\]/.test(m.text.trim())) return;
      // 前の発言（同じ束の画像・同時刻の送信は飛ばす＝3分以内のこちらの発言）
      let k = i - 1;
      while (k >= 0 && list[k].sender !== "customer" && Date.parse(m.created_at) - Date.parse(list[k].created_at) < 3 * 60_000) k--;
      if (k < 0) return;
      const gapOk = waitedGapAllowed(list[k].created_at, m.created_at);
      const head = m.text.split("\n").slice(0, 3).join("\n");
      const w = WAITED_RE.test(head);
      if (!m.is_aix_generated) { replyN++; if (w) replyWaited++; return; }
      const key = aixTypeAt(conv, m.created_at);
      const s = (stat[key] ??= { ge: 0, geW: 0, lt: 0, ltW: 0 });
      if (gapOk) { s.ge++; if (w) s.geW++; } else { s.lt++; if (w) s.ltW++; }
    });
  }
  console.log(`=== ① AIX の実送信の冒頭の「お待たせ」（${days}日・前の発言から ${WAITED_GAP_MS / 3600_000}時間以上／未満）===`);
  for (const [k, s] of Object.entries(stat).sort((a, b) => (b[1].ge + b[1].lt) - (a[1].ge + a[1].lt))) {
    const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
    console.log(`  ${k.padEnd(32)} 3時間以上 ${s.geW}/${s.ge}（${pct(s.geW, s.ge)}）・未満 ${s.ltW}/${s.lt}（${pct(s.ltW, s.lt)}）`);
  }
  console.log(`  手打ち（AIX でない）: 冒頭の「お待たせ」 ${replyWaited}/${replyN}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
