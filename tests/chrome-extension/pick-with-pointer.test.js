// 竹内さんの報告3つ（2026-11-14）
//
//  ①「地域の部分ちゃんと１つずつマウスを動かしてクリックしてせんたくする。
//      今自動的に反映されてしまっている場面がある」
//  ②「検索した後物件ダウンロードする動きにうつっていなかった」
//  ③「徒歩選択したあとに、選択までできたが自動で消してしまっている」
//
// ①の原因: `_clickEl` が `el.click()` だけ（カーソルを動かさない）→ 一瞬で入る＝「自動で反映された」ように見える
// ②の原因: **私が入れた統括の関所**が `not_yet` で全部止めていた（現場が止まる）
// ③の原因: モーダルを開く前後で「選択済みを全部外す」→ **人が選んだ物まで消していた**
//
// 実行: node tests/chrome-extension/pick-with-pointer.test.js
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "..", "chrome-extension");
const ps = fs.readFileSync(path.join(SRC, "page-script.js"), "utf8");
const bd = fs.readFileSync(path.join(SRC, "bulk-dl.js"), "utf8");

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

console.log("■ ① 地域を1つずつマウスで動かして押す");
{
  const seg = ps.slice(ps.indexOf("function _clickEl"), ps.indexOf("function _clickEl") + 900);
  t("_clickEl がカーソルを動かしてから押す", /_humanPointerClick\(el/.test(seg), seg.slice(0, 200));
  t("  ⚠ 動かせなくても必ず押す（止まらない）", /function \(x\) \{ try \{ x\.click\(\); \}/.test(seg));
  t("  ⚠ 例外でも押す（最後の砦）", /try \{ el\.click\(\); \} catch \(__\)/.test(seg));
  t("  区・町字・間取りなど13か所が同じ道を使う", (ps.match(/, _clickEl,/g) || []).length >= 10, (ps.match(/, _clickEl,/g) || []).length);
  t("  ⚠ 2重に動かさない（setCheckboxes で _humanPointerClick を包まない）", !/enqueueHumanClick\(cb, function \(el\) \{ return _humanPointerClick/.test(ps));
}

console.log("\n■ ② 統括の関所が現場を止めない（not_yet では止めない）");
{
  const seg = bd.slice(bd.indexOf("function _supBlocksAuto"), bd.indexOf("function _supBlocksAuto") + 1800);
  t("not_yet では止めない", /verdict === "not_yet"/.test(seg) && /return false;/.test(seg), seg.slice(0, 400));
  t("almost でも止めない", /verdict === "almost"/.test(seg));
  t("  ⚠ unsafe の時だけ止める", /if \(verdict === "unsafe"\)/.test(seg));
  t("  止めない時も警告は出す（黙らない）", /_nudge\("ℹ️ 統括:/.test(seg));
}

console.log("\n■ ③ 人が選んだ地域を自動で消さない");
{
  t("自動で入れた物を覚える（__axAutoPicked）", ps.includes("__axAutoPicked"));
  t("  覚える関数がある（_noteAutoPicked）", /function _noteAutoPicked\(/.test(ps));
  const wSeg = ps.slice(ps.indexOf("function _noteWardPicked"), ps.indexOf("function _noteWardPicked") + 1400);
  t("  ⚠ _noteWardPicked で「自動で入れた区」を覚える", /_noteAutoPicked\("city", code\)/.test(wSeg), wSeg.slice(-300));
  t("  モーダルを開く前に「自動で入れた物だけ」外す", /area_preclear_keep/.test(ps));
  t("  開いた直後も「自動で入れた物だけ」外す", /area_keep_human/.test(ps));
  t("  ⚠ 覚えが無い（前のお客様の残り）時は今まで通り全部外す", /if \(_autoSet\)/.test(ps));
  t("自動入力の頭で覚えをリセット", /_resetAutoPicked\(\)/.test(ps));
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
