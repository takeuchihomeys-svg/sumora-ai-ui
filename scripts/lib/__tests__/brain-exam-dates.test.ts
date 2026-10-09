// ブレインの試験の日付のずらし（scripts/lib/brain-exam-dates.ts）
// 実行: npx tsx scripts/lib/__tests__/brain-exam-dates.test.ts（自己完結。全 PASS で exit 0）
import { shiftExamText, shiftBareDay } from "../brain-exam-dates";

let fail = 0, pass = 0;
function eq(name: string, a: unknown, b: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) pass++; else { fail++; console.error(`✗ ${name}\n   得: ${JSON.stringify(a)}\n   期: ${JSON.stringify(b)}`); }
}
const at = (iso: string) => Date.parse(iso);

// q049: 9/12（JST）の番で 28日ずらす。スタッフの「9/18日」は 10/16、お客様の「18の南船場の内覧」も 16 に
eq("M/D はそのまま shiftDatesInText", shiftExamText("9/18日の14:00からArtizA南船場", 28, 2026, at("2026-09-12T14:00:00Z")), "10/16日の14:00からArtizA南船場");
eq("日だけ＋内覧（q049）", shiftExamText("18の南船場の内覧のあと行けますか？", 28, 2026, at("2026-09-12T14:00:00Z")), "16の南船場の内覧のあと行けますか？");
eq("日だけ「18日」", shiftExamText("18日こちらのお部屋もご案内させて頂きます", 28, 2026, at("2026-09-12T14:00:00Z")), "16日こちらのお部屋もご案内させて頂きます");
// q060: 要点の「10/31」も会話と同じにずれる（9/23 の番・21日）
eq("要点の M/D（q060）", shiftExamText("10/31入居なら初期費用は日割1日分＋11月分", 21, 2026, at("2026-09-23T10:00:00Z")), "11/21入居なら初期費用は日割1日分＋11月分");
// 期間は触らない
eq("期間: 10日程", shiftExamText("お申込日から10日程でご入居できます", 28, 2026, at("2026-09-12T14:00:00Z")), "お申込日から10日程でご入居できます");
eq("期間: 3日間・5日以内・2日前", shiftExamText("3日間・5日以内・2日前・1日分", 28, 2026, at("2026-09-12T14:00:00Z")), "3日間・5日以内・2日前・1日分");
eq("月の後の日は二重にずらさない", shiftExamText("9月13日以降", 42, 2026, at("2026-08-30T10:00:00Z")), "10月25日以降");
eq("日割の「1日分」は触らない", shiftExamText("10/31〜10/31の日割家賃（1日分）", 21, 2026, at("2026-09-23T10:00:00Z")), "11/21〜11/21の日割家賃（1日分）");
eq("URL の中は触らない", shiftExamText("https://x.jp/18日 18日", 28, 2026, at("2026-09-12T14:00:00Z")), "https://x.jp/18日 16日");
eq("来月の日（9/27 に 3日）", shiftBareDay(3, at("2026-09-27T03:00:00Z"), 7), 10);
eq("ずらさない時はそのまま", shiftExamText("18の内覧", 0, 2026, at("2026-09-12T14:00:00Z")), "18の内覧");
eq("内覧の無い「18の」は触らない", shiftExamText("18の物件", 28, 2026, at("2026-09-12T14:00:00Z")), "18の物件");

console.log(`brain-exam-dates: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
