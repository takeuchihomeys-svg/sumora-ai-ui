// 実行: node tests/chrome-extension/human-learn-record-revive-v2745.test.js
// 2026-11-14 竹内さん「今実際おこなった 出来ていない部分学習おねがい」
//
//   ⚠ 2.7.44 でも 60枚すべて `shot_ops` が `k:"diag"` の1件、理由は `no_answer:tab1001211057`（同じタブ）。
//   ⚠ 原因: 旧は `L`（human-learn.js）が無い時も**印を先に立ててから** return していた:
//        window.__axlxHumanLearnRecord = true;   // ← 先に立てる
//        var L = ...AxlxHumanLearn; if (!L) return;   // ← 抜けても印が残る
//      さらに**拡張を更新すると開いたままのタブの古い記録係は無効になる**。
//      background は注入し直して助けようとするが、印が残っているので即 return ＝ 永久に復活しない。
//      → タブは sendMessage に答えない（＝ no_answer）。
//
//   直した事（このテストで固定する）:
//     ① 印は**初期化が終わってから**立てる（途中で抜けたら印を残さない＝注入し直せば直る）
//     ② メッセージの受け口は `L` が無くても**先に**付ける（必ず理由を答えられる）
//     ③ 答えに `why`（`no_learn_lib` / `dupe`）を入れる
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const src = read("human-learn-record.js");
const manifest = JSON.parse(read("manifest.json"));
/** コメント行を除いた「実際のコード」だけ（説明文に同じ言葉が出てくるので、それで誤判定しない） */
const code = src.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");

console.log("■ ① 印は初期化が終わってから立てる（途中で抜けたら印を残さない）");
{
  const iLib = code.indexOf("var L = (typeof self");
  const iEarlyFlag = code.indexOf("__axlxHumanLearnRecord = true");
  const iNoLib = code.indexOf('why: "no_learn_lib"');
  ok("ライブラリを取る行がある", iLib > 0);
  ok("ライブラリ取得より後に印を立てる", iEarlyFlag > iLib, { iLib, iEarlyFlag });
  ok("ライブラリが無い時は理由を残して抜ける", iNoLib > iLib);
  ok("ライブラリが無い時に印を立てない", code.indexOf("if (!L) {") > 0 && iEarlyFlag > code.indexOf("if (!L) {"));
}

console.log("\n■ ② 受け口はライブラリより先に付ける");
{
  const iListener = src.indexOf('msg.type !== "axlx-recent-ops"');
  const iLib = src.indexOf("var L = (typeof self");
  ok("axlx-recent-ops の受け口がある", iListener > 0);
  ok("⚠ 受け口がライブラリ取得より前（＝ライブラリ待ちでも答えられる）", iListener < iLib, { iListener, iLib });
  ok("先頭の受け口は状態の answer を使う", /__axlxHumanLearnRecState[\s\S]{0,400}?answer/.test(src.slice(0, 3000)));
}

console.log("\n■ ③ 理由（why）を答えに載せる");
{
  ok("no_learn_lib を返しうる", src.includes('"no_learn_lib"'));
  ok("dupe（二重起動）を返しうる", src.includes('"dupe"'));
  ok("booting（起動中）を返しうる", src.includes('"booting"'));
  ok("本体が動いている時は実際の操作を返す", /_recentOpsWithDiag\(\)[\s\S]{0,200}?sendResponse/.test(src) || src.includes("answer: function (sendResponse)"));
}

console.log("\n■ ④ 版が上がっている（Chrome が更新を拾える）");
{
  ok("version が 2.7.45 以上", Number(manifest.version.split(".")[2]) >= 45, manifest.version);
}

console.log("\n■ ⑤ manifest の並び（記録係は human-learn.js の後）");
{
  const cs = manifest.content_scripts || [];
  const recEntry = cs.find((c) => (c.js || []).includes("human-learn-record.js"));
  const libEntry = cs.find((c) => (c.js || []).includes("human-learn.js"));
  ok("記録係の entry がある", !!recEntry);
  ok("ライブラリの entry がある", !!libEntry);
  const recIdx = cs.indexOf(recEntry);
  const libIdx = cs.indexOf(libEntry);
  ok("⚠ ライブラリの entry が記録係より先（別 entry でも順に実行される）", libIdx <= recIdx, { libIdx, recIdx });
  ok("どちらも document_start", recEntry.run_at === "document_start" && libEntry.run_at === "document_start");
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
