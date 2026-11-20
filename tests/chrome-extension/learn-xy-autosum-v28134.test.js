// 2.8.134: 自動の押しに位置（要素の中の割合）を付ける・自動のまとめ（mode=aix）を MAIN world から届ける・学習の記録に客の名前を入れない
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log("✓ " + name); } else { fail++; console.log("✗ " + name + (extra !== undefined ? " " + JSON.stringify(extra).slice(0, 200) : "")); } }

const root = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const ps = read("page-script.js");
const rec = read("human-learn-record.js");
const pu = read("pointer-ui.js");
const mf = JSON.parse(read("manifest.json"));

function body(src, name) {
  const i = src.indexOf("function " + name + "(");
  if (i < 0) return "";
  let d = 0, j = src.indexOf("{", i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") d++;
    else if (src[k] === "}") { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  return "";
}

console.log("■ 版");
ok("_AXLX_PAGE_VER が manifest と同じ", new RegExp('var _AXLX_PAGE_VER = "' + mf.version.replace(/\./g, "\\.") + '"').test(ps));

console.log("\n■ 押した位置: _fireAt が実座標を渡す");
ok("_fireAt から _noteClickForLearn(el, undefined, { x: cx, y: cy })", /_noteClickForLearn\(el, undefined, \{ x: cx, y: cy \}\)/.test(ps));
{
  const fn = body(ps, "_noteClickForLearn");
  const sent = [];
  const win = { postMessage: (m) => sent.push(m) };
  const run = new Function("window", fn + "; return _noteClickForLearn;")(win);
  const el = {
    tagName: "INPUT", className: "btn_search big",
    getAttribute: (k) => (k === "name" ? "search_btn" : null),
    getBoundingClientRect: () => ({ left: 100, top: 200, width: 80, height: 20 }),
  };
  run(el, undefined, { x: 140, y: 205 });
  const m = sent[0] || {};
  ok("中を押したら fx/fy が付く（0.5/0.25）", m.fx === 0.5 && m.fy === 0.25, m);
  ok("大きさ・形も付く", m.bw === 80 && m.bh === 20 && m.bt === "input" && m.shape === "input.btn_search", m);
  run(el, undefined, { x: 400, y: 205 });
  ok("要素の外（±20%より外）なら位置を付けない", sent[1] && sent[1].fx === undefined, sent[1]);
  run(el);
  ok("座標が無い時は名前だけ（壊れない）", sent[2] && sent[2].name === "search_btn" && sent[2].fx === undefined, sent[2]);
}

console.log("\n■ 記録側: 送られた割合を優先して使う");
ok("axlx-rec-note-op で e.data.fx/fy を先に見る", /var _fxIn = Number\(e\.data\.fx\), _fyIn = Number\(e\.data\.fy\);/.test(rec) && /\} else try \{\s*var _elSyn = null;/.test(rec));

console.log("\n■ 自動のまとめ（mode=aix）を MAIN world から届ける");
ok("pointer-ui: __axlxNoteAutoOp が見えない時は axlx-note-auto-op を送る", /from: "axlx-note-auto-op", kind: "tap"/.test(pu));
ok("記録側: axlx-note-auto-op を受けて _autoOps に積む", /e\.data\.from !== "axlx-note-auto-op"/.test(rec) && /_autoOps\.push\(\{\s*t: t, k: String\(e\.data\.kind/.test(rec));
ok("頁を離れる時に 3手以上なら送る", /addEventListener\("pagehide", function \(\) \{\s*try \{\s*if \(_autoOps\.length >= 3 && !_autoSaving\)/.test(rec));

console.log("\n■ 学習の記録に客の名前を入れない");
ok("axlx-rec-note-name は段だけ（名前を付けない）", /name: \("今の客:" \+ String\(phase \|\| ""\)\)\.slice\(0, 40\)/.test(ps));
ok("名前付きの旧形が残っていない", !/"今の客:" \+ String\(phase \|\| ""\) \+ \(name \?/.test(ps));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
