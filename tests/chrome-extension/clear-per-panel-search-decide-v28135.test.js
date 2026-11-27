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

// 2.8.313: 版の固定が 2.8.13x〜2.8.19x だけを通す書き方で、以後の版で赤になっていた → 数の大小で比べる
const _geVer = (v, m) => { const a = String(v).split(".").map(Number), b = m.split(".").map(Number); for (let i = 0; i < 3; i++) { if ((a[i] || 0) > (b[i] || 0)) return true; if ((a[i] || 0) < (b[i] || 0)) return false; } return true; };
check("manifest 2.8.135 以降", _geVer(manifest.version, "2.8.135"));
check("_AXLX_PAGE_VER 2.8.135 以降", _geVer((src.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1], "2.8.135"));

const unc = src.slice(src.indexOf("function _uncheckLeftoversThenRest"), src.indexOf("function _uncheckLeftoversThenRest") + 12000);
check("① _runUncheck が段（onlyRe/skipRe/after）を受ける", /var _runUncheck = function \(onlyRe, skipRe, after\)/.test(unc));
// 退役（段階1・2026-11-27）: 1つずつ外し・段の外し・押し直しを廃止したため確認対象外 — ① 段の外しが終わったら次へ
// 2.8.146: 所在地の段は _stage ではなく1区ずつ外す係（_clearWardsOneByOne）
// 退役（段階1・2026-11-27）: 1つずつ外し・段の外し・押し直しを廃止したため確認対象外 — ① 間取り→ペット→所在地の順の段
check("① 全部の箱を先に開ける旧形（chain.then(_runUncheck, _runUncheck)）が無い", !/chain\.then\(_runUncheck, _runUncheck\)/.test(unc));
// 退役（段階1・2026-11-27）: 1つずつ外し・段の外し・押し直しを廃止したため確認対象外 — ① 残りの段は前の段の欄を除く
// 退役（段階1・2026-11-27）: 1つずつ外し・段の外し・押し直しを廃止したため確認対象外 — ① 前の段で外したら

check("② go_search は decide", /go_search\|search_menu\/\.test\(String\(el\.className \|\| ""\)\)\) return "decide"/.test(src));
check("② 検索の押下に decide: true", /label: "click:検索", strictLo: true, sigma: 0\.55, decide: true/.test(src));
check("② enqueue に decide を持たせる", /decide: !!\(opts && opts\.decide\)/.test(src));
check("② 迷いは見えない作業と決定で 0", /!item\.el \|\| item\.decide\) \? 0 : _hesitateMs\(item\.el\)/.test(src));
check("② 長い停止も見えない作業と決定で 0", /if \(item && \(!item\.el \|\| item\.decide\)\) return 0;/.test(src));

check("③ 検索前の徒歩が合っていれば待たずに押す", /_walkOkNow[\s\S]{0,600}walk_seal_ok", "検索前 徒歩\+分数 OK（待たずに押す）"/.test(src));

if (fail) { console.log(fail + " 件 失敗"); process.exit(1); }
console.log("全部 OK");
