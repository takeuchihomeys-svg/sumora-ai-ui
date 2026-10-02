// 実行: node tests/chrome-extension/itandi-guide.test.js
// 2026-10-01 竹内「ITANDIも画面表示光らせるようにする。検索の画面の入力は手動でそれ以外は今まで通りに、画像もそのままチェックして売上番長に送って解析させる流れ」
//   ① 手順表（itandi-guide-plan.js）の表が自動入力（itandi-page-script.js）と同じか・同じ条件で同じ欄を選ぶか（自動入力の fillRemainingFields をそのまま動かして比べる）
//   ② 案内（itandi-guide.js）が押さない・入れない・スクロールしない・ページをめくらないか（ファイルの中身で確かめる）
//   ③ 受け口（itandi-page-script.js の1か所）・一覧の自動送信の止め（itandi-bulk-dl.js）・popup・manifest の並び
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const P = require(path.join(dir, "itandi-guide-plan.js"));
const FG = require(path.join(dir, "itandi-form-guard.js"));

let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 500) : "")); } }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── ① itandi-page-script.js の表と同じか ──
const ps = read("itandi-page-script.js");
function tableOf(src, name) {
  const m = src.match(new RegExp("var " + name + "\\s*=\\s*(\\[[\\s\\S]*?\\]|\\{[\\s\\S]*?\\});"));
  if (!m) return null;
  // eslint-disable-next-line no-new-func
  return Function("return " + m[1])();
}
for (const t of ["STRUCTURE_MAP", "STRUCTURE_LABEL_MAP", "VALID_LAYOUTS", "FLOOR_RANK_IT", "FLOOR_TEXT_IT", "SLDK_SUBSTITUTE_IT", "SLDK_UPPER_IT", "ITANDI_STATION_ALIAS_MAP"]) {
  ok("表 " + t + " が itandi-page-script.js と同じ", tableOf(ps, t) !== null && eq(tableOf(ps, t), P[t]));
}
ok("ペット相談・バストイレ別の id が itandi-page-script.js と同じ", ps.includes('[id="' + P.PET_ID + '"]') && ps.includes('[id="' + P.BATH_ID + '"]') && ps.includes("/バス.*トイレ別|トイレ別|バストイレ別/i"));
ok("敷金・礼金なしのラベルの文字が itandi-page-script.js と同じ", P.SHIKIREI_TEXTS.every((t) => ps.includes("'" + t + "'")));

// 自動入力の fillRemainingFields をそのまま動かす（document は記録するだけの作り物）
const frStart = ps.indexOf("  function fillRemainingFields(cond) {");
const frEnd = ps.indexOf("\n  }\n", frStart) + 4;
const frSrc = ps.slice(frStart, frEnd);
ok("自動入力の fillRemainingFields を取り出せた", frStart > 0 && /敷金・礼金なし/.test(frSrc));
function runAutofill(cond) {
  const ticked = [], texts = {}, labels = [];
  const boxes = {};
  const box = (name, id) => { const k = name + "#" + id; return boxes[k] || (boxes[k] = { checked: false, click() { this.checked = !this.checked; if (this.checked) ticked.push(k); } }); };
  const skiLabel = { textContent: "敷金・礼金なし", querySelector: () => box("label", "敷金・礼金なし") };
  const document = {
    querySelector(sel) {
      let m = sel.match(/^input\[name="([^"]+)"\]\[id="([^"]+)"\]$/);
      if (m) return box(m[1], m[2]);
      m = sel.match(/^input\[name="([^"]+)"\]$/);
      if (m) return { name: m[1] };
      return null;
    },
    querySelectorAll(sel) { return /^label$/.test(sel.trim()) ? [skiLabel] : []; },
  };
  // eslint-disable-next-line no-new-func
  const fr = Function("document", "setReactVal", "tick", "clickLabel", "isVis", "_sd", "setTimeout", "console", "VALID_LAYOUTS", "STRUCTURE_MAP", "STRUCTURE_LABEL_MAP",
    frSrc + "\nreturn fillRemainingFields;")(
    document, (el, v) => { texts[el.name] = String(v); }, (el) => { if (el && !el.checked) el.click(); }, (t) => { labels.push(t); return true; },
    () => true, (x) => x, () => {}, { log() {}, warn() {} }, tableOf(ps, "VALID_LAYOUTS"), tableOf(ps, "STRUCTURE_MAP"), tableOf(ps, "STRUCTURE_LABEL_MAP"));
  fr(JSON.parse(JSON.stringify(cond)));
  return { ticked, texts, labels };
}
function planPicks(cond) {
  const plan = P.buildPlan(cond);
  const ck = plan.steps.filter((s) => s.kind === "check" && s.name !== "totalRentCheck");
  return {
    layouts: ck.filter((s) => s.name === "room_layout:in").map((s) => s.fid),
    structure: ck.filter((s) => s.name === "structure_type:in" && s.fid).map((s) => s.fid),
    structureLabels: ck.filter((s) => s.name === "structure_type:in" && !s.fid).map((s) => s.labelText),
    options: ck.filter((s) => s.name === "option_id:all_in").map((s) => s.fid),
    shikirei: plan.steps.some((s) => s.kind === "check_text"),
    texts: Object.fromEntries(plan.steps.filter((s) => s.kind === "text" && !/^rent:/.test(s.name)).map((s) => [s.name, s.value])),
  };
}
function autoPicks(cond) {
  const r = runAutofill(cond);
  const of = (name) => r.ticked.filter((k) => k.startsWith(name + "#")).map((k) => k.slice(name.length + 1));
  return {
    layouts: of("room_layout:in"), structure: of("structure_type:in"), structureLabels: r.labels, options: of("option_id:all_in"),
    shikirei: of("label").length > 0, texts: r.texts,
  };
}
const CASES = [
  { floor_plan: "2LDK" }, { floor_plan: "2LDK", is_wide: true }, { floor_plan: "1LDK以上" }, { floor_plan: "1SLDK〜3LDK" }, { floor_plan: "1DK～1LDK" },
  { floor_plan: "1LDK〜2LDK", is_wide: true }, { floor_plan: "2LDK もしくは 1LDK" }, { floor_plan: "1K・1DK" }, { floor_plan: "ワンルーム" }, { floor_plan: "5K以上" },
  { floor_plan: "1L" }, { floor_plan: "2SLDK" }, { floor_plan: "広め" }, { floor_plan: "3LDK", is_wide: true }, { floor_plan: "2LDKもしくは、ちょっと広めの1LDK" },
  { structure_types: ["RC", "木造", "木造一部RC造", "鉄骨鉄筋コンクリート造", "謎造"] }, { structure_types: ["S造", "重量鉄骨造"] },
  { pet_ok: true, preferences: "バス・トイレ別希望" }, { shikirei_free: true }, { preferences: "トイレ別" },
  { area_min: 25, area_max: 40, walk_minutes: 10, building_age: 25, floor_plan: "1K", pet_ok: true, structure_types: ["RC"], is_wide: true },
];
// 2026-10-01 竹内「上から下・横並びは左から右」: 案内の手順は画面の並びに並べ替えた（自動入力と順が違う）→ 選ぶ欄が同じかを、並びを揃えて比べる
const sortedPicks = (x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, Array.isArray(v) ? [...v].map(String).sort() : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort()) : v]));
for (const c of CASES) {
  const a = autoPicks(c), p = planPicks(c);
  ok("自動入力と同じ欄: " + JSON.stringify(c), eq(sortedPicks(a), sortedPicks(p)), { auto: a, plan: p });
}
// 並び: 画面の上から下（所在地 → 駅徒歩 → 賃料 → 管理費込み → 敷金なし・礼金なし → 間取り（左から右）→ 面積 → 築年数 → 構造 → 更新 → バス・トイレ別 → ペット → 検索）
{
  const plan = P.buildPlan({ city_codes: ["27113"], area_mode: "ward", wards: ["大阪市西淀川区"], rent_max: 65000, walk_minutes: 10, shikirei_free: true, floor_plan: "2LDK 1K 1LDK", area_min: 25, building_age: 20, structure_types: ["RC", "木造"], rp_update_days: 3, preferences: "バス・トイレ別", pet_ok: true });
  const kinds = plan.steps.map((s) => s.name || s.kind + (s.texts ? ":" + s.texts[s.texts.length - 1] : ""));
  const pos = (k) => kinds.findIndex((x) => x === k || x.startsWith(k));
  const order = ["station_walk_minutes:lteq", "rent:lteq", "totalRentCheck", "check_text:敷金なし", "check_text:礼金なし", "room_layout:in", "floor_area_amount:gteq", "building_age:lteq", "structure_type:in", "update_days", "option_id:all_in", "search"];
  ok("並び: 画面の上から下", order.every((k, i) => i === 0 || pos(order[i - 1]) < pos(k)), kinds);
  const lay = plan.steps.filter((s) => s.name === "room_layout:in").map((s) => s.labelText);
  ok("間取りは左から右・上の段から（1K → 1LDK → 2LDK）", JSON.stringify(lay) === JSON.stringify(["1K", "1LDK", "2LDK"]), lay);
  const st = plan.steps.filter((s) => s.name === "structure_type:in").map((s) => s.labelText);
  ok("構造も画面の並び（木造 → RC）", st[0] === "木造" && st[1] === "RC", st);
}

// 家賃（自動入力の STEP 1 と同じ: 円→万円・5文字以内）
ok("家賃の上限 84,999 円 → 8.499（5桁以内・切り下げ）", P.buildPlan({ rent_max: 84999 }).steps.some((s) => s.name === "rent:lteq" && s.value === "8.499"));
ok("家賃の下限 70,000 円 → 7・上限 100,000 円 → 10（画面の並び: 下限 〜 上限）", P.buildPlan({ rent_max: 100000, rent_min: 70000 }).steps.filter((s) => /^rent:/.test(s.name)).map((s) => s.value).join(",") === "7,10");
ok("家賃の文字は form-guard の rentText と同じ", P.rentValue(123456, "max") === FG.rentText(123456, "max") && P.rentValue(65001, "min") === FG.rentText(65001, "min"));
ok("管理費込み（totalRentCheck）は毎回", P.buildPlan({}).steps.some((s) => s.name === "totalRentCheck"));

// 場所（自動入力の _afterReset と同じ）
ok("場所: 所在地が先（区と路線の両方 → 所在地）", P.locationOf({ ward_names: ["大阪市北区"], itandi_lines: ["御堂筋線"], station_names: ["梅田"] }).mode === "area");
ok("場所: area_mode=station は所在地を捨てる", P.locationOf({ area_mode: "station", ward_names: ["大阪市北区"], itandi_lines: ["御堂筋線"], station_names: ["梅田"] }).mode === "station");
ok("場所: area_mode=ward は路線・駅を捨てる", P.locationOf({ area_mode: "ward", itandi_lines: ["御堂筋線"], station_names: ["梅田"] }).mode === "none");
{
  const l = P.locationOf({ itandi_lines: ["御堂筋線"], station_names: ["梅田駅", "谷町線", "なんば"] });
  ok("場所: 駅の欄の「〜線」は路線へ・駅の「駅」は外す", eq(l.lines, ["御堂筋線", "谷町線"]) && eq(l.stations, ["梅田", "なんば"]), l);
}
ok("場所: 「大阪市内」1つ → 市の全区（batchCity）", P.locationOf({ ward_names: ["大阪市内"] }).batchCity === "大阪市" && P.locationOf({ ward_names: ["大阪市北区", "大阪市西区"] }).batchCity === null);
ok("場所: 電車1本（select_all_line_stations）は駅を全部", P.buildPlan({ itandi_lines: ["京阪本線"], station_names: ["京橋"], select_all_line_stations: true }).steps.find((s) => s.kind === "pick_lines").selectAll === true);
ok("区の短い名前（getShortName と同じ式）", P.wardShortName("大阪市城東区") === "城東区" && ps.includes('wName.replace(/^.+?([^\\s　市区郡]+[区町村])$/, "$1")'));
{
  const plan = P.buildPlan({ rent_max: 90000, ward_names: ["大阪市城東区"], ward_town_map: { "大阪市城東区": ["稲田本町"] }, rp_update_days: 3, floor_plan: "1K", walk_minutes: 10 });
  const kinds = plan.steps.map((s) => s.kind);
  ok("手順: 外す → 所在地 → 家賃 … → 更新日 → … → 検索（画面の上から下）", kinds[0] === "clear" && kinds.indexOf("pick_area") === 1 && kinds.indexOf("pick_area") < kinds.indexOf("text") && kinds.indexOf("update_days") > kinds.indexOf("pick_area") && kinds[kinds.length - 1] === "search", kinds);
  ok("手順の id は重ならない", new Set(plan.steps.map((s) => s.id)).size === plan.steps.length);
  ok("所在地の手順に町域", /稲田本町/.test(plan.steps.find((s) => s.kind === "pick_area").label));
  ok("このお客様で入れる物（clear が残りと見分ける）", plan.want.texts["rent:lteq"] === "9" && plan.want.updateDays === 3 && plan.want.checks["room_layout:in"][0].id === "1K");
}
ok("更新日: 無い時は手順にしない（残っていれば clear が空にする）", !P.buildPlan({}).steps.some((s) => s.kind === "update_days") && P.buildPlan({}).want.updateDays === null);
ok("広げて: 築年数・家賃は popup が入れた値のまま（＋5年は popup・ここでは足さない）", P.buildPlan({ building_age: 30, is_wide: true }).steps.some((s) => s.name === "building_age:lteq" && s.value === "30"));
ok("popup: 広げての築年数＋5年・家賃の上乗せはそのまま（案内でも同じ条件を作る）", /return searchMode === "wide" \? baseAge \+ 5 : baseAge;/.test(read("popup.js")) && /const buffer = rawRentMax <= 100000 \? 5000 : 10000;/.test(read("popup.js")));

// ── ② 案内は押さない・入れない・スクロールしない ──
const g = read("itandi-guide.js").replace(/\/\/.*$/gm, "");
ok("押す処理が無い（.click( / dispatchEvent / submit(）", !/\.click\s*\(|dispatchEvent|\.submit\s*\(/.test(g));
ok("値・チェックを入れない（.value = / .checked = / selectedIndex = / setAttribute value）", !/\.value\s*=[^=]|\.checked\s*=[^=]|selectedIndex\s*=[^=]|setAttribute\(\s*["'](value|checked)/.test(g));
// 2026-10-02 v2.5.69 竹内さんの許可: 所在地の小窓の市区町村の一覧だけは、選ぶ区が見える所へ1行で動かしてよい（ALLOWED_SCROLL の印の1か所だけ）
const gRaw = read("itandi-guide.js");
const gNoAllowed = gRaw.split("\n").filter((l) => !/ALLOWED_SCROLL/.test(l)).join("\n").replace(/\/\/.*$/gm, "");
ok("スクロールしない（scrollIntoView / scrollTo / scrollBy / scrollTop =）・許すのは小窓の一覧の1行だけ", !/scrollIntoView|scrollTo\s*\(|scrollBy\s*\(|scrollTop\s*=[^=]/.test(gNoAllowed) && (gRaw.match(/\/\/ ALLOWED_SCROLL\s*$/gm) || []).length === 1);
ok("ページをめくらない・読み直さない（location / history）", !/location\.(href|assign|replace|reload)|history\.(back|go|push)/.test(g));
ok("フォームを送らない・キーを送らない（requestSubmit / KeyboardEvent / focus(）", !/requestSubmit|KeyboardEvent|\.focus\s*\(|\.blur\s*\(/.test(g));
ok("「全ページ送る」を案内モードの間は止める", /axlx-itandi-all-pages-btn/.test(g) && /disabled\s*=\s*!!guideOn/.test(g));
ok("リアプロとは別の案内の箱（storage.session）", /axlx_itandi_guide_session/.test(g) && !/"axlx_guide_session"/.test(g));
ok("お客様が条件に無い時は今のお客様で補う", /current_customer_id/.test(g) && /current_customer_name/.test(g));
const gp = read("itandi-guide-plan.js").replace(/\/\/.*$/gm, "");
ok("手順表は DOM も chrome.* も使わない", !/document\.|chrome\./.test(gp));

// ── ③ つなぎ ──
const lis = ps.slice(ps.indexOf('e.data.from !== "axlx-itandi-fill-exec"'));
ok("itandi-page-script: OFF の印（\"0\"）の時だけ自動入力・それ以外は案内に渡す", /function _guideOn\(\) \{ return document\.documentElement\.getAttribute\("data-axlx-guide"\) !== "0"; \}/.test(ps)
  && lis.indexOf("if (_guideOn())") > 0 && lis.indexOf("if (_guideOn())") < lis.indexOf("fill(e.data.conditions);") && /from: "axlx-itandi-guide-start"/.test(lis));
ok("itandi-page-script: 案内に渡した回は「検索を押していない」（skip）で完了を返す", /from: "aixlinx-fill-done", error: "guide-mode: [^"]*", skip: true/.test(lis));
ok("itandi-page-script: 入力の途中で案内モードになっても検索を押さない", /if \(_guideOn\(\)\) \{ _itStep\("guide_mode"[^\n]*\n\s*var _searched = false;/.test(ps));
ok("itandi-page-script: 同じ依頼の2回目の止めは案内より前（今まで通り）", ps.indexOf("FG.isDuplicateFill(_lastFillReq, _key, _now)") < ps.indexOf('from: "axlx-itandi-guide-start"'));
const ib = read("itandi-bulk-dl.js");
ok("itandi-bulk-dl: 案内モードの間は全ページ自動送信・1ページの自動送信を始めない",
  /function autoSendAllPages\(_manual\) \{\s*if \(_guideBlocksAuto\("autoSendAllPages"\)\) return;/.test(ib) && /function _autoSendOnePage\([^)]*\) \{\s*if \(_guideBlocksAuto\("_autoSendOnePage"\)\) return;/.test(ib));
ok("itandi-bulk-dl: 読めない時も止める（明示の OFF＝false の時だけ動く）", /_guideOff = !!\(r && r\.guideMode === false\)/.test(ib) && /if \(_guideOff\) return false;/.test(ib));
ok("itandi-bulk-dl: 「売上番長に送る」（スタッフが押す）は今まで通り", /addEventListener\("click", onSendToLine\)/.test(ib) && !/function onSendToLine\(\) \{\s*if \(_guideBlocksAuto/.test(ib));
ok("itandi-bulk-dl: skip の完了では自動送信を armed にしない（今まで通り）", /if \(e\.data\.skip\) \{ _autofillInitiated = false;/.test(ib));
const pp = read("popup.js");
ok("popup: 準備中の止めを外した・案内モードでも条件を組み立てて送る", !/ITANDI の案内モードは準備中/.test(pp) && /const _guideIt = _gmIt !== false;/.test(pp));
ok("popup: ITANDI の条件にお客様（案内の枠に出す）", /unknown_tokens: unknownTokens\.length > 0 \? unknownTokens : null,\s*\/\/[^\n]*\n\s*customer_id:\s+c\.id \|\| null,\s*customer_name: c\.customer_name \|\| null,/.test(pp));
ok("popup: 一覧の P・広 から ITANDI の案内も始める", /if \(site !== "realpro" && site !== "itandi"\)/.test(pp));
const mf = JSON.parse(read("manifest.json"));
const cs = mf.content_scripts;
const bi = cs.findIndex((c) => (c.js || []).includes("itandi-bulk-dl.js"));
const gi = cs.findIndex((c) => (c.js || []).includes("itandi-guide.js"));
const gjs = gi >= 0 ? cs[gi].js : [];
ok("manifest: ITANDI の案内は一覧の部品（itandi-bulk-dl）の後の段・form-guard → update-days → 手順表 → 案内 の順", bi >= 0 && gi > bi
  && eq(gjs, ["itandi-form-guard.js", "itandi-update-days.js", "itandi-guide-plan.js", "itandi-guide.js"]), { bi, gi, gjs });
ok("manifest: 案内は ITANDI だけ・ページの中（MAIN）ではない（chrome.storage を使う）", gi >= 0 && eq(cs[gi].matches, ["https://itandibb.com/*"]) && !cs[gi].world);
ok("manifest の版 2.5.69", mf.version === "2.5.69");

// ── 2026-10-02 v2.5.68 竹内「西淀川区選択しているのに選択されたことになっていない」: 確定の後の画面の文字から選ばれた区を読む ──
{
  const W = ["大阪市西淀川区"];
  ok("左のチップ「大阪市西淀川区 ⊗」で済み", eq(P.selectedWardsFromTexts(["所在地", "大阪市西淀川区 ⊗", "路線・駅で絞り込み"], W), W));
  ok("下の要約「大阪府：大阪市西淀川区」で済み", eq(P.selectedWardsFromTexts(["大阪府：大阪市西淀川区", "該当件数", "467件"], W), W));
  ok("全角・空白・短い名前（西淀川区）でも済み", eq(P.selectedWardsFromTexts(["西淀川区"], W), W) && eq(P.selectedWardsFromTexts(["大阪市　西淀川区"], W), W));
  ok("番地つきの所在地（物件の行）は数えない", eq(P.selectedWardsFromTexts(["大阪市西淀川区歌島1丁目", "大阪府大阪市西淀川区"], W), []));
  ok("複数の区は区ごと（北区だけ選んだ時は北区だけ）", eq(P.selectedWardsFromTexts(["大阪府：大阪市北区"], ["大阪市西淀川区", "大阪市北区"]), ["大阪市北区"]));
  ok("要約に2区（、区切り）", eq(P.selectedWardsFromTexts(["大阪府：大阪市北区、大阪市西淀川区"], ["大阪市西淀川区", "大阪市北区"]), ["大阪市西淀川区", "大阪市北区"]));
  const g = read("itandi-guide.js");
  ok("案内は小窓の中・自分の枠と光の文字を読まない（スタッフの手順の文に区の名前がある）", /mine\(pe\) \|\| inDialog\(pe\)/.test(g) && /selectedWardsOnPage\(s\.wards\)/.test(g));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
