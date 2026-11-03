// scripts/__tests__/auto-send-line.test.ts — 場面ごとの自動送信の線
//   実行: npx tsx scripts/__tests__/auto-send-line.test.ts
import { wilsonLower, gradeScene, tallyTurns, askScenes } from "../lib/auto-send-line-core";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
t("Wilson 下限: 30/30 は 88.6%", Math.abs(wilsonLower(30, 30) - 0.886) < 0.002);
t("Wilson 下限: 0 番は 0", wilsonLower(0, 0) === 0);
t("40/40・外れ0 は候補", gradeScene({ scene: "a", n: 40, match: 40, pathMiss: 0, blocks: 0 }).grade === "候補");
t("29/29 は数が足りず近い", gradeScene({ scene: "a", n: 29, match: 29, pathMiss: 0, blocks: 0 }).grade === "近い");
t("道の外れが1つあれば候補にしない", gradeScene({ scene: "a", n: 60, match: 59, pathMiss: 1, blocks: 0 }).grade === "近い");
t("一致 70% は遠い", gradeScene({ scene: "a", n: 50, match: 35, pathMiss: 0, blocks: 0 }).grade === "遠い");
const rows = [
  { scene_key: "返信:お礼", verdict: "same", verdict_detail: { path: "返信" }, final_check: null },
  { scene_key: "返信:お礼", verdict: "partial", verdict_detail: { path: "返信", aix_verdict: "unexpected" }, final_check: { issues: [{ severity: "block" }] } },
  { scene_key: "返信:お礼", verdict: "na", verdict_detail: { path: "対象外" }, final_check: null },
  { scene_key: "AIX:内覧", verdict: "different", verdict_detail: { path: "AIX", aix_verdict: "not_pressed" }, final_check: null },
];
const tl = tallyTurns(rows);
t("na は数えない・一致・道の外れ・block を数える", JSON.stringify(tl.find((x) => x.scene === "返信:お礼")) === JSON.stringify({ scene: "返信:お礼", n: 2, match: 1, pathMiss: 1, blocks: 1 }));
t("AI が AIX・押さず外れは道の外れ", tl.find((x) => x.scene === "AIX:内覧")!.pathMiss === 1);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
