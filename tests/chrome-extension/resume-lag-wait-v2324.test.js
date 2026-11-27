/**
 * 2.8.324 竹内さん「並べ替えのあとラグが起きるので時間を少し開けるのが理想」
 *   実測 search_audits #1673: 高→低を押して4秒後に読み直し後の入口が物件取得を始めた（猶予の15秒が消えていた）。
 *   → 読み直し後の入口（pressed_resume）も、猶予（15〜20秒）を取ってから一覧を取る。二重に始めない。
 * node tests/chrome-extension/resume-lag-wait-v2324.test.js
 */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); }
}

const dl = read("chrome-extension/bulk-dl.js");

console.log("■ 1. 読み直し後の入口は、すぐ始めず猶予を取る");
{
  const i0 = dl.indexOf("_sortResumeWaiting = true;");
  const i1 = dl.indexOf("setTimeout(function () {", i0);
  const i2 = dl.indexOf("}, _lagR);", i1);
  ok("猶予の印（_sortResumeWaiting）を立てる", i0 > 0);
  ok("猶予は _lagGraceMs() で取る（固定の数字の待ちにしない）", /var _lagR = _lagGraceMs\(\);/.test(dl.slice(i0 - 200, i0 + 200)));
  ok("猶予の時間で setTimeout する", i1 > i0 && i2 > i1 && /\}, _lagR\);/.test(dl.slice(i2 - 2, i2 + 12)));
  // 入口から最初の _startAutoPressRun() までに、即時の呼び出しが無い
  const entry = dl.indexOf("if (_sortPressedMeansList(_readSortPressedSync())) {");
  const firstStart = dl.indexOf("_startAutoPressRun();", entry);
  ok("入口の中で _startAutoPressRun() を直接呼ばず、猶予のあとに呼ぶ", entry > 0 && firstStart > i1 && firstStart > i2 - 600);
  ok("猶予の長さを点検に残す（sort_lag_grace・読み直し後）", /_liveDlStep\("sort_lag_grace", Math.round\(_lagR \/ 1000\) \+ "秒 読み直し後の猶予/.test(dl));
  ok("猶予の中で、もう一度の入口は二重に待たない（_sortResumeWaiting を見る）", /_sortResumeStarted \|\| _autoPdfRun \|\| _sortResumeWaiting\) return;/.test(dl));
}

console.log("■ 2. 一覧の押し始めは1回だけ（同じページの待ちと、読み直し後の待ちが重なっても）");
{
  const f = dl.indexOf("function _startAutoPressRun() {");
  ok("_startAutoPressRun の先頭で、走っている一覧があれば戻る", f > 0 && /function _startAutoPressRun\(\) \{[\s\S]{0,260}if \(_autoPdfRun\) return;/.test(dl.slice(f, f + 400)));
}

console.log("■ 3. 地図の文に猶予が入っている（手順書の③に自動で載る）");
{
  const map = read("app/lib/loop-flow-map.ts");
  const sortBlock = map.slice(map.indexOf('id: "sort"'), map.indexOf('id: "list_press"'));
  ok("sort の文に 15〜20秒 の猶予", /押したあとは15〜20秒あけてから一覧を取る/.test(sortBlock));
  ok("読み直しのあとも15〜20秒あける、と書いてある", /読み直しのあとも15〜20秒あけてから④物件取得/.test(sortBlock));
  ok("「並べ替え最中」のままにしない（パネルの決まり）が残っている", /「並べ替え最中」のままにしない/.test(sortBlock));
}

console.log(`\n結果: ${pass} 合格 / ${fail} 不合格`);
if (fail) process.exit(1);
