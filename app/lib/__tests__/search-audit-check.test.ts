// app/lib/__tests__/search-audit-check.test.ts
// 検索の点検（決定論）の回帰テスト。実行: npx tsx app/lib/__tests__/search-audit-check.test.ts（全 PASS で exit 0）
// 2026-09-25 竹内「ブレインモードで物件自動検索や一括検索した際に、検索がちゃんとされていなかったら原因を見つけられるようにする。
//   0件だった場合ちゃんと検索されていない可能性があるし、お客さんの条件とずれた検索をしていた可能性がある」
//
// 材料は実物: お客様の条件は本番の property_customers の条件の欄（2026-09-25 に読んだ直近25件から・名前と電話は取っていない）、
//   押せなかった駅の形は itandi-page-script.js の実際のログ（「[AX] 駅未発見: 東三国 | route=JR京都線 | label数=…」）、
//   フォームの name は page-script.js が実際に値を入れている物（rental_cost2・update_date・room_layout_id[]…）。
import {
  runSearchAuditChecks, needsDiagnosis, auditHeadline, causeTitle, versionGte, classifyError, parseMan, planTokens, normStation, keyPart, pickAuditForRound,
  type AuditInput,
} from "../search-audit-check";
import { intendedFilledDiff, buildDiagnoseUserText, parseDiagnosis, SEARCH_AUDIT_SYSTEM_PROMPT } from "../search-audit-diagnose";
// search-audit-server は DB の口（supabase）を import 時に作るので、仮の宛先を入れてから後で読む（外には出ない）
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://127.0.0.1:9";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "test";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const codes = (a: AuditInput) => runSearchAuditChecks(a, NOW).checks.map((c) => c.code);
const NOW = Date.parse("2026-09-25T19:00:00+09:00");

// ── 実物のお客様の条件（本番・名前なし）──
const C_HIGASHIMIKUNI = { desired_area: "東三国・新大阪", area_mode: "station", rent_max: 80000, walk_minutes: 10, building_age: 20, last_property_sent_at: null, property_viewed_at: null };
const C_WARDS = { desired_area: "中央区　西区　浪速区", area_mode: "ward", floor_plan: "1LDK　2DK 2LDK", rent_max: 200000, walk_minutes: 10, last_property_sent_at: "2026-09-25T09:15:51.813+00:00" };
const C_DAIKOKU = { desired_area: "大国町・日本橋・谷九・なんば・長堀橋・心斎橋", area_mode: "station", floor_plan: "1LDK", rent_max: 110000, walk_minutes: 15, last_property_sent_at: "2026-09-25T09:10:28.811+00:00" };
const C_FLOORS = { desired_area: "大阪市西区　大阪市浪速区・4階のお部屋・11階のお部屋・西中島南方", area_mode: "station", floor_plan: "1K 1R", rent_max: 70000, building_age: 10, last_property_sent_at: "2026-09-24T08:26:33.715+00:00" };
const C_UPD = { desired_area: "大国町", area_mode: "station", rent_max: 80000, rent_min: 60000, walk_minutes: 7, building_age: 7, last_property_sent_at: "2026-09-25T09:00:25.06+00:00", property_viewed_at: "2026-09-18T04:33:27.349+00:00" };

console.log("── ① itandi・東三国が JR京都線の一覧に無く押せない → 0件（実際のログの形）");
{
  const a: AuditInput = {
    site: "itandi", trigger: "web_brain", customer_snapshot: C_HIGASHIMIKUNI, created_at: "2026-09-25T10:00:00Z",
    intended: { area_mode: "station", rent_max: 80000, walk_minutes: 10, building_age: 20, itandi_lines: ["JR京都線", "高速電気軌道第1号線(大阪メトロ御堂筋線)"], station_names: ["東三国", "新大阪"] },
    filled: { v: 1, search_clicked: true, area_path: "station", stations_ok: ["新大阪"],
      stations_missing: [{ name: "東三国", line: "JR京都線", label_count: 23, sample: ["大阪", "新大阪", "東淀川", "吹田", "岸辺", "千里丘"] }],
      form: { rent_max: "8", walk: "10", age: "20", layouts: [] } },
    result: { pages: 0, read_rows: 0, sent_count: 0, zero_reason: "no_rows_15s", count_text: null, count_number: null },
  };
  const v = runSearchAuditChecks(a, NOW);
  t("重さ bad", v.severity === "bad");
  t("原因の鍵 station_missing:itandi:JR京都線:東三国", v.cause_key === "station_missing:itandi:JR京都線:東三国", String(v.cause_key));
  t("0件は確かめていない（ZERO_UNCONFIRMED）も付く", v.checks.some((c) => c.code === "ZERO_UNCONFIRMED" && c.cause_key === "zero_unconfirmed:itandi:no_rows_15s"));
  t("見立てを頼む", needsDiagnosis(v));
  t("0件だった", v.zero);
  t("見出し「駅 1/2・東三国が入っていない」", auditHeadline({ severity: v.severity, intended: a.intended, checks: v.checks }) === "この回の検索: 駅 1/2・東三国が入っていない", String(auditHeadline({ severity: v.severity, intended: a.intended, checks: v.checks })));
  t("数える原因は2つ（駅・0件）", v.cause_keys.length === 2, v.cause_keys.join(","));
  t("賃料 8（万）は 80000 と同じ＝札なし", !v.checks.some((c) => c.code === "RENT_MISMATCH"));
  const diff = intendedFilledDiff(a.intended, a.filled);
  t("差分に押せなかった駅と路線", diff.some((l) => l.includes("押せなかった駅: 東三国（JR京都線）")));
  t("賃料は両方を万円に直して並べる（itandi の 8 を誤入力と読ませない）", diff.includes("賃料上限: 入れようとした=8万円 ／ 入った=8万円"), diff.join(" | "));
  const user = buildDiagnoseUserText({ site: "itandi", trigger: "web_brain", checks: v.checks, intended: a.intended, filled: a.filled, result: a.result, customer_area: C_HIGASHIMIKUNI.desired_area });
  t("見立ての材料に札と件数", /STATION_MISSING/.test(user) && /読んだ行=0/.test(user) && /0件と決めた理由=no_rows_15s/.test(user));
  t("見立ての材料は前置きの後ろ（前置きに回ごとの値が無い＝キャッシュが当たる）", !SEARCH_AUDIT_SYSTEM_PROMPT.includes("東三国"));
  // 2026-09-25 本番の通し確認（v2）: 読み戻しに欄が無い＝読めなかった → 「入った=なし」と書かない（DeepSeek が「徒歩が入っていない」と読んだ）
  const diff2 = intendedFilledDiff({ walk_minutes: 10, rent_max: 7, building_age: 20 }, { form: { rent_max: "7", age: "" } });
  t("読み戻しに欄が無い徒歩は「（読み戻しなし）」", diff2.includes("徒歩: 入れようとした=10 ／ 入った=（読み戻しなし）"), diff2.join(" | "));
  t("読み戻しに欄があって空の築年数は「読み戻しなし」にしない（空のまま）", diff2.includes("築年数: 入れようとした=20 ／ 入った=") && !diff2.some((l) => l.startsWith("築年数") && l.includes("読み戻しなし")), diff2.join(" | "));
  const user2 = buildDiagnoseUserText({ site: "realnetpro", checks: [], intended: { rent_max: 2 }, filled: { form: { rent_max: "2" } }, customer_rent_max_man: 2 });
  t("お客様の賃料の上限を材料に（万円）", user2.includes("お客様の賃料上限=2万円"), user2.split("\n")[1]);
  t("前置き: 件数表示0で条件どおりなら「条件が厳しい」を先に疑う", SEARCH_AUDIT_SYSTEM_PROMPT.includes("ZERO_CONFIRMED（件数表示も0）で、入れた条件がお客様の条件どおり"));
}

console.log("── ② リアプロ・地域で探すお客様・間取り 2LDK が入らなかった（実物の条件「1LDK　2DK 2LDK」）");
{
  const a: AuditInput = {
    site: "realnetpro", customer_snapshot: C_WARDS, created_at: "2026-09-25T10:00:00Z",
    intended: { area_mode: "ward", rent_max: 200000, walk_minutes: 10, floor_plan: "1LDK　2DK 2LDK", city_codes: [27128, 27106, 27111], rp_update_days: 1 },
    filled: { search_clicked: true, area_path: "area", form: { rent_max: "200000", update_days: "1", walk: "10", layouts: ["1LDK", "2DK"], stations: [], wards: ["大阪市中央区", "大阪市西区", "大阪市浪速区"] } },
    result: { pages: 1, read_rows: 30, sendable_rows: 8, sent_count: 8 },
  };
  const v = runSearchAuditChecks(a, NOW);
  t("重さ warn", v.severity === "warn", v.severity);
  t("原因の鍵 floor_plan_dropped:realpro:2LDK", v.cause_key === "floor_plan_dropped:realpro:2LDK", String(v.cause_key));
  t("地域で探すお客様なので駅は比べない", !v.checks.some((c) => c.code === "STATION_MISSING"));
  t("0件でない warn は見立てを頼まない", !needsDiagnosis(v));
  const v2 = runSearchAuditChecks({ ...a, filled: { ...a.filled, form: { ...a.filled!.form, layouts: [] } } }, NOW);
  t("間取りが1つも入っていない → bad", v2.checks.some((c) => c.code === "FLOOR_PLAN_DROPPED" && c.severity === "bad"));
  const v3 = runSearchAuditChecks({ ...a, filled: { ...a.filled, form: { ...a.filled!.form, layouts: ["12", "15"] } } }, NOW);
  t("読み戻しが間取りの形でない（値の番号）時は比べない", !v3.checks.some((c) => c.code === "FLOOR_PLAN_DROPPED"));
}

console.log("── ③ 駅の読み戻し（谷町九丁目が入っていない）・表記ゆれは同じ扱い");
{
  const a: AuditInput = {
    site: "realpro", customer_snapshot: C_DAIKOKU, created_at: "2026-09-25T10:00:00Z",
    intended: { area_mode: "station", rent_max: 110000, walk_minutes: 15, floor_plan: "1LDK", station_names: ["大国町", "日本橋駅", "谷町九丁目", "なんば"], rp_update_days: 1 },
    filled: { search_clicked: true, area_path: "station", stations_ok: ["大国町", "日本橋", "なんば"],
      form: { rent_max: "110000", update_days: "1", walk: "15", layouts: ["1LDK"], stations: ["大国町", "日本橋", "なんば(南海)"] } },
    result: { pages: 2, read_rows: 60, sendable_rows: 20, sent_count: 20 },
  };
  const v = runSearchAuditChecks(a, NOW);
  t("谷町九丁目だけ STATION_MISSING", v.checks.filter((c) => c.code === "STATION_MISSING").map((c) => c.cause_key).join() === "station_missing:realpro:-:谷町九丁目", v.checks.map((c) => c.cause_key).join());
  t("見出し 駅 3/4", (auditHeadline({ severity: v.severity, intended: a.intended, checks: v.checks }) ?? "").startsWith("この回の検索: 駅 3/4"));
  t("「日本橋駅」と「日本橋」は同じ", normStation("日本橋駅") === "日本橋");
  t("「なんば(南海)」と「なんば」は同じ", normStation("なんば(南海)") === "なんば");
  const noForm = runSearchAuditChecks({ ...a, filled: { search_clicked: true, stations_ok: [] } }, NOW);
  t("読み戻しが無い（古い版）時は駅を比べない", !noForm.checks.some((c) => c.code === "STATION_MISSING"));
  const emptyForm = runSearchAuditChecks({ ...a, filled: { search_clicked: true, form: { stations: [] } } }, NOW);
  t("読み戻しが空（モーダルを閉じた後で読めない）時も比べない", !emptyForm.checks.some((c) => c.code === "STATION_MISSING"));
}

console.log("── ④ 更新日（リアプロ・任務 A の effectiveRpUpdateDays）");
{
  const base: AuditInput = {
    site: "realpro", customer_snapshot: C_UPD, created_at: "2026-09-25T10:00:00Z",
    intended: { area_mode: "station", rent_max: 80000, rent_min: 60000, walk_minutes: 7, building_age: 7, station_names: ["大国町"], rp_update_days: 1 },
    filled: { search_clicked: true, stations_ok: ["大国町"], form: { rent_max: "80000", rent_min: "60000", update_days: "1", layouts: [], stations: ["大国町"] } },
    result: { read_rows: 12, sendable_rows: 4, sent_count: 4 },
  };
  t("入れようとした 1・入った 1・決まり 1 → 札なし", !codes(base).includes("UPDATE_DAYS"), codes(base).join());
  const notFilled = runSearchAuditChecks({ ...base, filled: { ...base.filled, form: { ...base.filled!.form, update_days: "" } } }, NOW);
  t("入らなかった → bad update_days:realpro:not_filled", notFilled.checks.some((c) => c.cause_key === "update_days:realpro:not_filled" && c.severity === "bad"));
  const leftover = runSearchAuditChecks({ ...base, intended: { ...base.intended, rp_update_days: null }, filled: { ...base.filled, form: { ...base.filled!.form, update_days: "7" } } }, NOW);
  t("前の 7 が残った → bad leftover", leftover.checks.some((c) => c.cause_key === "update_days:realpro:leftover"));
  t("決まり（1）と違う（指定なし）→ warn differs", leftover.checks.some((c) => c.cause_key === "update_days:realpro:differs" && c.severity === "warn"));
  const itandi = runSearchAuditChecks({ ...base, site: "itandi", filled: { ...base.filled, form: { update_days: "" } } }, NOW);
  t("itandi は更新日を比べない", !itandi.checks.some((c) => c.code === "UPDATE_DAYS"));
  const noSel = runSearchAuditChecks({ ...base, filled: { ...base.filled, form: { rent_max: "80000" } } }, NOW);
  t("更新日の欄が読めない（select が無い）時は比べない", !noSel.checks.some((c) => c.code === "UPDATE_DAYS" && c.severity === "bad"));
}

console.log("── ⑤ 賃料の上限");
{
  const mk = (filled: string | null): AuditInput => ({ site: "realpro", intended: { rent_max: 80000 }, filled: { search_clicked: true, form: { rent_max: filled } }, result: { read_rows: 5 } });
  t("80000 → 札なし", !codes(mk("80000")).includes("RENT_MISMATCH"));
  t("85000（選べる値の切り上げ）→ 札なし", !codes(mk("85000")).includes("RENT_MISMATCH"));
  t("75000 → bad lower", runSearchAuditChecks(mk("75000"), NOW).checks.some((c) => c.cause_key === "rent_mismatch:realpro:lower" && c.severity === "bad"));
  t("-1（指定なし）→ bad not_filled", runSearchAuditChecks(mk("-1"), NOW).checks.some((c) => c.cause_key === "rent_mismatch:realpro:not_filled"));
  t("150000 → warn higher", runSearchAuditChecks(mk("150000"), NOW).checks.some((c) => c.cause_key === "rent_mismatch:realpro:higher" && c.severity === "warn"));
  t("parseMan: 8万円 / 80000 / 8 / 8.5", [parseMan("8万円"), parseMan("80000"), parseMan(8), parseMan("8.5")].join() === "8,8,8,8.5");
}

console.log("── ⑥ 0件の分け方");
{
  const confirmed = runSearchAuditChecks({ site: "realpro", result: { read_rows: 0, count_text: "該当する物件はありません", count_number: 0, zero_reason: "no_rows_25s" } }, NOW);
  t("件数表示も0 → ZERO_CONFIRMED（warn）", confirmed.severity === "warn" && confirmed.cause_key === "zero_confirmed:realpro");
  t("warn の0件は見立てを頼む", needsDiagnosis(confirmed));
  const unconfirmed = runSearchAuditChecks({ site: "realpro", result: { read_rows: 0, count_text: null, count_number: null, zero_reason: "no_rows_25s" } }, NOW);
  t("件数表示が読めない0件 → ZERO_UNCONFIRMED（bad）", unconfirmed.severity === "bad" && unconfirmed.cause_key === "zero_unconfirmed:realpro:no_rows_25s");
  const timeout = runSearchAuditChecks({ site: "itandi", result: { batch_timed_out: true, read_rows: null } }, NOW);
  t("5分の待ち切れは0件ではなく ERROR_BATCH_TIMEOUT", timeout.cause_key === "error:itandi:batch_timeout" && !timeout.zero && !timeout.checks.some((c) => c.code.startsWith("ZERO")));
  const brainDrop = runSearchAuditChecks({ site: "realpro", result: { read_rows: 30, sendable_rows: 0, sent_count: 0 } }, NOW);
  t("読めたがブレインが全部外した（送れる0）は0件ではない", !brainDrop.zero && brainDrop.severity === "ok");
  const sent = runSearchAuditChecks({ site: "realpro", result: { read_rows: 30, sendable_rows: 10, sent_count: 5 } }, NOW);
  t("送れる10・送った5 → SENT_LT_READ（warn）", sent.cause_key === "sent_lt_read:realpro");
}

console.log("── ⑦ 失敗・止まった・スタッフが止めた");
{
  t("fill-done が届かない → fill_timeout", classifyError("リアプロ 検索完了シグナル（fill-done）が90秒以内に届きませんでした。") === "fill_timeout");
  t("watchdog", classifyError("watchdog-timeout: 85秒以内に条件入力が完了しませんでした（全件検索防止のため中止）") === "watchdog");
  t("場所が作れない", classifyError("エリア条件を解決できませんでした（条件なし全件検索を防ぐため中止）。desired_area=\"x\"") === "no_area");
  t("路線・駅の絞り込みボタン → ui", classifyError("路線・駅で絞り込みボタンが見つかりませんでした") === "ui");
  // 2026-09-25 本番の通し確認: 未ログインの文が ui（画面の部品）・exception に落ちていた（background.js の実際の文）
  t("未ログイン（セッションが見つかりません）→ not_logged_in", classifyError("リアプロのセッションが見つかりません。リアプロにログインしてください。") === "not_logged_in");
  t("未ログイン（リダイレクト）→ not_logged_in", classifyError("リアプロが未ログインです（main.php 以外へリダイレクト）。実行PCのChromeでリアプロにログインしてから再実行してください (現URL: https://example.invalid/)") === "not_logged_in");
  t("「ログインしているか確認」はヒントなので not_logged_in にしない", classifyError("詳細ページ（room_detail.php）が開きませんでした。リアプロにログインしているか確認してください。") === "exception");
  {
    const v = runSearchAuditChecks({ site: "realnetpro", status: "finished", error: "リアプロのセッションが見つかりません。リアプロにログインしてください。" });
    t("未ログインの札 = error:realpro:not_logged_in（bad・画面の部品の札ではない）", v.cause_key === "error:realpro:not_logged_in" && v.severity === "bad" && !v.checks.some((c) => c.code === "UI_NOT_FOUND"), JSON.stringify(v.checks));
    t("未ログインの見出し", v.checks[0]?.title === "サイトにログインしていなかった" && causeTitle("error:realpro:not_logged_in") === "リアプロ: ログインしていない");
  }
  const stopped = runSearchAuditChecks({ site: "realpro", error: "__BATCH_STOPPED__" }, NOW);
  t("スタッフが止めた回は札なし", stopped.severity === "ok" && stopped.checks.length === 0);
  const wd = runSearchAuditChecks({ site: "realpro", error: "watchdog-timeout: 85秒" }, NOW);
  t("watchdog → bad error:realpro:watchdog", wd.cause_key === "error:realpro:watchdog" && wd.severity === "bad");
  const ui = runSearchAuditChecks({ site: "itandi", error: "路線・駅で絞り込みボタンが見つかりませんでした" }, NOW);
  t("ui の失敗は UI_NOT_FOUND", ui.checks[0].code === "UI_NOT_FOUND");
  const stall = runSearchAuditChecks({ site: "realpro", status: "abandoned", steps: [{ k: "begin" }, { k: "fill_done" }] }, NOW);
  t("20分終わらない → STALLED・最後の段で分ける", stall.cause_key === "stalled:realpro:fill_done" && stall.severity === "bad");
  const noSearch = runSearchAuditChecks({ site: "realpro", filled: { search_clicked: false, click_fails: [{ what: "search", text: "検索", sample: ["住居検索"] }] } }, NOW);
  t("検索ボタンが押せない → ui_not_found:realpro:search:検索", noSearch.cause_key === "ui_not_found:realpro:search:検索");
}

console.log("── ⑧ 場所（実物の「4階のお部屋」が地名に紛れた条件）");
{
  const a: AuditInput = {
    site: "realpro", customer_snapshot: C_FLOORS,
    intended: { area_mode: "station", rent_max: 70000, building_age: 10, floor_plan: "1K 1R", station_names: ["西中島南方"], unknown_tokens: ["4階のお部屋", "11階のお部屋"] },
    filled: { search_clicked: true, area_path: "station", stations_ok: ["西中島南方"], form: { rent_max: "70000", layouts: ["1K", "ワンルーム"] } },
    result: { read_rows: 20, sendable_rows: 6, sent_count: 6 },
  };
  const v = runSearchAuditChecks(a, NOW);
  t("直せなかった言葉 → AREA_UNRESOLVED（warn）2つ", v.checks.filter((c) => c.code === "AREA_UNRESOLVED").length === 2 && v.severity === "warn");
  t("「ワンルーム」は 1R と同じ（間取りの札なし）", !v.checks.some((c) => c.code === "FLOOR_PLAN_DROPPED"));
  const none = runSearchAuditChecks({ ...a, intended: { area_mode: "station", rent_max: 70000 } }, NOW);
  t("場所が1つも入っていない → bad area_unresolved:realpro:all", none.checks.some((c) => c.cause_key === "area_unresolved:realpro:all" && c.severity === "bad"));
  const modeMismatch = runSearchAuditChecks({ ...a, intended: { ...a.intended, area_mode: "ward", city_codes: [27106] } }, NOW);
  t("駅で探すお客様を地域で → LOCATION_MODE warn", modeMismatch.checks.some((c) => c.cause_key === "location_mode:realpro:station→ward"));
  const pathNone = runSearchAuditChecks({ ...a, filled: { ...a.filled, area_path: "none" } }, NOW);
  t("場所なしで検索 → bad", pathNone.checks.some((c) => c.cause_key === "location_mode:realpro:none" && c.severity === "bad"));
  const fb = runSearchAuditChecks({ ...a, filled: { ...a.filled, fallback: "所在地モーダル失敗 → 市区コードで代替" } }, NOW);
  t("条件を外した検索 → bad fallback", fb.checks.some((c) => c.cause_key === "location_mode:realpro:fallback"));
}

console.log("── ⑨ お客様の条件の読み落とし");
{
  const v = runSearchAuditChecks({ site: "itandi", customer_snapshot: C_HIGASHIMIKUNI, intended: { area_mode: "station", rent_max: 80000, station_names: ["東三国"] }, result: { read_rows: 5 } }, NOW);
  t("徒歩・築年数が入っていない → warn 2つ", v.checks.filter((c) => c.code === "CONDITION_MISREAD").map((c) => c.cause_key).sort().join() === "condition_misread:itandi:age,condition_misread:itandi:walk");
  const lower = runSearchAuditChecks({ site: "itandi", customer_snapshot: C_HIGASHIMIKUNI, intended: { rent_max: 60000, walk_minutes: 10, building_age: 20, station_names: ["東三国"] }, result: { read_rows: 5 } }, NOW);
  t("賃料をお客様より低く → rent_lower", lower.checks.some((c) => c.cause_key === "condition_misread:itandi:rent_lower"));
}

console.log("── ⑩ 問題なしの回・古い版の拡張（読み戻しなし）");
{
  const clean = runSearchAuditChecks({
    site: "realpro", customer_snapshot: C_UPD, created_at: "2026-09-25T10:00:00Z",
    intended: { area_mode: "station", rent_max: 80000, rent_min: 60000, walk_minutes: 7, building_age: 7, station_names: ["大国町"], rp_update_days: 1 },
    filled: { search_clicked: true, area_path: "station", stations_ok: ["大国町"], form: { rent_max: "80000", update_days: "1", stations: ["大国町"], layouts: [] } },
    result: { pages: 1, read_rows: 12, sendable_rows: 4, sent_count: 4 },
  }, NOW);
  t("ok・原因なし・見立てなし", clean.severity === "ok" && clean.cause_key === null && !needsDiagnosis(clean), clean.checks.map((c) => c.cause_key).join());
  const old = runSearchAuditChecks({ site: "realpro", intended: { rent_max: 80000, station_names: ["大国町"] }, filled: null, result: { read_rows: 10, sendable_rows: 3, sent_count: 3 } }, NOW);
  t("読み戻しが無い回は札を付けない", old.severity === "ok");
}

(async () => {
const { countCauses, rowFromBody, validRunId, parseWeekly } = await import("../search-audit-server");
console.log("── ⑪ 小さな決まり");
{
  t("planTokens: 「2LDK〜3LDK」", planTokens("2LDK〜3LDK").join() === "2LDK,3LDK");
  t("planTokens: 全角「１ＬＤＫ」", planTokens("１ＬＤＫ").join() === "1LDK");
  t("planTokens: 「ワンルーム・1K」", planTokens("ワンルーム・1K").join() === "1R,1K");
  t("keyPart は : を外す", keyPart("a:b c") === "abc");
  t("causeTitle", causeTitle("station_missing:itandi:JR京都線:東三国") === "itandi: 駅「東三国」が入らない（JR京都線）");
  t("versionGte 2.5.25 >= 2.5.25", versionGte("2.5.25", "2.5.25") && versionGte("2.5.30", "2.5.25") && !versionGte("2.5.9", "2.5.25"));
  t("validRunId", validRunId("sa_mfz1_ab12cd34") && !validRunId("x") && !validRunId("a b c d e f") && !validRunId(null));
  const row = rowFromBody({ site: "realnetpro", mode: "brain_normal", trigger: "web_brain", customer_snapshot: { customer_name: "x", phone: "0", desired_area: "大国町" }, bogus: 1 });
  t("rowFromBody: 名前・電話を落とす・知らない欄を捨てる", row.site === "realpro" && !("customer_name" in (row.customer_snapshot ?? {})) && !("phone" in (row.customer_snapshot ?? {})) && !("bogus" in row));
  t("rowFromBody: 知らない mode・trigger は入れない", !("mode" in rowFromBody({ mode: "normal" })) && !("trigger" in rowFromBody({ trigger: "x" })));
  const counts = countCauses([
    { run_id: "r1", created_at: "", site: "itandi", checks: [{ code: "STATION_MISSING", severity: "bad", cause_key: "k1", title: "", detail: "" }, { code: "STATION_MISSING", severity: "bad", cause_key: "k1", title: "", detail: "" }] },
    { run_id: "r2", created_at: "", site: "itandi", checks: [{ code: "ZERO_CONFIRMED", severity: "warn", cause_key: "k2", title: "", detail: "" }, { code: "STATION_MISSING", severity: "bad", cause_key: "k1", title: "", detail: "" }] },
  ]);
  t("countCauses: 1回に同じ鍵が2つでも1と数える・bad が上", counts[0].cause_key === "k1" && counts[0].count === 2 && counts[1].count === 1);
}

console.log("── ⑪' 回の見出しに当たる検索の選び方");
{
  const runs = [
    { run_id: "a", site: "realpro", created_at: "2026-09-25T01:00:00Z" },
    { run_id: "b", site: "realpro", created_at: "2026-09-25T01:12:00Z" },
    { run_id: "c", site: "itandi", created_at: "2026-09-25T01:14:00Z" },
    { run_id: "d", site: "realpro", created_at: "2026-09-24T01:14:00Z" },
  ];
  const got = pickAuditForRound(runs, { sites: ["realpro", "itandi"], from: "2026-09-25T01:15:00Z", to: "2026-09-25T01:18:00Z" });
  t("サイトごとに一番近い1回（前日の回は入れない）", got.map((x) => x.run_id).join() === "b,c", got.map((x) => x.run_id).join());
  t("同じサイトが2つあっても1回", pickAuditForRound(runs, { sites: ["realpro", "realpro"], from: "2026-09-25T01:15:00Z" }).length === 1);
  t("範囲外は無し", pickAuditForRound(runs, { sites: ["itandi"], from: "2026-09-25T03:00:00Z" }).length === 0);
}

console.log("── ⑫ DeepSeek の答えの読み方");
{
  const d = parseDiagnosis('```json\n{"cause_ja":"東三国は御堂筋線の駅でJR京都線の一覧に無い","where":{"file":"popup.js","function":""},"fix_ja":"ITANDI_LINE_MAP_FILL の対応を見直す","cause_key_suggest":"","is_genuine_zero":false,"confidence":0.7}\n```');
  t("読める", !!d && d.where.file === "popup.js" && d.is_genuine_zero === false && d.confidence === 0.7);
  t("cause_ja が無ければ null", parseDiagnosis('{"fix_ja":"x"}') === null);
  t("崩れた JSON は null", parseDiagnosis('{"cause_ja":"x",') === null);
  t("confidence は 0〜1 に丸める", parseDiagnosis('{"cause_ja":"x","confidence":3}')!.confidence === 1);
  t("週のまとめ", parseWeekly('{"summary_ja":"s","priorities":[{"cause_key":"k","why_ja":"w","fix_ja":"f"}]}')?.priorities[0].cause_key === "k");
  t("前置きは DOM の名前を作らせない", /推測で DOM の名前/.test(SEARCH_AUDIT_SYSTEM_PROMPT));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
