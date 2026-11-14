// 「次のページ」のボタンを実際の画面から学習する（2026-11-14）
//
// 竹内さん「次のページにいく次のボタンも押していない。実際のところから学習する」
//
// 見つけた穴:
//   ① `_findNextPageEl` は決め打ちの候補（td.pager → 文字 → CSS）だけで探していた
//      → 構造が変わると**見つからず「次ページなし＝完了」**と判断（実測: search_audits.result が空）
//   ② `clickNextPageBtn` は `el.click()` だけで、`onclick="pager(..)"` を持つ td では効かない事がある
//   ③ 押したら**進んだ前提**で state を進めていた → 押せていないと同じページを繰り返す
//   ④ 押せた場所を**覚えていなかった** → 毎回ゼロから探す
//
// 実行: node tests/chrome-extension/pager-learn.test.js
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "..", "chrome-extension");
const bd = fs.readFileSync(path.join(SRC, "bulk-dl.js"), "utf8");

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

console.log("■ ① 前に押せた「次」の印を先に使う（実際の画面から学習）");
{
  t("覚えた印の置き場（axlx_pager_learned）", bd.includes('"axlx_pager_learned"') || bd.includes("PAGER_KEY = \"axlx_pager_learned\""));
  t("  押せた要素の印を作る（_pagerMarkOf）", /function _pagerMarkOf\(el\)/.test(bd));
  const markSeg = bd.slice(bd.indexOf("function _pagerMarkOf"), bd.indexOf("function _pagerMarkOf") + 900);
  t("  印はタグ・class・文字・親のclass", /tag:/.test(markSeg) && /cls:/.test(markSeg) && /txt:/.test(markSeg) && /parentCls:/.test(markSeg), markSeg.slice(0, 120));
  t("  押せたら覚える（_rememberPager）", /function _rememberPager\(el\)/.test(bd));
  t("  同じ印は増やさない（exists）", /var exists = marks\.some/.test(bd));
  t("  覚えた印で探す（_findNextByLearned）", /function _findNextByLearned\(marks, cb\)/.test(bd));
  t("  _findNextPageEl が**最初に**覚えた印を使う", /if \(Array\.isArray\(_pagerMarksCache\)[\s\S]{0,400}return lh;/.test(bd));
  t("  ⚠ 見つからなければ今までの候補へ戻る", /フェーズ0: リアプロ専用 td\.pager/.test(bd));
  t("  押せた時に覚える（clickNextPageBtn から呼ぶ）", /_rememberPager\(el\);/.test(bd));
}

console.log("\n■ ② onclick を持つ td でも押せる（素の click だけに頼らない）");
{
  const seg = bd.slice(bd.indexOf("function clickNextPageBtn"), bd.indexOf("function clickNextPageBtn") + 3000);
  t("素の click", /try \{ el\.click\(\); \} catch/.test(seg));
  t("  onclick を直接呼ぶ", /var oc = el\.getAttribute && el\.getAttribute\("onclick"\)/.test(seg));
  t("  中の <a> も押す", /querySelector\("a\[href\]"\)/.test(seg));
}

console.log("\n■ ③ 押した後に「本当に進んだか」を確かめる");
{
  t("確かめる関数（_verifyNextPage）", /function _verifyNextPage\(urlBefore, maxMs\)/.test(bd));
  t("  URL が変わったかを見る", /location\.href\) !== urlBefore/.test(bd));
  t("  時間切れで false", /Date\.now\(\) - t0 > limit[\s\S]{0,60}resolve\(false\)/.test(bd));
  t("tryNext が進んだかを待つ", /_verifyNextPage\(_urlBefore, 7000\)\.then\(function \(moved\)/.test(bd));
  t("  進まなければ止める（同じページを繰り返さない）", /if \(!moved\) \{[\s\S]{0,600}clearAutoSendState\(\)/.test(bd));
  t("  進まなかった事を記録に残す（next_page_not_moved）", /next_page_not_moved: true/.test(bd));
}

console.log("\n■ ④ 見つからなかった時に「何が並んでいたか」を残す（推測で直さない）");
{
  t("ページャーの中身を記録する（_pagerDiagnostics）", /function _pagerDiagnostics\(\)/.test(bd));
  t("  ページャーらしい入れ物を集める", /\[class\*="pager"\], \[class\*="pagination"\]/.test(bd));
  t("  「最初〜次〜最後」を含む入れ物も拾う（画面の下）", /\/最初\/\.test\(t\) && \/\(次\|最後\)\//.test(bd));
  t("  「次」らしき物を全部ひろう（candidates）", /nextLike\.push/.test(bd));
  t("  見つからない時に残す（next_not_found）", /_tmark\("next_not_found"/.test(bd));
  t("  外から点検できる（__axPagerDiag）", /__axPagerDiag = _pagerDiagnostics/.test(bd));
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
