// scripts/lib/__tests__/exam-focus-scenes.test.ts — 試験を寄せる場面の順位（#823 ③・2026-11-27 作業員A）
//   実行: npx tsx scripts/lib/__tests__/exam-focus-scenes.test.ts
import { focusTable, focusLine, problemSceneOf, type WatchRow } from "../exam-focus-scenes";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const W = (o: Partial<WatchRow>): WatchRow => ({ scene: "返信:質問", verdict: "same", aixVerdict: null, brainReply: true, staffAix: false, ...o });
t("場面の対応: 見張りの場面 → 試験の場面", problemSceneOf("返信:短い了承・お礼") === "ack" && problemSceneOf("返信:質問") === "question" && problemSceneOf("AIX:viewing_invite") === "viewing" && problemSceneOf("AIX:estimate_sheet") === "cost" && problemSceneOf("対象外:申込以降") === null);
const rows = [
  W({}), W({ verdict: "partial" }), W({ verdict: "different" }), W({ verdict: "same", staffAix: true }),
  W({ scene: "AIX:viewing_invite", verdict: null, aixVerdict: "not_pressed", brainReply: false }),
  W({ scene: "返信:短い了承・お礼", verdict: "na" }), W({ scene: "対象外:申込以降", verdict: "different" }),
];
const tb = focusTable(rows, { question: 2, viewing: 40, ack: 3 });
const q = tb.find((r) => r.scene === "返信:質問")!;
t("外れ: 文の外れ・返信を AIX を数える・同じは外れでない", q.judged === 4 && q.miss === 3 && q.textMiss === 2 && q.replyAsAix === 1 && q.missRate === 75);
t("AIX の外れ（not_pressed）も判定に入る", tb.find((r) => r.scene === "AIX:viewing_invite")?.aixMiss === 1);
t("判定の無い番（na）と申込以降は数えない", tb.find((r) => r.scene === "返信:短い了承・お礼")?.judged === 0 && !tb.some((r) => r.scene === "対象外:申込以降"));
t("順位: 外れが多く問題が少ない場面が先（点＝外れ÷(1＋問題/5)）", tb[0].scene === "返信:質問" && tb[0].score === Math.round((3 / (1 + 2 / 5)) * 10) / 10);
t("朝の1行: 上位3つ・外れ0の場面は出さない", /^- 試験を寄せる場面（見張りの 14日/.test(focusLine(tb, 14)) && /1\. 返信:質問（外れ 3\/4/.test(focusLine(tb, 14)) && !/短い了承/.test(focusLine(tb, 14)));
t("外れが無ければ「なし」", /外れの多い場面なし/.test(focusLine([], 14)));
console.log(`exam-focus-scenes: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
