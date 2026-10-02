// app/lib/__tests__/viewing-candidates.test.ts
// 2026-10-02 竹内「直近は基本3候補いれる。2候補でも大丈夫やけど、候補多く出すため直近3候補が基本」の回帰テスト。
//   YUMA の AIX【内覧調整】は「10/3(土) 11:00〜13:00／10/4(日) 14:00〜16:00」の2つだった（本日の枠が過ぎた後・テストの固定の候補も2つ）。
// 実行: npx tsx app/lib/__tests__/viewing-candidates.test.ts
import { nearestBookableDays, baseDaysToKeep, VIEWING_CANDIDATE_DAYS, VIEWING_LOOKAHEAD_DAYS } from "../viewing-candidates";
import { fixedViewingSlots } from "../customer-sim-material";
import { classifyAixAutofill } from "../aix-autofill-readiness";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const D = (free: boolean) => ({ fullyBooked: !free, slots: free ? ["13:00〜15:00"] : [] });

t("基本は3つ", VIEWING_CANDIDATE_DAYS === 3 && VIEWING_LOOKAHEAD_DAYS >= 5);
{
  // 本日の枠が過ぎた（YUMA の 10/02 夕方）: 本日✗ 明日○ 明後日○ 3日後○ → 明日・明後日・3日後（旧は明日・明後日の2つ）
  const days = [D(false), D(true), D(true), D(true), D(true), D(true), D(true)];
  t("本日が無い日は 明日・明後日・3日後", JSON.stringify(nearestBookableDays(days, 3, 7)) === "[1,2,3]");
  t("並べる基準の日は 3日後まで（4日）", baseDaysToKeep(days, 7) === 4);
}
{
  const days = [D(true), D(true), D(true), D(true), D(true), D(true), D(true)];
  t("本日から空いていれば 本日・明日・明後日", JSON.stringify(nearestBookableDays(days, 3, 7)) === "[0,1,2]");
  t("並べる基準の日は3日（旧と同じ並び）", baseDaysToKeep(days, 7) === 3);
}
{
  const days = [D(false), D(false), D(true), D(false), D(false), D(true), D(false)];
  t("埋まっている日は飛ばす（3つ無ければある分＝2つ）", JSON.stringify(nearestBookableDays(days, 3, 7)) === "[2,5]");
  t("3つ見つからなければ基準の日を全部並べる", baseDaysToKeep(days, 7) === 7);
}
{
  const days = [D(true), D(true), D(true), D(true), D(true)];
  t("基準の日の後ろ（お客様の希望日）は選ばない", JSON.stringify(nearestBookableDays([...days, D(true)], 3, 2)) === "[0,1]");
}
{
  const f = fixedViewingSlots(Date.parse("2026-10-02T09:00:00Z"));
  t("テストの道具の固定の候補も3つ", f.length === 3, JSON.stringify(f));
  const a = classifyAixAutofill({ action: "viewing_invite", customerText: "かしこまりました！よろしくお願いします", nowMs: Date.parse("2026-10-02T09:00:00Z") });
  t("自動反映の内覧調整の候補も3行", String(a.request?.calendar_info ?? "").split("\n").length === 3, String(a.request?.calendar_info));
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
