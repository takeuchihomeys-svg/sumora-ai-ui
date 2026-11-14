// app/lib/__tests__/automation-previous-day.test.ts
// 2026-11-14 竹内さん「自動の部分は日を超えたら前日のはしなくて大丈夫になっているかな。
//   日ごとにやるから前日にできていなくても持ち越さない」
//
//   ⚠ 旧は3時間（拾い手が動いている間は最大12時間）待っていたので、日をまたいで翌日に実行されていた。
//     実測: 825件のうち12件が「便の日 ≠ 実行日」（9/30 の午後の便が 10/01 の 0〜2時に 8〜9時間遅れ）。
//   → 前の日の自動便は **渡さない**。今日の便は今日ふたたび積まれるので持ち越さない。
import { isPreviousDayAuto, jstDateOf, pickClaimable, AUTO_DAY_EXPIRE_MESSAGE } from "../automation-sources";

let passed = 0;
let failed = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + "\n      actual:   " + a + "\n      expected: " + b); }
}

// 2026-11-15 00:30 JST（＝UTC では 11-14 15:30）。日をまたいだ直後に拾いに来た場面
const AFTER_MIDNIGHT = Date.parse("2026-11-15T00:30:00+09:00");
const SAME_DAY = Date.parse("2026-11-14T23:10:00+09:00");

const auto = (jstDate: string, extra?: Record<string, unknown>) => ({
  id: "a-" + jstDate,
  payload: { source: "auto_schedule", jst_date: jstDate, ...(extra ?? {}) },
});

console.log("■ JST の日付（UTC の日付と混ざらない）");
eq("JST 0:30 は前日の UTC 日付にならない", jstDateOf(AFTER_MIDNIGHT), "2026-11-15");
eq("JST 23:10 は同じ日", jstDateOf(SAME_DAY), "2026-11-14");

console.log("■ 前の日の自動便は「前の日」と判定する");
eq("前の日の午後の便（日をまたいだ直後）", isPreviousDayAuto(auto("2026-11-14"), AFTER_MIDNIGHT), true);
eq("今日の午前の便（日をまたいだ直後）", isPreviousDayAuto(auto("2026-11-15"), AFTER_MIDNIGHT), false);
eq("同じ日のうちは前の日ではない", isPreviousDayAuto(auto("2026-11-14"), SAME_DAY), false);

console.log("■ 自動便以外・古い命令は今まで通り（誤って捨てない）");
eq("AIX の指示は対象外", isPreviousDayAuto({ payload: { source: "aix" } }, AFTER_MIDNIGHT), false);
eq("ブレインの指示は対象外", isPreviousDayAuto({ payload: { source: "web_brain" } }, AFTER_MIDNIGHT), false);
eq("source が無い命令は対象外", isPreviousDayAuto({ payload: {} }, AFTER_MIDNIGHT), false);
eq("payload が無い命令は対象外", isPreviousDayAuto({}, AFTER_MIDNIGHT), false);
eq("jst_date が無い古い自動便は対象外（fail-open）", isPreviousDayAuto({ payload: { source: "auto_schedule" } }, AFTER_MIDNIGHT), false);

console.log("■ 拾う時：前の日の自動便は渡さない（今日の便は渡す）");
eq("前の日だけなら null（誰にも渡さない）", pickClaimable([auto("2026-11-14")], AFTER_MIDNIGHT), null);
eq("前の日と今日があれば今日の分", pickClaimable([auto("2026-11-14"), auto("2026-11-15")], AFTER_MIDNIGHT)?.id, "a-2026-11-15");
eq("前の日の自動便があっても手の検索は渡す", pickClaimable(
  [auto("2026-11-14"), { id: "w", payload: { source: "web_brain" } }], AFTER_MIDNIGHT,
)?.id, "w");
eq("前の日の自動便があっても AIX は渡す", pickClaimable(
  [auto("2026-11-14"), { id: "x", payload: { source: "aix" } }], AFTER_MIDNIGHT,
)?.id, "x");

console.log("■ 閉じる時の言葉が人に分かる");
eq("理由に『前の日』『持ち越さない』が入っている",
  /前の日/.test(AUTO_DAY_EXPIRE_MESSAGE) && /持ち越さない/.test(AUTO_DAY_EXPIRE_MESSAGE), true);

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
