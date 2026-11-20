// tests/chrome-extension/hand-shape-raw-v28140.test.js
// 実行: node tests/chrome-extension/hand-shape-raw-v28140.test.js
// 2026-11-20 竹内さん「手の形も写真を読み取れば改善できる」→ 写真には OS のマウスが写らない（実物2枚で確認）。
//   選んだ形: 今の cs（押す系は pointer と決め打ち）は残し、本当の値を csr として別に足す。
//   ・csr はページの CSS の cursor そのまま（決め打ち・補完しない）
//   ・見えるカーソルの間（html.axlxOneCursor で cursor:none）も本当の値を読む
//   ・送る時・API で csr を落とさない／API は csr を補完しない
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..");
const src = fs.readFileSync(path.join(root, "chrome-extension", "human-learn-record.js"), "utf8").replace(/\r\n/g, "\n");
const api = fs.readFileSync(path.join(root, "app", "api", "human-motion", "route.ts"), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); }
}
function extractFn(name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + " が見つからない");
  let d = 0, i = start;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "{") d++;
    else if (c === "}") { d--; if (d === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

/** 偽のページ: html に axlxOneCursor がある間は cursor:none（pointer-ui.js の style と同じ） */
function makePage(cssCursor) {
  const cls = new Set();
  const html = { classList: { contains: (c) => cls.has(c), add: (c) => cls.add(c), remove: (c) => cls.delete(c) } };
  const win = { getComputedStyle: () => ({ cursor: cls.has("axlxOneCursor") ? "none" : cssCursor }) };
  const clsLine = (src.match(/var _OS_CLS_ALL = [^;]+;/) || [""])[0];
  const fn = new Function("document", "window", clsLine + "\n" + extractFn("_rawCssCursor") + "\nreturn _rawCssCursor;")({ documentElement: html }, win);
  return { fn, cls };
}

console.log("■ ① ページの CSS の cursor をそのまま");
{
  ok("  pointer → pointer", makePage("pointer").fn({}) === "pointer");
  ok("  ⚠ default は default のまま（押す系でも pointer にしない）", makePage("default").fn({}) === "default");
  ok("  auto → auto", makePage("auto").fn({}) === "auto");
  ok("  text → text", makePage("text").fn({}) === "text");
  ok("  url(...) 4 4, pointer → pointer（最後の言葉）", makePage("url(\"a.cur\") 4 4, pointer").fn({}) === "pointer");
  ok("  要素が無ければ null（補完しない）", makePage("pointer").fn(null) === null);
  ok("  変な値は null", makePage("url(x.cur)").fn({}) === null);
}

console.log("\n■ ② 見えるカーソルの間（cursor:none）も本当の値を読み、印は戻す");
{
  const p = makePage("pointer");
  p.cls.add("axlxOneCursor");
  ok("  ⚠ cursor:none ではなく pointer", p.fn({}) === "pointer");
  ok("  OS カーソルを隠す印は付いたまま戻る", p.cls.has("axlxOneCursor"));
  const q = makePage("default");
  ok("  印が無い時は付けない", q.fn({}) === "default" && !q.cls.has("axlxOneCursor"));
  ok("  2.8.140 までの印（axlx-one-cursor）も外して読む", /"axlx-one-cursor"/.test((src.match(/var _OS_CLS_ALL = [^;]+;/) || [""])[0]));
}

console.log("\n■ ③ 記録・送信・API でつながる");
{
  ok("  押した記録に csr を入れる", /cs: cs, csr: csr \}/.test(src));
  ok("  csr は _rawCssCursor から（決め打ちしない）", /var csr = _rawCssCursor\(el\);/.test(src));
  ok("  自動の重複を畳む時も csr を移す", /_FOLD_KEYS = \[[^\]]*"csr"/.test(src));
  ok("  送る行に csr を入れる", /if \(o\.csr\) row\.csr = String\(o\.csr\)\.slice\(0, 12\);/.test(src));
  ok("  ⚠ 今の cs の決め打ちは変えていない（統括の数字を変えない）", /if \(!cs && \(kd === "checkbox"[^\n]*cs = "pointer";/.test(src));
  ok("  API が csr を通す", /typeof r\.csr === "string" && \/\^\[a-z-\]\{1,12\}\$\/\.test\(r\.csr\) \? \{ csr: r\.csr \}/.test(api));
  const i = api.indexOf("r.csr");
  const seg = api.slice(i - 400, i + 120);
  ok("  ⚠ API は csr を補完しない（pointer を入れない）", !/csr\s*=\s*"pointer"|csr: "pointer"/.test(seg));
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
