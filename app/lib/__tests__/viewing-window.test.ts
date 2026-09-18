// app/lib/__tests__/viewing-window.test.ts
// 2026-09-19 竹内（a🤫 事例）「退去予定日入れると、その退去予定日以降で内覧する形となるので、
//   内覧可能日時は退去予定日以降のところから、順に空いている日付いれる形とする」
// 実行: npx tsx app/lib/__tests__/viewing-window.test.ts（全 PASS で exit 0）
import { viewableFromYmd, vacancyExtraYmds, isBeforeViewable, resolveVacancySlotEnabled, stripSlotLinesBeforeViewable } from "../viewing-window";
import { viewableFromVacancyDate } from "../vacating-notice";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const NOW = Date.parse("2026-09-19T12:00:00+09:00");

console.log("── 内覧できる最初の日＝退去日の翌日");
{
  t("★ a🤫 9月27日退去 → 9月28日から", viewableFromYmd("9月27日", NOW) === "2026-09-28", String(viewableFromYmd("9月27日", NOW)));
  t("月をまたぐ（9月30日 → 10月1日）", viewableFromYmd("9月30日", NOW) === "2026-10-01", String(viewableFromYmd("9月30日", NOW)));
  t("「9月末」も読む → 10月1日", viewableFromYmd("9月末", NOW) === "2026-10-01", String(viewableFromYmd("9月末", NOW)));
  t("「9月下旬」→ 10月1日", viewableFromYmd("9月下旬", NOW) === "2026-10-01");
  t("年をまたぐ（12月31日 → 1月1日）", viewableFromYmd("12月31日", NOW) === "2027-01-01", String(viewableFromYmd("12月31日", NOW)));
  t("読めない物は null", viewableFromYmd("未定", NOW) === null && viewableFromYmd("", NOW) === null);
  t("★ 表記（生成文）と日付（画面）が同じ日を指す",
    viewableFromVacancyDate("9月27日", NOW) === "9月28日" && viewableFromYmd("9月27日", NOW) === "2026-09-28");
}

console.log("── カレンダーに取りに行く日（解禁日から連続）");
{
  const ex = vacancyExtraYmds("9月27日", NOW, 4);
  t("解禁日から4日", eq(ex, ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"]), JSON.stringify(ex));
  t("読めない日付なら空（いつもどおり直近3日で足りる）", eq(vacancyExtraYmds("未定", NOW), []));
  t("空欄なら空", eq(vacancyExtraYmds("", NOW), []));
}

console.log("── 退去前の日は選べない");
{
  t("9/19 は 9/28 より前", isBeforeViewable("2026-09-19", "2026-09-28"));
  t("9/28 当日は内覧できる", !isBeforeViewable("2026-09-28", "2026-09-28"));
  t("退去予定でなければ常に false（いつもどおり）", !isBeforeViewable("2026-09-19", null));
}

console.log("── 初期チェック: 解禁日から順に、空いている日を3日");
{
  // a🤫 の画面そのまま: 本日 9/18 と 明日 9/19 は予定あり。退去は 9/27
  const days = [
    { ymd: "2026-09-19", fullyBooked: true },   // 本日（予定あり）
    { ymd: "2026-09-20", fullyBooked: false },  // 明日（空き・でも退去前）
    { ymd: "2026-09-21", fullyBooked: false },  // 明後日（空き・でも退去前）
    { ymd: "2026-09-28", fullyBooked: false },  // 解禁日
    { ymd: "2026-09-29", fullyBooked: true },   // 予定あり → 飛ばす
    { ymd: "2026-09-30", fullyBooked: false },
    { ymd: "2026-10-01", fullyBooked: false },
    { ymd: "2026-10-02", fullyBooked: false },  // 4日目 → 入れない
  ];
  const got = resolveVacancySlotEnabled(days, "2026-09-28", 3);
  t("★ 退去前の日（9/20・9/21 は空いていても）は ON にしない", eq(got?.slice(0, 3), [false, false, false]), JSON.stringify(got));
  t("★ 解禁日から順に、埋まった日を飛ばして3日", eq(got?.slice(3), [true, false, true, true, false]), JSON.stringify(got));
  t("退去予定でなければ null（従来の初期値＝直近3日を使う）", resolveVacancySlotEnabled(days, null, 3) === null);
}

console.log("── 【実データ】a🤫 9/18 21:40 のスタッフ実送信と同じ3日が選ばれる");
{
  // 実送信: 「9月27日退去予定のお部屋で9月28日以降でお部屋ご案内可能です！！／直近ですと
  //   9/28(月) 12:00〜14:00／9/29(火) 15:00〜17:00／9/30(水) 15:00〜17:00／ご案内出来ます😊！！」
  // 画面は当時「本日 9/18・明日 9/19・明後日 9/20」しか出しておらず、竹内さんが手で 9/28〜9/30 を作っていた
  const from = viewableFromYmd("9月27日", Date.parse("2026-09-18T21:40:00+09:00"));
  t("解禁日は 9/28", from === "2026-09-28", String(from));
  const days = [
    { ymd: "2026-09-18", fullyBooked: true },
    { ymd: "2026-09-19", fullyBooked: true },
    { ymd: "2026-09-20", fullyBooked: false },
    { ymd: "2026-09-28", fullyBooked: false },
    { ymd: "2026-09-29", fullyBooked: false },
    { ymd: "2026-09-30", fullyBooked: false },
    { ymd: "2026-10-01", fullyBooked: false },
  ];
  const got = resolveVacancySlotEnabled(days, from, 3);
  t("★ 実送信と同じ 9/28・9/29・9/30 の3日だけが ON",
    eq(got, [false, false, false, true, true, true, false]), JSON.stringify(got));
}

console.log("── 解禁日以降が全部埋まっている時は1つも ON にしない（勝手に退去前を出さない）");
{
  const days = [
    { ymd: "2026-09-19", fullyBooked: false },
    { ymd: "2026-09-28", fullyBooked: true },
    { ymd: "2026-09-29", fullyBooked: true },
  ];
  t("全部 false", eq(resolveVacancySlotEnabled(days, "2026-09-28", 3), [false, false, false]));
}

console.log("── 出口: 生成文に紛れた「退去前の候補の行」を落とす（2026-09-19 会話を合わせる）");
{
  const draft = "かしこまりました！！\nジュネスニッコー1003号室\n9月27日退去予定のお部屋で9月28日以降でお部屋ご案内可能です！！\n\n直近ですと\n9/20(日) 13:00〜16:00\n9/28(月) 12:00〜14:00\n9/29(火) 15:00〜17:00\nご案内出来ます😊！！";
  const r = stripSlotLinesBeforeViewable(draft, "2026-09-28");
  t("★ 9/20 の行だけ消える", r.removed.length === 1 && r.removed[0].startsWith("9/20"), JSON.stringify(r.removed));
  t("★ 解禁日以降の候補は残る", r.text.includes("9/28(月) 12:00〜14:00") && r.text.includes("9/29(火) 15:00〜17:00"));
  t("★ 本文の日付（9月27日退去予定・9月28日以降）は触らない",
    r.text.includes("9月27日退去予定のお部屋で9月28日以降でお部屋ご案内可能です！！"), r.text);
  t("締めも残る", r.text.includes("ご案内出来ます😊！！"));
}
{
  // 実データの表記ゆれ（6/28 yasuki「7/1日 11:00〜16:00」）
  const draft = "6/30日退去予定のため7/1日以降でお部屋ご案内させていただきます！！\n\n直近ですと、\n6/29日 11:00〜16:00\n7/1日 11:00〜16:00\n7/2日 11:00〜12:00\nでしたらお部屋ご案内可能です！！";
  const r = stripSlotLinesBeforeViewable(draft, "2026-07-01");
  t("「6/29日 11:00〜16:00」の形も落ちる", r.removed.length === 1 && r.removed[0].startsWith("6/29"), JSON.stringify(r.removed));
  t("7/1・7/2 は残る", r.text.includes("7/1日 11:00〜16:00") && r.text.includes("7/2日 11:00〜12:00"));
}
{
  // 「7月1日（水）14:00〜17:00」（6/19 の形）
  const draft = "はい！！\n6月30日退去予定のお部屋となりますので、7月1日以降にご内覧頂く形となります😊！！\n\n7月1日（水）14:00〜17:00\n7月2日（木）12:00〜15:00\nご案内出来ます！！";
  const r = stripSlotLinesBeforeViewable(draft, "2026-07-01");
  t("正しい候補は1行も落とさない（誤削除0）", r.removed.length === 0 && r.text === draft, JSON.stringify(r.removed));
}
{
  t("解禁日が無ければ何もしない", stripSlotLinesBeforeViewable("9/20(日) 13:00〜16:00", null).removed.length === 0);
  t("空文字でも落ちない", stripSlotLinesBeforeViewable("", "2026-09-28").text === "");
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
