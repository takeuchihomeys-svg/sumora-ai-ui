// app/lib/__tests__/move-in-deadline.test.ts
// 2026-09-18 竹内（ゆーた 事例）「10月中の入居って10月末までなので、こんなに急がなくても大丈夫。
//   今まだ9月なのに、なぜかここの10月の部分を間違えて捉えてしまっている」
// 実行: npx tsx app/lib/__tests__/move-in-deadline.test.ts
import { resolveMoveInWindow, applyDeadlineOf, resolveApplyDeadlineNote, URGE_WITHIN_DAYS } from "../move-in-deadline";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const NOW = "2026-09-18T21:40:00+09:00";
const latest = (s: string, now = NOW) => {
  const w = resolveMoveInWindow(s, now);
  return w ? `${w.latest.y}/${w.latest.m}/${w.latest.d}` : "null";
};

console.log("── ゆーた 事例（そのまま送ってしまった文の元）");
{
  t("「10月中」は 10/31（旧: 10/1）", latest("10月中") === "2026/10/31", latest("10月中"));
  const a = applyDeadlineOf(resolveMoveInWindow("10月中", NOW)!, NOW)!;
  t("申込の目安は 10月17日", a.applyByLabel === "10月17日", a.applyByLabel);
  t("9/18 から申込まで29日ある", a.daysUntilApply === 29, String(a.daysUntilApply));
  t("★ 急かす文は出さない（29日 > 21日）", resolveApplyDeadlineNote("10月中", NOW) === null);
}

console.log("── 実データの書き方（property_customers.move_in_time の多い順）");
{
  const cases: Array<[string, string]> = [
    ["10月", "2026/10/31"],          // 素の月＝最多の書き方。旧は 10/1
    ["9月", "2026/9/30"],            // 今月。旧は 9/1（もう過ぎている）
    ["10月頃", "2026/10/31"],
    ["10月中までに", "2026/10/31"],
    ["9月末", "2026/9/30"],          // 旧は 9/28（9月は30日まで）
    ["10月末頃", "2026/10/31"],      // 旧は 10/28
    ["10月上旬", "2026/10/10"],
    ["10月頭", "2026/10/10"],
    ["10月中旬", "2026/10/20"],
    ["10月下旬", "2026/10/31"],
    ["10月後半から11月", "2026/11/30"],   // 幅は「遅い方」が期限。旧は 10/1
    ["10月~12月", "2026/12/31"],
    ["10〜11月", "2026/11/30"],
    ["10月29日〜11月1日", "2026/11/1"],   // 日付の幅も遅い方
    ["10月1日", "2026/10/1"],
    ["今年中", "2026/12/31"],
    ["1月", "2027/1/31"],                 // 年をまたぐ
  ];
  for (const [s, want] of cases) t(`「${s}」→ ${want}`, latest(s) === want, latest(s));
}

console.log("── 期日として読めない言い方は急かさない（安全側）");
{
  for (const s of ["いつでも", "未定", "不明", "特に無し", "物件見つかり次第", "いい物件があり次第", "最短", "すぐにでも", "出来るだけ早く", "", "1、2ヶ月以内"]) {
    t(`「${s}」→ 期限を作らない`, resolveMoveInWindow(s, NOW) === null, latest(s));
  }
  t("null / undefined でも落ちない",
    resolveMoveInWindow(null, NOW) === null && resolveMoveInWindow(undefined, NOW) === null);
}

console.log("── 急かすのは本当に近い時だけ");
{
  // 実データ: スタッフが実際に「今週中にお申込み」と書いた例（7/1 時点・8/1 入居希望）
  const real = resolveApplyDeadlineNote("8月1日", "2026-07-01T12:00:00+09:00");
  t("7/1 に「8月1日入居」→ 出す（申込まで17日）", !!real && real.daysUntilApply === 17, JSON.stringify(real?.daysUntilApply));
  t("その時の目安日は 7月18日", real?.applyByLabel === "7月18日", real?.applyByLabel ?? "null");

  t("9/18 に「10月10日入居」→ 出す（申込まで8日）",
    resolveApplyDeadlineNote("10月10日", NOW)?.applyByLabel === "9月26日",
    resolveApplyDeadlineNote("10月10日", NOW)?.applyByLabel ?? "null");
  // 9/18 に「9月末」は申込の目安日（9/16）を既に過ぎている → 出さない（過ぎた期限を突きつけない）
  t("9/18 に「9月末入居」→ 出さない（目安日を過ぎている）", resolveApplyDeadlineNote("9月末", NOW) === null);
  t("9/18 に「11月」→ 出さない（まだ先）", resolveApplyDeadlineNote("11月", NOW) === null);
  t("9/18 に「今年中」→ 出さない", resolveApplyDeadlineNote("今年中", NOW) === null);
  t("目安日を過ぎていたら出さない（間に合わせ方は人が決める）",
    resolveApplyDeadlineNote("9月20日", NOW) === null, JSON.stringify(applyDeadlineOf(resolveMoveInWindow("9月20日", NOW)!, NOW)?.daysUntilApply));
  t("しきい値は3週間", URGE_WITHIN_DAYS === 21);
}

console.log("── 月末の日数を間違えない");
{
  t("2月末（2026年）は 28日", latest("2月末", "2026-01-10T10:00:00+09:00") === "2026/2/28");
  t("4月末は 30日", latest("4月末", "2026-03-10T10:00:00+09:00") === "2026/4/30");
  t("12月末は 31日", latest("12月末", "2026-11-10T10:00:00+09:00") === "2026/12/31");
  t("全角数字も読める", latest("１０月中") === "2026/10/31");
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
