// 実行: node tests/chrome-extension/itandi-reset.test.js
// v2.5.46 ITANDI の前のお客様の条件を1つずつ外してから入れる（ボタンに頼らない）
//   2026-09-30 竹内「（ITANDI に）消去ボタンは無いので、リアプロのように、一度入っているのを全部抜いて、
//   新しいお客さんに切り替わるたびにお客さんの条件入れたら出来る」
//
// 本番の証拠（extension_snapshots 2026-09-30 の ITANDI のタブの text_head・form.filled）:
//   13:39 「… 管理会社 所在地 大阪市天王寺区 所在地で絞り込み 路線・駅 東淀川 新大阪 … 谷町六丁目 路線・駅で絞り込み 駅徒歩 …」
//   13:50 「… 所在地 大阪市天王寺区 大阪市浪速区 大阪市城東区 大阪市鶴見区 所在地で絞り込み 路線・駅 東淀川 … 谷町六丁目 路線・駅で絞り込み …」
//   14:27 「… 所在地 所在地で絞り込み 路線・駅 路線・駅で絞り込み 駅徒歩 分以内 …」（空の時は見出しとボタンだけ）
//   form.filled: station_walk_minutes:lteq / rent:gteq / rent:lteq / floor_area_amount:gteq / building_age:lteq /
//                offer_conditions_updated_at:gteq（更新日）/ val（並び「last_status_opened_at desc」）
const fs = require("fs");
const path = require("path");
const FG = require("../../chrome-extension/itandi-form-guard.js");
const G = require("../../chrome-extension/batch-guard.js");

const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");
let pass = 0, fail = 0;
function ok(name, cond, detail) { cond ? pass++ : fail++; console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond || !detail ? "" : "\n      " + detail)); }
function eq(name, a, b) { const c = JSON.stringify(a) === JSON.stringify(b); ok(name, c, `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

// 本番の画面の文字（13:50）を行ごとの文字の断片に（page-script は行の中の文字の断片を TreeWalker で集める）
const WARD_ROW_1350 = ["所在地", "大阪市天王寺区", "大阪市浪速区", "大阪市城東区", "大阪市鶴見区", "所在地で絞り込み"];
const ST_1350 = "東淀川 新大阪 大阪 塚本 西九条 野田 福島 十三 神崎川 南方 東三国 中津 なんば 大国町 動物園前 花園町 本町 堺筋本町 谷町四丁目 北浜 長堀橋 日本橋 心斎橋 松屋町 谷町六丁目".split(" ");
const ST_ROW_1350 = ["路線・駅"].concat(ST_1350, ["路線・駅で絞り込み"]);

console.log("\n① チップの文字（見出しとボタンの間）");
eq("13:50 の所在地の行 → 4区", FG.chipNames(WARD_ROW_1350, "wards"), ["大阪市天王寺区", "大阪市浪速区", "大阪市城東区", "大阪市鶴見区"]);
eq("13:50 の路線・駅の行 → 25駅", FG.chipNames(ST_ROW_1350, "stations").length, 25);
eq("空の行（14:27）→ なし", FG.chipNames(["所在地", "所在地で絞り込み"], "wards"), []);
eq("空の行（路線・駅）→ なし", FG.chipNames(["路線・駅", "路線・駅で絞り込み"], "stations"), []);
eq("×・空白・案内の文字はチップでない", FG.chipNames(["所在地", " 大阪市北区 ", "×", "✕", "", "指定なし", "所在地で絞り込み"], "wards"), ["大阪市北区"]);
eq("同じ名前は1つ", FG.chipNames(["大阪市北区", "大阪市北区"], "wards"), ["大阪市北区"]);
eq("全角の空白も詰める", FG.chipNames(["大阪市　北区"], "wards"), ["大阪市北区"]);

console.log("\n② チップの「外す」部品");
ok("svg のアイコン", FG.isDeleteControl({ tag: "svg" }));
ok("× の文字のボタン", FG.isDeleteControl({ tag: "button", text: "×" }));
ok("aria-label=削除", FG.isDeleteControl({ tag: "span", aria: "削除" }));
ok("class に delete（MuiChip-deleteIcon 等）", FG.isDeleteControl({ tag: "span", cls: "MuiChip-deleteIcon" }));
ok("class に close", FG.isDeleteControl({ tag: "i", cls: "icon-close" }));
ok("文字の無いボタン", FG.isDeleteControl({ tag: "button", text: "" }));
ok("区の名前は外す部品でない", !FG.isDeleteControl({ tag: "span", text: "大阪市天王寺区" }));
ok("「所在地で絞り込み」のボタンは外す部品でない", !FG.isDeleteControl({ tag: "button", text: "所在地で絞り込み" }));
ok("名前入りのボタン（class が chip だけ）は外す部品でない", !FG.isDeleteControl({ tag: "button", text: "大阪市北区", cls: "chip" }));
ok("ただの入れ物（div・class なし）は外す部品でない", !FG.isDeleteControl({ tag: "div" }));

console.log("\n③ 残っている欄（読み戻し → 欄の名前）");
// 13:50 の前のお客様の画面そのまま（form.filled と チップ）
const BEFORE_1350 = {
  chips: { wards: FG.chipNames(WARD_ROW_1350, "wards"), stations: FG.chipNames(ST_ROW_1350, "stations") },
  texts: [
    { name: "station_walk_minutes:lteq", value: "10" }, { name: "rent:gteq", value: "7" }, { name: "rent:lteq", value: "10.5" },
    { name: "floor_area_amount:gteq", value: "30" }, { name: "floor_area_amount:lteq", value: "" }, { name: "building_age:lteq", value: "20" },
    { name: "val", value: "last_status_opened_at desc" }, { name: "offer_conditions_updated_at:gteq", value: "3" },
  ],
  checks: [{ name: "room_layout:in", label: "1LDK" }, { name: "room_layout:in", label: "2DK" }, { name: "", label: "敷金なし" }],
};
const L = FG.leftovers(BEFORE_1350);
eq("前のお客様の画面 → 残っている欄", L.map((x) => x.field), ["wards", "stations", "station_walk_minutes:lteq", "rent:gteq", "rent:lteq", "floor_area_amount:gteq", "building_age:lteq", "room_layout:in", "label:敷金なし"]);
ok("並び（val）は条件でない＝外さない", !L.some((x) => x.field === "val"));
ok("更新日は募集条件更新の段が空にする＝ここでは数えない", !L.some((x) => /offer_conditions/.test(x.field)));
ok("欄の日本語（所在地・家賃の上限・間取り）", L.find((x) => x.field === "wards").ja === "所在地" && L.find((x) => x.field === "rent:lteq").ja === "家賃の上限" && L.find((x) => x.field === "room_layout:in").ja === "間取り");
eq("間取りのチェックは1つの欄にまとめる", L.find((x) => x.field === "room_layout:in").values, ["1LDK", "2DK"]);
const EMPTY = { chips: { wards: [], stations: [] }, texts: [{ name: "rent:lteq", value: "" }, { name: "station_walk_minutes:lteq", value: "指定なし" }, { name: "val", value: "ad desc" }], checks: [] };
eq("全部外れた画面 → なし（「指定なし」は空）", FG.leftovers(EMPTY), []);
eq("物件名などその他の欄に文字が残る → その他の入力", FG.leftovers({ texts: [{ name: "name:cont", value: "ｱｲｳ" }] }).map((x) => x.ja), ["その他の入力（name:cont）"]);
eq("読めない形でも落ちない", FG.leftovers(null), []);

console.log("\n④ 点検（filled.reset）の形と失敗の文");
const S1 = FG.resetSummary(BEFORE_1350, EMPTY);
eq("外せた → cleared に欄・leftover なし", [S1.cleared.length, S1.leftover], [9, []]);
eq("外せた時は失敗の文なし", FG.resetFailText(S1), null);
const AFTER_STUCK = { chips: { wards: ["大阪市天王寺区"], stations: ST_1350.slice(0, 6) }, texts: [], checks: [] };
const S2 = FG.resetSummary(BEFORE_1350, AFTER_STUCK);
eq("チップが外れない → leftover に 所在地・駅", S2.leftover, ["wards", "stations"]);
ok("cleared には外れた欄だけ（所在地・駅は入れない）", S2.cleared.indexOf("wards") < 0 && S2.cleared.indexOf("rent:lteq") >= 0);
const T2 = FG.resetFailText(S2);
ok("失敗の文に欄の名前と値（4つまで＋ほか）", /^前の条件を消せない: 所在地（大阪市天王寺区）・路線・駅（東淀川・新大阪・大阪・塚本 ほか2）$/.test(T2), T2);
const S3 = FG.resetSummary({ texts: [{ name: "name:cont", value: "ｱ" }] }, { texts: [{ name: "name:cont", value: "ｱ" }] });
eq("名前の分からない欄が残っても失敗にしない（leftover_other に残す）", [S3.leftover, S3.leftover_other, FG.resetFailText(S3)], [[], ["name:cont"], null]);
ok("失敗の文は 160 文字まで", FG.resetFailText({ leftover_ja: ["x".repeat(300)] }).length <= 160);

console.log("\n⑤ 入れた後に前の区・駅が混ざっていないか");
eq("区のお客様（天王寺区）に前の城東区 → 混ざった", FG.foreignChips({ wards: ["大阪市天王寺区", "大阪市城東区"], stations: [] }, { mode: "area", wards: ["大阪市天王寺区"] }).foreign, ["所在地:大阪市城東区"]);
eq("区のお客様に前の駅 → 混ざった", FG.foreignChips({ wards: ["大阪市天王寺区"], stations: ["なんば"] }, { mode: "area", wards: ["大阪市天王寺区"] }).foreign, ["駅:なんば"]);
eq("駅のお客様に前の区 → 混ざった", FG.foreignChips({ wards: ["大阪市浪速区"], stations: ["大国町"] }, { mode: "station", stations: ["大国町"] }).foreign, ["所在地:大阪市浪速区"]);
eq("このお客様の区だけ → なし", FG.foreignChips({ wards: ["大阪市天王寺区", "大阪市浪速区"], stations: [] }, { mode: "area", wards: ["大阪市天王寺区", "大阪市浪速区"] }).foreign, []);
eq("短い区名（天王寺区）の指定でも当たる", FG.foreignChips({ wards: ["大阪市天王寺区"], stations: [] }, { mode: "area", wards: ["天王寺区"] }).foreign, []);
eq("市全域（大阪市内）→ 大阪市の区は当たる", FG.foreignChips({ wards: ["大阪市北区", "大阪市西区"], stations: [] }, { mode: "area", wards: ["大阪市内"] }).foreign, []);
eq("町域付きのチップ（大阪市城東区稲田本町）も区で当たる", FG.foreignChips({ wards: ["大阪市城東区稲田本町"], stations: [] }, { mode: "area", wards: ["大阪市城東区"] }).foreign, []);
const U = FG.foreignChips({ wards: [], stations: ["大国町", "難波", "心斎橋"] }, { mode: "station", stations: ["大国町", "難波", "なんば"] });
eq("駅の表記ゆれ（当たらない駅）は札にしない・並べるだけ", [U.foreign, U.unmatched_stations], [[], ["心斎橋"]]);
eq("電車1本（沿線の全駅）は駅を比べない", FG.foreignChips({ wards: [], stations: ["十三", "中津"] }, { mode: "station", stations: ["梅田"], selectAll: true }).unmatched_stations, []);

console.log("\n⑥ その他の決まり");
ok("val（並び）は空にしない", FG.keepTextName("val"));
ok("更新日の欄はここで空にしない（募集条件更新の段）", FG.keepTextName("offer_conditions_updated_at:gteq"));
ok("家賃は空にする", !FG.keepTextName("rent:lteq"));
ok("「指定なし」は空", FG.isEmptyValue("指定なし") && FG.isEmptyValue("  ") && !FG.isEmptyValue("0"));
eq("打つ欄は6つ（家賃の上下・面積の上下・駅徒歩・築年数）", FG.CLEAR_TEXT_FIELDS.map((x) => x.name), ["rent:lteq", "rent:gteq", "floor_area_amount:gteq", "floor_area_amount:lteq", "station_walk_minutes:lteq", "building_age:lteq"]);
eq("外すチェック（間取り・構造・設備）", FG.CLEAR_CHECK_NAMES.map((x) => x.name), ["room_layout:in", "structure_type:in", "option_id:all_in"]);
ok("管理費込み（totalRentCheck）は毎回入れる＝外すチェックに入れない", FG.CLEAR_CHECK_NAMES.every((x) => x.name !== "totalRentCheck"));

console.log("\n⑦ ★物件出し★の知らせ");
const n1 = G.failureNotice({ customerName: "S", siteLabel: "itandi", error: "page-script側エラー（スキップ）: AXLX_RESET_FAILED: 所在地（大阪市天王寺区）・路線・駅（東淀川・新大阪 ほか23）" });
ok("外せなかった知らせ（欄の名前・0件とは言わない）", /前のお客様の条件を画面から外せませんでした（所在地（大阪市天王寺区）/.test(n1) && /0件とは限りません/.test(n1), n1);

console.log("\n⑧ 配線");
const ps = read("itandi-page-script.js");
const fillStart = ps.indexOf("function fill(cond)");
const fillSrc = ps.slice(fillStart);
ok("fill は入れる前に _itResetForm（外して確かめてから）", fillSrc.indexOf("_itResetForm(function (res)") > 0 && fillSrc.indexOf("_itResetForm(function (res)") < fillSrc.indexOf("function _afterReset()"));
ok("入れる本体（賃料・所在地）は _afterReset の中", fillSrc.indexOf("function _afterReset()") < fillSrc.indexOf("STEP 1: 賃料"));
ok("外せなければ AXLX_RESET_FAILED で返す（検索しない・skip）", /_safeDone\("AXLX_RESET_FAILED: " \+/.test(ps) && /if \(errMsg\) \{ msg\.error = errMsg; msg\.skip = true; \}/.test(ps));
ok("外せない時は点検に reset_fail（欄の名前）", /_itAudit\.reset_fail = _rf;/.test(ps) && /resetFailText\(res\.summary\)/.test(ps));
ok("外せた時は reset_fail を付けない（旧: ボタンが無いと毎回付いた）", !/条件リセットのボタンが見つからない/.test(ps));
ok("点検に reset（cleared・leftover）", /_itAudit\.reset = res && res\.summary \? \{ cleared: res\.summary\.cleared, leftover: res\.summary\.leftover/.test(ps));
ok("外した後に読み戻して確かめる（verify）・もう1回まで", /function verify\(\)/.test(ps) && /if \(left\.length && pass < 2\) \{ run\(\); return; \}/.test(ps));
ok("外せなかった時は部品の形を hint に", /hint\[r\.key\] = _itDomHint\(cs\[0\]\)/.test(ps));
ok("1つずつ人の間を空けて外す（連打しない）", /setTimeout\(next, _hd\(FG\.RESET_STEP_MS\)\)/.test(ps));
ok("チップは押す時に読み直して先頭から外す（並びが変わる）", /var cs = f \? _itChipNodes\(r, f\) : null;/.test(ps));
ok("入れた後のチップを点検に（reset.after・混ざったら reset_fail）", /_itAudit\.reset\.after = _ac;/.test(ps) && /入れた後に前の条件が混ざっている/.test(ps));
ok("チップの行は見出しで始まりボタンの前に何かある入れ物（ボタンだけの入れ物にしない）", /tx\.indexOf\(lab\) === 0 && tx\.indexOf\(bt\) > 0/.test(ps));
ok("行が決まらない時は大きな入れ物を行にしない（読めない扱い）", /\/\/ 行が決まらない時は読めない扱い[^\n]*\n\s*return null;/.test(ps));
const resetSrc = ps.slice(ps.indexOf("v2.5.46 前のお客様の条件を1つずつ外す"), ps.indexOf("function fill(cond)"));
ok("外す処理で Escape キーを送らない（ITANDI の React の状態を壊す）", !/KeyboardEvent|"Escape"|"keydown"/.test(resetSrc));
ok("外す処理は結果の一覧の行のチェック（一括DL）に触らない（name で決めた物とラベルだけ）", !/input\[type="checkbox"\]:checked'\)/.test(resetSrc) && /\[name="' \+ d\.name \+ '"\]:checked/.test(resetSrc));
ok("絞り込みの窓の中の欄は外さない", /_itInDialog\(inp\)/.test(resetSrc) && /_itInDialog\(el\)/.test(resetSrc));
const bg = read("background.js");
ok("background: 1回目の読み戻しにも reset（ITANDI の入れ直しの材料）", /reset: f\.reset \? \{ cleared:/.test(bg));
const mf = JSON.parse(read("manifest.json"));
eq("manifest の版", mf.version, "2.5.47");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
