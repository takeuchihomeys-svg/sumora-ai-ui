// 実行: node tests/chrome-extension/itandi-line-match-v2622.test.js
// 2026-11-10 竹内さん「拡張がいれた（堺筋と検索欄に入れた）／ここの部分ちゃんと読み取れるかちゃんと表示できるようにすればこんなミス起きなくなる」
//   ITANDI の路線名は「高速電気軌道第6号線(大阪メトロ堺筋線)」のように長く、表記ゆれでラベルが見つからず路線が選ばれなかった。
//   ① textMatch が表記ゆれを吸収する（カッコの中だけ・外だけ・短い語）
//   ② clickLabel が見つからない時に特徴的な部分で探し直す
//   ③ 路線が見つからない時は、画面のラベル見本を必ず残す（点検が無い回でも console に出す）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

const ips = read("itandi-page-script.js");

console.log("■ ① textMatch が表記ゆれを吸収");
ok("textMatch にカッコの外・中で比べる処理がある", /var strip = function \(s\)/.test(ips) && /var inner = function \(s\)/.test(ips));
ok("3文字以上の短い語でも当たる", /n\.length >= 3 && t\.includes\(n\)/.test(ips));

// 実際に同じロジックを動かして確認
const norm = (s) => String(s).replace(/（/g, "(").replace(/）/g, ")").replace(/〜/g, "~").replace(/～/g, "~").replace(/　/g, " ").trim();
function textMatch(elText, search) {
  const t = norm(elText), n = norm(search);
  if (!n) return false;
  if (t === n || t.includes(n)) return true;
  const strip = (s) => s.replace(/\([^)]*\)/g, "").replace(/\s+/g, "");
  const inner = (s) => { const m = s.match(/\(([^)]*)\)/g); return m ? m.map((x) => x.replace(/[()]/g, "")).join("") : ""; };
  const nStrip = strip(n), nInner = inner(n), tStrip = strip(t), tInner = inner(t);
  if (nStrip && (tStrip === nStrip || tStrip.includes(nStrip) || nStrip.includes(tStrip))) return true;
  if (nInner && (tInner.includes(nInner) || t.includes(nInner))) return true;
  if (n.length >= 3 && t.includes(n)) return true;
  return false;
}
const LABEL = "高速電気軌道第6号線(大阪メトロ堺筋線)";
ok("正式名で当たる", textMatch(LABEL, "高速電気軌道第6号線(大阪メトロ堺筋線)") === true);
ok("「大阪メトロ堺筋線」で当たる", textMatch(LABEL, "大阪メトロ堺筋線") === true);
ok("「堺筋線」で当たる", textMatch(LABEL, "堺筋線") === true);
ok("「高速電気軌道第6号線」で当たる", textMatch(LABEL, "高速電気軌道第6号線") === true);
ok("別の路線（御堂筋線）には当たらない", textMatch("高速電気軌道第1号線(大阪メトロ御堂筋線)", "堺筋線") === false);
ok("別の路線（谷町線）には当たらない", textMatch("高速電気軌道第2号線(大阪メトロ谷町線)", "堺筋線") === false);

console.log("\n■ ② clickLabel が見つからない時に特徴的な部分で探し直す");
ok("特徴語での探し直しがある", /replace\(\/\\\(\[\^\)\]\*\\\)\/g, ""\)\.replace\(\/高速電気軌道第\\d\+号線\/g, ""\)/.test(ips));
ok("「大阪メトロ」などを外して比べる", /replace\(\/大阪メトロ\|大阪市高速軌道\|高速電気軌道\/g, ""\)/.test(ips));

console.log("\n■ ③ 路線が見つからない時にラベルの見本を残す");
ok("console に必ず出す（点検が無い回でも）", /console\.warn\('\[AX\] 路線が見つからない:/.test(ips));
ok("点検に line_miss を残す", /_itStep\("line_miss"/.test(ips));
ok("見本は12件", /_itLabelSample\(dlg, 12\)/.test(ips));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
