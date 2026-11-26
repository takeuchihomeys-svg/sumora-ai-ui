// 実行: node tests/chrome-extension/site-split-guard.test.js           … 見張る（違反があれば終了コード 1）
//       node tests/chrome-extension/site-split-guard.test.js --report … 今の混ざりの一覧を出す（書き換えない・終了コード 0）
// 2026-11-26 竹内さん「リアプロと ITANDI をごちゃごちゃにならないように仕組みで整理して行う。ここを徹底する。
//   ここを行わないとバグが起きる」
//
// 見るもの（決まりは tests/chrome-extension/site-split-rules.json）:
//   ① 箱の違反: realpro-*.js は ITANDI の名前を使わない／itandi-*.js は リアプロの名前を使わない
//      （reins-*.js は両方使わない）。注釈の行は数えない。app/lib・app/api の同じ名前の箱も同じ。
//   ② 両方入りの共有ファイル: リアプロと ITANDI の名前を両方使うファイルは、shared_mix に理由付きで登録したものだけ許す。
//      新しく両方を使うファイルができたら止まる（登録する時は「なぜ両方を扱うか」を書く＝意図して混ぜる）。
//   ③ 登録の古さ: shared_mix に入っているが、もう両方を使っていない物は「外せる」と出す（失敗にはしない）。
//
// 注意: 「混ざっている」＝直ちにバグ、ではない（popup.js のように両方を扱う共有の入口もある）。
//   ここで止めるのは「気づかないまま増える」事。両方を扱う所は、どのサイトの値がどこで切り替わるかを理由に書く。
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const RULES = JSON.parse(fs.readFileSync(path.join(__dirname, "site-split-rules.json"), "utf8"));
const REPORT = process.argv.includes("--report");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 600) : "")); }
}

// 注釈の行（// * /* #）は数えない。行の途中の注釈は残る（見張りは緩めにしない・誤検知は登録で扱う）
function codeOnly(src) {
  return src.replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l)).join("\n");
}
function tokenHits(code, names) {
  return names.filter((t) => new RegExp("(?<![A-Za-z0-9_])" + t + "(?![A-Za-z0-9_])").test(code));
}
function listFiles(dirRel, exts, recursive) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (recursive && e.name !== "__tests__" && e.name !== "node_modules") walk(p); continue; }
      if (exts.some((x) => e.name.endsWith(x)) && !e.name.endsWith(".d.ts")) out.push(p);
    }
  };
  const abs = path.join(ROOT, dirRel);
  if (fs.existsSync(abs)) walk(abs);
  return out.map((p) => path.relative(ROOT, p).split(path.sep).join("/"));
}

const files = [
  ...listFiles("chrome-extension", [".js"], false),
  ...listFiles(path.join("app", "lib"), [".ts"], true),
  ...listFiles(path.join("app", "api"), [".ts"], true),
];

const scan = files.map((rel) => {
  const code = codeOnly(fs.readFileSync(path.join(ROOT, rel), "utf8"));
  const base = path.posix.basename(rel);
  return {
    rel,
    realpro: tokenHits(code, RULES.realpro_only),
    itandi: tokenHits(code, RULES.itandi_only),
    box: Object.keys(RULES.box_forbidden).find((p) => base.startsWith(p)) || null,
  };
});

if (REPORT) {
  console.log("■ 両方を使うファイル（共有）");
  for (const s of scan) if (!s.box && s.realpro.length && s.itandi.length)
    console.log("  " + s.rel + "  realpro=[" + s.realpro.join(",") + "] itandi=[" + s.itandi.join(",") + "]" + (RULES.shared_mix[s.rel] ? "  登録済み" : "  ★未登録"));
  console.log("■ 箱の違反（サイト名の付いたファイルが他方の名前を使う）");
  for (const s of scan) {
    if (!s.box) continue;
    const bad = RULES.box_forbidden[s.box].flatMap((k) => (k === "realpro_only" ? s.realpro : k === "itandi_only" ? s.itandi : []));
    if (bad.length) console.log("  " + s.rel + "  使っている名前=[" + bad.join(",") + "]" + (RULES.box_exceptions[s.rel] ? "  例外登録済み" : "  ★違反"));
  }
  process.exit(0);
}

console.log("■ リアプロ・ITANDI 混ざりの見張り（" + files.length + " ファイル）");

// ① 箱の違反
const boxViolations = [];
for (const s of scan) {
  if (!s.box) continue;
  const forbidden = RULES.box_forbidden[s.box];
  const bad = [];
  if (forbidden.includes("realpro_only")) bad.push(...s.realpro.map((n) => "リアプロの名前: " + n));
  if (forbidden.includes("itandi_only")) bad.push(...s.itandi.map((n) => "ITANDI の名前: " + n));
  if (bad.length && !RULES.box_exceptions[s.rel]) boxViolations.push({ file: s.rel, bad });
}
ok("① 箱の違反なし（realpro-*→ITANDI名・itandi-*→リアプロ名・reins-*→両方 を使わない）", boxViolations.length === 0, boxViolations);

// ② 両方入りの共有ファイルは登録制
const newMix = scan.filter((s) => !s.box && s.realpro.length && s.itandi.length && !RULES.shared_mix[s.rel]);
ok("② 両方を使う共有ファイルは登録済みだけ（新しい混ざりは止める）", newMix.length === 0,
  newMix.map((s) => ({ file: s.rel, realpro: s.realpro, itandi: s.itandi })));

// ③ 登録の古さ（失敗にはしない）
const stale = Object.keys(RULES.shared_mix).filter((rel) => {
  const s = scan.find((x) => x.rel === rel);
  return !s || !(s.realpro.length && s.itandi.length);
});
if (stale.length) console.log("  ※ 登録を外せる（もう両方を使っていない）: " + stale.join(", "));

console.log("  " + (failed === 0 ? "✅" : "❌") + " 合格 " + passed + "・不合格 " + failed);
process.exit(failed === 0 ? 0 : 1);
