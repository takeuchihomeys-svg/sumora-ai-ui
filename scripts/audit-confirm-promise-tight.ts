// 確認の約束の見つけ方（final-check-brain-align.findConfirmPromiseSentence）の直し（CONFIRM_PROMISE_TIGHT）で、当たりが変わる文を並べる（読むだけ・LLM なし）
//   下書き（line_reply）と竹内さんの実送信の両方。変わった文を目で読む
// 実行: npx tsx --env-file=.env.local scripts/audit-confirm-promise-tight.ts [--days=60]
import { loadTurns } from "./audit-draft-repeat";
import { findConfirmPromiseSentence } from "../app/lib/final-check-brain-align";
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 60);
(async () => {
  const turns = await loadTurns(DAYS);
  for (const [label, pick] of [["下書き", (t: { draft: string }) => t.draft], ["竹内さんの実送信", (t: { sent: string; writer: string | null }) => (t.writer === "takeuchi" ? t.sent : "")]] as const) {
    let oldN = 0, newN = 0; const diffs: string[] = [];
    for (const t of turns) {
      const s = (pick as (x: typeof t) => string)(t); if (!s) continue;
      const o = findConfirmPromiseSentence(s, { CONFIRM_PROMISE_TIGHT: "off" }), n = findConfirmPromiseSentence(s, {});
      if (o) oldN++; if (n) newN++;
      if ((o ?? "") !== (n ?? "")) diffs.push(`${t.id.slice(0, 8)} 旧: ${o ?? "-"} ｜ 新: ${n ?? "-"}`);
    }
    console.log(`\n=== ${label}（${DAYS}日）: 確認の約束の文が見つかる 旧 ${oldN} → 新 ${newN}・変わった ${diffs.length} ===`);
    for (const d of diffs) console.log(`   ${d.replace(/\n/g, " ")}`);
  }
})();
