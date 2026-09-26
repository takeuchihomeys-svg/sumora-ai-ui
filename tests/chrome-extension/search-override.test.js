// 実行: node tests/chrome-extension/search-override.test.js
// AIXツールのメモ欄の検索の指示（web_brain の payload.search_override）を「その回だけ」重ねる（chrome-extension/search-override.js）を固定する。
// 2026-09-27 竹内「『大正駅で検索する』なら駅は大正駅だけで検索、『1LDKで検索する』なら1LDKで検索。これは拡張ツールの一時調整の部分で合わせる形」
const fs = require("fs");
const path = require("path");
const S = require("../../chrome-extension/search-override.js");
let pass = 0, fail = 0;
function eq(name, a, b) { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok ? "" : `\n      expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`)); }
function ok(name, c) { eq(name, !!c, true); }
const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");

const OV_TAISHO = { v: 1, location: { mode: "only", stations: ["大正"], lines: [], areas: [] }, floor_plan: null, rent_max: null, rent_min: null, walk_minutes: null, building_age: null, area_min: null, area_max: null, pet: null, site: null, is_wide: null };
const CUST = { id: "c1", customer_name: "テスト", desired_area: "大正区・西区", area_mode: "ward", rent_max: 75000, rent_min: null, floor_plan: "1K〜1DK", walk_minutes: 10, lines: ["x"], stations: ["y"] };

console.log("\n■ sanitize（payload の形だけ確かめる）");
eq("大正駅だけ", S.sanitize(OV_TAISHO), OV_TAISHO);
eq("何も上書きが無い → null（ふつうの web_brain）", S.sanitize({ site: "itandi", is_wide: true }), null);
eq("null / 配列 / 文字 → null", [S.sanitize(null), S.sanitize([]), S.sanitize("x")], [null, null, null]);
eq("形の違う間取り・範囲外の数字は捨てる", S.sanitize({ floor_plan: "1LDK<script>", rent_max: 5, walk_minutes: 10 }), { v: 1, location: null, floor_plan: null, rent_max: null, rent_min: null, walk_minutes: 10, building_age: null, area_min: null, area_max: null, pet: null, site: null, is_wide: null });
eq("下限が上限以上なら下限を捨てる", S.sanitize({ rent_max: 70000, rent_min: 80000 }).rent_min, null);
eq("変な文字の駅名は捨てる", S.sanitize({ location: { stations: ["大正", "<b>"], lines: [], areas: [] } }).location.stations, ["大正"]);

console.log("\n■ applyToCustomer（お客様の写し・元は変えない）");
{
  const before = JSON.stringify(CUST);
  const c = S.applyToCustomer(CUST, OV_TAISHO);
  eq("大正駅だけ → 希望エリア＝大正・駅モード", [c.desired_area, c.area_mode], ["大正", "station"]);
  eq("登録の路線・駅の配列は外す（only）", [c.lines, c.stations, c.areas], [[], [], null]);
  eq("書かれていない条件は登録のまま", [c.rent_max, c.floor_plan, c.walk_minutes], [75000, "1K〜1DK", 10]);
  eq("元のお客様は変わらない", JSON.stringify(CUST), before);
  ok("どの上書きかを持つ（点検用）", c._search_override === OV_TAISHO);
}
{
  const c = S.applyToCustomer(CUST, S.sanitize({ floor_plan: "1LDK", rent_max: 80000, rent_min: 60000, area_min: 25, pet: true }));
  eq("1LDK・家賃6〜8万・25㎡・ペット", [c.floor_plan, c.layout, c.rent_max, c.max_rent, c.rent_min, c.floor_area_min, c.pet], ["1LDK", "1LDK", 80000, 80000, 60000, 25, true]);
  eq("場所の指示が無ければ場所は登録のまま", [c.desired_area, c.area_mode], ["大正区・西区", "ward"]);
}
{
  const c = S.applyToCustomer(CUST, S.sanitize({ location: { mode: "add", stations: ["難波"], lines: [], areas: [] } }));
  eq("地域の登録に駅を足す → 両方（both）", [c.desired_area, c.area_mode], ["大正区・西区・難波", "both"]);
}
{
  const c = S.applyToCustomer({ desired_area: "大正", area_mode: "station" }, S.sanitize({ location: { mode: "add", stations: ["芦原橋", "大正"], lines: [], areas: [] } }));
  eq("駅の登録に駅を足す（重ねない）→ 駅のまま", [c.desired_area, c.area_mode], ["大正・芦原橋", "station"]);
}
eq("駅と区を両方 → both", S.applyToCustomer(CUST, S.sanitize({ location: { mode: "only", stations: ["大正"], lines: ["御堂筋線"], areas: ["大阪市西区"] } })).area_mode, "both");
eq("上書きなし → そのまま同じ物", S.applyToCustomer(CUST, null) === CUST, true);

console.log("\n■ formValues（一時調整の欄に入れる値）");
eq("大正駅だけ → 駅欄＝大正・地域欄＝空・軸は駅", S.formValues(OV_TAISHO, { station: "", ward: "大正区・西区" }, "station"), { station: "大正", ward: "", edited: "station" });
eq("地域だけ → 軸は地域", S.formValues(S.sanitize({ location: { stations: [], lines: [], areas: ["大阪市大正区"] } }), {}, null), { station: "", ward: "大阪市大正区", edited: "ward" });
eq("足す → 今の欄に足す（重ねない）", S.formValues(S.sanitize({ location: { mode: "add", stations: ["難波", "大正"], lines: [], areas: [] } }), { station: "大正", ward: "西区" }, null), { station: "大正・難波", ward: "西区", edited: null });
eq("both の地域の回 → 駅欄を空に", S.formValues(S.sanitize({ location: { mode: "add", stations: ["難波"], lines: [], areas: [] } }), { station: "", ward: "大正区" }, "ward"), { station: "", ward: "大正区", edited: "ward" });
eq("場所の指示が無ければ場所の欄に触らない（undefined）", Object.keys(S.formValues(S.sanitize({ floor_plan: "1LDK" }), { station: "x" }, null)), ["floor"]);
eq("数字は文字にして入れる", S.formValues(S.sanitize({ rent_max: 80000, walk_minutes: 10, building_age: 20, area_min: 25 }), {}, null), { rent_max: "80000", walk: "10", age: "20", area_min: "25" });

console.log("\n■ describe");
eq("大正駅だけ", S.describe(OV_TAISHO), "大正駅だけ");
eq("まとめて", S.describe(S.sanitize({ location: { mode: "add", stations: ["難波"], lines: ["御堂筋線"], areas: ["大阪市西区"] }, floor_plan: "1LDK", rent_max: 80000 })), "難波駅・御堂筋線・西区を足す・1LDK・家賃〜8万");

console.log("\n■ 配線（読み込み・2か所の受け口・中継）");
{
  const manifest = JSON.parse(read("manifest.json"));
  ok("manifest の版が 2.5.26 以上", manifest.version.split(".").map(Number).reduce((a, n) => a * 1000 + n, 0) >= 2005026);
  ok("web_accessible_resources にある（下のバーの iframe が popup.html を開く）", manifest.web_accessible_resources[0].resources.includes("search-override.js"));
  const html = read("popup.html");
  ok("popup.html が popup.js より先に読む", html.indexOf('src="search-override.js"') > 0 && html.indexOf('src="search-override.js"') < html.indexOf('src="popup.js"'));
  const bg = read("background.js");
  ok("background が import", /import "\.\/search-override\.js";/.test(bg));
  ok("web_brain の回だけ sanitize", /isWebBrain && self\.AxlxSearchOverride\) \? self\.AxlxSearchOverride\.sanitize\(cmdPayload\.search_override\)/.test(bg));
  ok("お客様の写しに重ねる（元の targets は変えない）", /applyToCustomer\(targets\[i\], searchOverride\)/.test(bg));
  ok("点検に上書きを渡す", /search_override: searchOverride/.test(bg));
  eq("popup への axlx-switch-customer（リアプロ・itandi）の2つとも searchOverride を渡す", (bg.match(/searchOverride: _searchOverride/g) || []).length, 2);
  const ub = read("underbar.js");
  ok("underbar が popup へ searchOverride を中継", /searchOverride: msg\.searchOverride \|\| null/.test(ub));
  const pp = read("popup.js");
  // パターン8（同じ処理が2か所）: runtime.onMessage と postMessage の両方の受け口で同じ関数を使う
  eq("2つの受け口の両方で欄に入れる", (pp.match(/_applySearchOverrideToForm\(_ov[RP],/g) || []).length, 2);
  eq("2つの受け口の両方で押した後に戻す予約", (pp.match(/_afterSearchOverrideClick\(_ov[RP]\)/g) || []).length, 2);
  eq("2つの受け口の両方で保存済みの一時調整の復元を止める", (pp.match(/if \(_ov[RP]\) _adjRestoreSuppressed = true;/g) || []).length, 2);
  eq("fetchFreshCustomer の読み直し3か所で欄と軸を戻さない", (pp.match(/if \(_searchOverrideHeld\(fresh\.id\)\) return;/g) || []).length, 3);
  // 5大バグの型: 入れるだけ（input の出来事を出さない＝履歴に保存しない）・トグルの click を重ねない
  const fn = pp.slice(pp.indexOf("function _applySearchOverrideToForm"), pp.indexOf("function _afterSearchOverrideClick"));
  ok("欄に入れる時に input/change の出来事を出さない（履歴 tempAdj_ に保存しない）", !/dispatchEvent/.test(fn));
  ok("保存待ちのタイマーを消し _adjDirty を立てない", /clearTimeout\(_adjSaveTimer\)/.test(fn) && /_adjDirty = false/.test(fn));
  ok("軸はボタンの click でなく値で入れる（トグルを重ねない）", !/\.click\(\)/.test(fn) && /currentAreaMode = v\.edited/.test(fn));
  ok("localStorage に書かない", !/localStorage/.test(fn));
  const sa = read("search-audit.js");
  ok("点検の customer_snapshot に _search_override", /o\._search_override = ovr/.test(sa));
}

console.log("\n■ 検索の点検（tracker.begin）に上書きが残る");
{
  const A = require("../../chrome-extension/search-audit.js");
  const sent = [];
  const tr = A.createTracker({ post: (b) => { sent.push(b); return Promise.resolve({ ok: true }); }, now: () => 1000 });
  const c = S.applyToCustomer(CUST, OV_TAISHO);
  const run = tr.begin({ site: "realnetpro", customer_id: "c1", customer: c, trigger: "web_brain", search_override: OV_TAISHO });
  const snap = sent[0].customer_snapshot;
  eq("写しは上書きを重ねた条件", [snap.desired_area, snap.area_mode], ["大正", "station"]);
  eq("元の指示も残る", snap._search_override.location, OV_TAISHO.location);
  ok("名前は入らない", !JSON.stringify(sent[0]).includes("テスト"));
  ok("段に search_override", run.steps.some((s) => s.k === "search_override"));
  const sent2 = [];
  const tr2 = A.createTracker({ post: (b) => { sent2.push(b); return Promise.resolve({ ok: true }); } });
  tr2.begin({ site: "realnetpro", customer_id: "c1", customer: CUST, trigger: "bulk_queue" });
  ok("上書きが無い回は今まで通り（_search_override なし）", !("_search_override" in sent2[0].customer_snapshot));
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
