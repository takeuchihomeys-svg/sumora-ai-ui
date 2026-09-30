// 実行: npx tsx app/lib/__tests__/floor-plan-too-small.test.ts
// 2026-09-30 c さん（2LDK 希望・検索に間取りが入らないまま 1K・1DK を50件）: 希望より部屋数が少ない K／DK／R は「外す」。
//   実物は 9/30 14:14 の property_pickups（#2131〜#2180・全部 1K か 1DK・判定は保留どまりで 👑 が付いた）。
import { isTooSmallPlan, normalizeFloorPlanWant, DROP_REASON_CODES, HOLD_REASON_CODES } from "../property-brain";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, note = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${note}`); } }
const small = (want: string, plan: string) => isTooSmallPlan(normalizeFloorPlanWant(want), plan);

console.log("\n■ 外す（希望より部屋数が少ない K／DK／R）");
t("★ 2LDK 希望に 1K（c さんの実物）", small("2LDK", "1K"));
t("★ 2LDK 希望に 1DK", small("2LDK", "1DK"));
t("2LDK 希望に 1R・ワンルーム", small("2LDK", "1R") && small("2LDK", "ワンルーム"));
t("「2LDK〜」希望に 1DK（9/28 の実物 #968）", small("2LDK〜", "1DK"));
t("「２K　2DK 2LDK」希望に 1DK（9/28 の実物 #1686）", small("２K　2DK 2LDK", "1DK"));
t("3LDK 希望に 2DK・1K", small("3LDK", "2DK") && small("3LDK", "1K"));
t("「2LDK以上」希望に 1K", small("2LDK以上", "1K"));

console.log("\n■ 外さない（今まで通り）");
t("2LDK 希望に 1LDK（部屋数は少ないが LDK＝保留のまま）", !small("2LDK", "1LDK"));
t("2LDK 希望に 2DK・2K（部屋数は同じ）", !small("2LDK", "2DK") && !small("2LDK", "2K"));
t("1LDK 希望に 1K・1DK（部屋数は同じ＝近い）", !small("1LDK", "1K") && !small("1LDK", "1DK"));
t("1LDK か 2LDK の希望に 1DK（小さい方の希望と同じ部屋数）", !small("1LDKか2LDK", "1DK"));
t("希望より広い（1LDK 希望に 2LDK）", !small("1LDK", "2LDK"));
t("希望なし・空", !small("希望なし", "1K") && !small("", "1K"));
t("物件の間取りが読めない", !small("2LDK", "") && !small("2LDK", "不明"));

console.log("\n■ 札の扱い");
t("FLOOR_PLAN_TOO_SMALL は外す候補の札", DROP_REASON_CODES.has("FLOOR_PLAN_TOO_SMALL") && !HOLD_REASON_CODES.has("FLOOR_PLAN_TOO_SMALL"));
t("FLOOR_PLAN_MISMATCH は保留の札のまま", HOLD_REASON_CODES.has("FLOOR_PLAN_MISMATCH"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
