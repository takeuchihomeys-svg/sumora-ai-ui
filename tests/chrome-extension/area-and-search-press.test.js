// 地域が押されない・検索が押されない（2026-11-14）
//
// 竹内さん「今回も地域の部分押さなかったので、俺が押した」
//   「地域の部分はいるまえから地域だけ選択されていた」
//   「ボタンを押す順番もちゃんと所在地絞り込みを先に押して次に地域選択するようにする」
//   「なぜか今勝手に入力だけされていてボタンは押していない」
//   「そして検索も押してないからちゃんと検索押すようにする」
//
// DB（search_audits）に残っていた証拠:
//   - 段が null の回が大半（19:01・19:23・19:25・00:10 など）
//   - 22:11 の回だけ段63件。ただし page:search_look が19回続いた後に
//     page:stall_recover_search「条件あり → 検索を押す」で**180秒後**にやっと押していた
//   - 地域・駅の段（modal/ward/town/station）を含む回は **0件**
//   - checks に RESET_FAILED「_resetRest is not a function」
//
// 見つけた原因と直し:
//   ① hasModalWard が locationMode より**前**で計算されていた（var の巻き上げで undefined）
//      → 地域モーダルが一度も動かない。確定後に正しく直す。
//   ② _resetRest が var（関数式）で、呼ばれる時に未代入 → 関数宣言に変える
//   ③ _axSearchLookedOver の二重予約で search_look が19回続く → 予約済みなら予約しない
//   ④ 前の検索の区・町字がモーダルに残る → 開いた直後に全部外す
//
// 実行: node tests/chrome-extension/area-and-search-press.test.js
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
};

const ps = read("page-script.js");

console.log("■ ① 地域モーダルが動く（hasModalWard の巻き上げバグ）");
{
  t("hasModalWard を locationMode で計算していない（前の行）",
    !/var hasModalWard = !!!\(cond\.detail_ward\) \|\| \(hasCities && locationMode === "area"\);/.test(ps));
  // 確定後に正しく直しているか
  // 2.8.313: 間に場所XOR（_axApplyPlaceXor）が入って距離が伸びたので、窓ではなく「後ろにある」順序で見る
  {
    const iMode = ps.indexOf("var locationMode = decideLocationMode(cond);");
    const re = /hasModalWard = !!\(cond\.detail_ward\) \|\| \(hasCities && locationMode === "area"\);/g;
    re.lastIndex = Math.max(iMode, 0);
    const m = iMode >= 0 ? re.exec(ps) : null;
    t("locationMode の確定後に hasModalWard を直す", iMode >= 0 && !!m && m.index > iMode && m.index - iMode < 8000);
  }
  t("場所モードの判定を点検に残す", /_auditStepP\(["']location["'], locationMode\)/.test(ps));
  t("地域モーダルを使うかログに出す", /地域モーダル: " \+ \(hasModalWard \? "使う" : "使わない"\)/.test(ps));
}

console.log("■ ② 前の条件を消せる（_resetRest のバグ）");
{
  t("_resetRest が関数宣言", /function _resetRest\(\)/.test(ps));
  t("var _resetRest = function ではない", !/var _resetRest = function/.test(ps));
  // 2.8.313: _afterUncheck は無くなり、外し終わりの後続（after / _runUncheck の最後）に _resetRest を渡す形（関数宣言なので巻き上げで未代入にならない）
  t("外し終わりの後続から _resetRest を呼べる（_uncheckLeftoversThenRest / _runUncheck の後続）",
    /_next = typeof after === "function" \? after : _resetRest;/.test(ps) &&
    /_runUncheck\(null, [^\n]*?, _resetRest\)/.test(ps));
}

console.log("■ ③ 検索が押される（search_look の繰り返し）");
{
  t("予約済みなら二重に予約しない", /_nowMs - _lookAt < 6000/.test(ps));
  t("予約済みを点検に残す", /search_look_skip/.test(ps));
  t("タイマーは1本だけ（clearTimeout で消す）", /if \(window\._axSearchLookTimer\) clearTimeout\(window\._axSearchLookTimer\)/.test(ps));
  // 2.8.313: 間に長いコメントと Ajax 落ち着き待ち（_axAjaxSettleThen）が入り、clickSearch はその中で呼ばれる
  t("発火時にフラグと時刻を戻す",
    /window\._axSearchLookTimer = setTimeout\(function \(\) \{[\s\S]{0,300}window\._axSearchLookedOver = false;\s*window\._axSearchLookAt = 0;[\s\S]{0,1500}_axAjaxSettleThen\(function \(\) \{ try \{ clickSearch\(\); \}/.test(ps));
}

console.log("■ ④ 前の地域の選択を外してから選ぶ");
{
  t("モーダルを開いた直後に前の選択を外す", /_clearPrevAreaSelection/.test(ps));
  t("区を外す処理がある", ps.includes('input[name="city_code[]"]:checked'));
  t("町字を外す処理がある", ps.includes('input[name="town_code[]"]:checked'));
  t("外した事を点検に残す", /_auditStepP\(\s*_forceAll \? "area_prev_clear_force" : "area_prev_clear"/.test(ps));
  // 2.8.313 退役: 「checked を直接 false にして change を送る」は、2026-11-16 に「checked 直書き禁止・label カーソル押しだけ（_toggleCheckboxLikeHuman）」へ置き換わった
  //   （page-script.js _clearPrevAreaSelection のコメント／.cursor/rules/auto-clear-not-reset.mdc「直書きの checked=false 禁止」）。
}

console.log("■ ⑤ 押す順番（所在地絞り込み → 地域選択 → 確定）");
{
  t("STEP1: 所在地絞り込みを開く", /clickByText\(\['所在地絞り込み＋', '所在地絞り込み\+', '所在地絞り込み'\]\)/.test(ps));
  t("STEP2-3: 区を選ぶ", /clickWardPrecise/.test(ps));
  t("STEP5: 町字を選ぶ", /clickDetailArea/.test(ps));
  // 2.8.313: 確定は _pressConfirmListLikeHuman（中で「確定してリストへ」を探して人と同じ押し）に集約。地域モーダルの確定もここ
  t("最後に 確定してリストへ",
    /function _pressConfirmListLikeHuman\(why\) \{\s*var labels = \["確定してリストへ"/.test(ps) &&
    /_pressConfirmListLikeHuman\("所在地モーダル確定"\)/.test(ps));
  t("順番を点検に残す（modal→ward→town→modal_confirm）",
    /_auditStepP\(['"]modal['"], ['"]area['"]\)/.test(ps) && /_auditStepP\(['"]ward['"]/.test(ps) && /_auditStepP\(['"]town['"]/.test(ps) && /_auditStepP\(["']modal_confirm["']/.test(ps));
}

console.log("■ ⑥ 検索ボタンは左のサイドバーを押す（小窓の中ではない）");
{
  t("小窓の中のボタンを候補から外す", /closest\('\.this_window/.test(ps));
  t("押した方を点検に残す（which）", /which/.test(ps));
}

console.log("■ ⑦ 開く前に地域が入っていない（竹内さんの指摘）");
{
  t("モーダルを開く直前に前の選択を外す", /_clearBeforeOpen/.test(ps));
  t("区と町字の両方を外す（同じセレクタで）",
    ps.includes('input[name="city_code[]"]:checked, input[name="town_code[]"]:checked'));
  t("外した事を点検に残す（area_preclear）", /_forceAll \? "area_preclear_force" : "area_preclear"/.test(ps) && /_auditStepP\(\s*_forceAll \? "area_preclear_force"/.test(ps));
  t("直接チェックの分岐はモーダルでは通さない", /var _useDirectCities = \(locationMode === "area" && !hasModalWard\);/.test(ps));
  t("モーダルで選ぶ時は直接チェックしない事を残す", /area_skip_direct/.test(ps));
  // 直接チェックの呼び出しが _useDirectCities の中だけか
  const directCalls = (ps.match(/setCheckboxes\("city_code\[\]", cond\.city_codes\)/g) || []).length;
  t("city_code[] の直接チェックは1か所だけ", directCalls === 1, directCalls);
  t("その1か所はモーダル条件の外（_useDirectCities の中）", /if \(_useDirectCities\) \{[\s\S]{0,600}setCheckboxes\("city_code\[\]", cond\.city_codes\)/.test(ps));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
