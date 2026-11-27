// app/lib/__tests__/reset-then-next-customer.test.ts
// 2026-11-18 竹内さん「リセットが壊れる原因の可能性高いので厳しければ外す形戻す」
//   2.8.105 で「リセットを先に押す」にしたが、リセットの後に入力が消えた（audit 1492・1494）→ 2.8.107 で戻した。
//   連続客の前の条件は1つずつ外す（リセットは押さない）。
//   あわせて 2.8.107 の上書き防止（bulk-dl・popup・background）も固定する。
//
// 実行: npx tsx app/lib/__tests__/reset-then-next-customer.test.ts
import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra).slice(0, 300))); }
};

const root = path.join(__dirname, "..", "..", "..");
const read = (f: string) => fs.readFileSync(path.join(root, "chrome-extension", f), "utf8");
const src = read("page-script.js");

console.log("連続客: リセットは押さない（1つずつ外す）");
ok("_tryResetButtonThen は無い", src.indexOf("_tryResetButtonThen") === -1);
ok("RESET_TEXTS（リセットを探す一覧）は無い", src.indexOf("RESET_TEXTS") === -1);
ok("点検 reset_btn を出さない", src.indexOf('"reset_btn"') === -1);
ok("従来の外しを直接呼ぶ", /\n        _uncheckLeftoversThenRest\(\);\r?\n/.test(src));
ok("決まりの注釈が戻した決定になっている", /リセットが壊れる原因の可能性高いので厳しければ外す形戻す/.test(src));

console.log("ページ: 番号の無い依頼でも入力中は断る");
const inc = src.slice(src.indexOf('if (!e.data || e.data.from !== "aixlinx-fill") return;'));
ok("どちらかに番号があれば比べる", /\(_runCidNow \|\| _incCid\)/.test(inc.slice(0, 2500)));
ok("片方が無い時も別人として扱う", /String\(_runCidNow \|\| ""\) !== String\(_incCid \|\| ""\)/.test(inc.slice(0, 2500)));

console.log("bulk-dl: 押し始めの後に次の入力が始まったら止める");
const bd = read("bulk-dl.js");
ok("_lastFillStartAt がある", /var _lastFillStartAt = 0;/.test(bd));
// 2026-11-26: 書き方が波かっこ付きに変わった（0831076bc）。動きは同じ（入力が始まった時だけ進める）
ok("入力開始で _lastFillStartAt を進める", /if \(on\) \{\s*_lastFillStartAt = _autofillStartedAt;/.test(bd));
ok("別タブの入力（session の印）でも止める", /_haltAutoPdfForNewFill\("fill_busy_changed"\)/.test(bd));
ok("1件ごとに確かめる", /function _autoPressNext\(list\) \{\s*if \(!_autoPdfRun\) return;\s*if \(_haltAutoPdfForNewFill\("press_next"\)\) return;/.test(bd));
ok("見る間に始まったら押さない", /look_cancel_new_fill/.test(bd));
const halt = bd.slice(bd.indexOf("function _haltAutoPdfForNewFill"), bd.indexOf("function _haltAutoPdfForNewFill") + 700);
ok("止める時に _autoFinish を使わない（次のお客さんの名前で完了を返さない）", halt.length > 0 && halt.indexOf("_autoFinish") === -1);
ok("回に startedAt を持たせる", /startedAt: _pressRunSince \|\| Date\.now\(\),/.test(bd));

console.log("popup: 画面を切り替える前に関所");
const pp = read("popup.js");
const oc = pp.slice(pp.indexOf("async function _openAndClickAutofill"), pp.indexOf("async function _openAndClickAutofill") + 3500);
const lockAt = oc.indexOf("_axPipelineSyncFromStorage()");
const openAt = oc.indexOf("openSiteView(c);");
ok("openSiteView より先にロックを見る", lockAt > 0 && openAt > lockAt, { lockAt, openAt });

console.log("background: 別のお客さんのロックを強制解除しない");
const bg = read("background.js");
ok("realpro の強制解除が無い", bg.indexOf('_releasePipelineLock("retry_after_pipeline_busy"') === -1);
ok("itandi の強制解除が無い", bg.indexOf('_releasePipelineLock("retry_after_pipeline_busy_itandi"') === -1);
ok("次のお客さんの前にロックを見て待つ", /var _lockOther = !!\(_lockJob && _lockJob\.customerId/.test(bg));

const manifest = JSON.parse(read("manifest.json"));
ok("manifest 2.8.107 以上", (() => { const p = String(manifest.version).split(".").map(Number); return p[0] > 2 || (p[0] === 2 && (p[1] > 8 || (p[1] === 8 && p[2] >= 107))); })(), manifest.version);

console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
