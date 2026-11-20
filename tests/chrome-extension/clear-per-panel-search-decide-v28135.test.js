/**
 * 2.8.135 竹内さん「次のお客さんにいくために外す部分…直接入力」「外した後検索のところおすときも少し詰まっている」
 *   ① 前客の外しは箱ごと（間取り→絞り込み条件→所在地→残り）に「開ける→外す→確定」してから次へ
 *   ② 検索ボタン（div.go_search）は「決定」扱い・検索の押下と見えない作業には迷い/長い停止を入れない
 *   ③ 検索前の徒歩の確かめは、合っていれば列に積まずに押す
 */
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "../../chrome-extension/page-script.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../chrome-extension/manifest.json"), "utf8"));

let fail = 0;
function check(name, ok) {
  console.log((ok ? "✓ " : "✗ ") + name);
  if (!ok) fail++;
}

check("manifest 2.8.135 以降", /^2\.8\.(13[5-9]|1[4-9]\d)$/.test(manifest.version));
check("_AXLX_PAGE_VER 2.8.135 以降", /_AXLX_PAGE_VER = "2\.8\.(13[5-9]|1[4-9]\d)"/.test(src));

const unc = src.slice(src.indexOf("function _uncheckLeftoversThenRest"), src.indexOf("function _uncheckLeftoversThenRest") + 12000);
check("① _runUncheck が段（onlyRe/skipRe/after）を受ける", /var _runUncheck = function \(onlyRe, skipRe, after\)/.test(unc));
check("① 段の外しが終わったら次へ（_next）", /_settlePanelDebtThen\("前客クリア後のパネル清算"[\s\S]{0,200}_next\(\)/.test(unc));
// 2.8.146: 所在地の段は _stage ではなく1区ずつ外す係（_clearWardsOneByOne）
check("① 間取り→ペット→所在地の順の段", /_stage\('input\[name="room_layout_id\[\]"\]:checked'[\s\S]{0,200}_stage\('input\[name="eq_rm\[\]"\]:checked'[\s\S]{0,400}input\[name="city_code\[\]"\]:checked[\s\S]{0,900}_clearWardsOneByOne\(/.test(unc));
check("① 全部の箱を先に開ける旧形（chain.then(_runUncheck, _runUncheck)）が無い", !/chain\.then\(_runUncheck, _runUncheck\)/.test(unc));
check("① 残りの段は前の段の欄を除く", /_runUncheck\(null, \/\^\(room_layout_id\|eq_rm\|city_code\|town_code\)\/, _resetRest\)/.test(unc));
check("① 前の段で外したら『残0』の記録を付けない", /if \(!_clearedAny\)/.test(unc));

check("② go_search は decide", /go_search\|search_menu\/\.test\(String\(el\.className \|\| ""\)\)\) return "decide"/.test(src));
check("② 検索の押下に decide: true", /label: "click:検索", strictLo: true, sigma: 0\.55, decide: true/.test(src));
check("② enqueue に decide を持たせる", /decide: !!\(opts && opts\.decide\)/.test(src));
check("② 迷いは見えない作業と決定で 0", /!item\.el \|\| item\.decide\) \? 0 : _hesitateMs\(item\.el\)/.test(src));
check("② 長い停止も見えない作業と決定で 0", /if \(item && \(!item\.el \|\| item\.decide\)\) return 0;/.test(src));

check("③ 検索前の徒歩が合っていれば待たずに押す", /_walkOkNow[\s\S]{0,600}walk_seal_ok", "検索前 徒歩\+分数 OK（待たずに押す）"/.test(src));

if (fail) { console.log(fail + " 件 失敗"); process.exit(1); }
console.log("全部 OK");
