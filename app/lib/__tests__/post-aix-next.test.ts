// app/lib/__tests__/post-aix-next.test.ts — 2026-10-16 AIX の続きの「次の AIX」（10/16 の事例 a・b）
//   実行: npx tsx app/lib/__tests__/post-aix-next.test.ts
import { nextAixAfterAix, hasSearchConditions, postAixNextEnabled } from "../post-aix-turn";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
t("(a) 物件ピックアップした → 物件オススメ", nextAixAfterAix({ aixType: "property_send", hasConditions: true })?.action === "property_recommendation");
t("(b) 募集に出ていない・条件なし → ヒアリング", nextAixAfterAix({ aixType: "property_check_result", checkPattern: "unavailable", hasConditions: false })?.action === "condition_hearing");
t("(b) 募集に出ていない・条件あり → 新しくピックアップ", nextAixAfterAix({ aixType: "property_check_result", checkPattern: "unavailable", hasConditions: true })?.action === "property_send");
t("募集中の確認結果は今まで通り（null）", nextAixAfterAix({ aixType: "property_check_result", checkPattern: "available", hasConditions: true }) === null);
t("物件オススメは今まで通り（同じテンプレの2通目）", nextAixAfterAix({ aixType: "property_recommendation", hasConditions: true }) === null);
t("条件: エリアと家賃", hasSearchConditions({ desired_area: "心斎橋", rent_max: 150000 }) && !hasSearchConditions({ desired_area: "心斎橋", rent_max: null }) && !hasSearchConditions(null));
t("既定 on", postAixNextEnabled(undefined) && !postAixNextEnabled("off"));
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
