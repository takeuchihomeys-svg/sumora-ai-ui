// app/lib/__tests__/quality-daily-server.test.ts — 見張りの判定の後の返信の一致（2026-11-21 作業員N）
//   実行: npx tsx app/lib/__tests__/quality-daily-server.test.ts
import { replyMatchOf, qualityDailyFromEvalOn } from "../quality-daily-server";
import { needsFix, groupOf } from "../../../scripts/lib/self-improve-growth";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

t("既定 on・=off で止める", qualityDailyFromEvalOn({}) && !qualityDailyFromEvalOn({ QUALITY_DAILY_FROM_EVAL: "off" }));
const m = replyMatchOf([{ verdict: "same", writer: "takeuchi" }, { verdict: "different", writer: "takeuchi" }, { verdict: "same_meaning", writer: "employee" }, { verdict: "partial", writer: null }]);
t("全体の一致", m.all.n === 4 && m.all.value === 50);
t("竹内さんの番", m.takeuchi.n === 2 && m.takeuchi.value === 50);
t("番が無い日は null", replyMatchOf([]).all.value === null);

// 伸びしろの見張り（毎朝の1枚と同じ決まり）
t("前の日より下がった＝down", needsFix(60, 70, 50, 10) === "down");
t("前の週から上がっていない＝flat", needsFix(70, 65, 70, 10) === "flat");
t("上がった＝候補にしない", needsFix(80, 70, 60, 10) === null);
t("数が少ない日は見ない", needsFix(10, 90, 90, 2) === null);
t("直した割合は低い方が良い", needsFix(95, 90, 97, 10, 3, false) === "down" && needsFix(80, 85, 90, 10, 3, false) === null);
t("種類の分け", groupOf("property_send") === "物件" && groupOf("property_check_result") === "物件確認" && groupOf("estimate_sheet") === "見積" && groupOf("meeting_place") === "内覧" && groupOf("phone_call") === "電話" && groupOf("x") === "その他");

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
