// tests/chrome-extension/version-judge-v2775.test.js
// 実行: node tests/chrome-extension/version-judge-v2775.test.js
// 2026-11-15 竹内さん「古いか最新かの理解の部分ちゃんと細部まで細かく強化する」
//
//   ★ 実測で分かった事（統括が古い版に引っぱられていた）
//     `search_audits` 全1,197件のうち、**新しい版（v2.7.5x以降）は 8件だけ**で、
//     大半は**古い版（v2.5.91 など）**の記録だった。
//     統括はそれを混ぜて「完走率 18%」と言っていた＝**もう直した古い版の失敗**で判断していた。
//
//   → 版を**細部まで正しく**判定する:
//     ① 版の比較は**共通の1か所**（`parseExtVersion` / `compareExtVersion`）を使う
//        ⚠ 文字列で比べると `"2.7.9" > "2.7.74"` になる（桁の罠）
//     ② 桁が足りない版（`2.7`）は 0 で埋めて比べる（`2.7` = `2.7.0`）
//     ③ `v` 付き（`v2.7.1`）も読む
//     ④ 形が違う版（`(不明)`・空）は**古いとも新しいとも言わない**（別枠）
//     ⑤ 一番新しい版の**件数が少ない時（5件未満）は判断しない**
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..");
const src = fs.readFileSync(path.join(dir, "app", "lib", "learn-audit-summary.ts"), "utf8");
const gate = fs.readFileSync(path.join(dir, "app", "lib", "automation-pause-gate.ts"), "utf8");
const sup = fs.readFileSync(path.join(dir, "app", "lib", "learn-supervisor.ts"), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

console.log("■ ① 版の比較は共通の1か所を使う（独自実装を書かない）");
{
  ok("  automation-pause-gate から import している", /from "\.\/automation-pause-gate"/.test(src));
  ok("  parseExtVersion を使う", /parseExtVersion/.test(src));
  ok("  compareExtVersion を使う", /compareExtVersion/.test(src));
  ok("  ⚠ 独自の正規表現で版を切っていない", !/match\(\/\^\(\\d\+\)\\\.\(\\d\+\)\\\.\(\\d\+\)\//.test(src));
  ok("  共通側に parseExtVersion がある", /export function parseExtVersion/.test(gate));
  ok("  ⚠ 共通側は桁を 0 で埋めて比べる", /\(a\[i\] \?\? 0\) - \(b\[i\] \?\? 0\)/.test(gate));
}

console.log("\n■ ② 桁が足りない版も読む（2.7 = 2.7.0）");
{
  // 共通関数の決まりを写して確かめる
  const parse = (v) => {
    const s = String(v ?? "").trim();
    if (!/^\d{1,4}(\.\d{1,4}){0,3}$/.test(s)) return null;
    return s.split(".").map((x) => Number(x));
  };
  const cmp = (a, b) => {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d !== 0) return d; }
    return 0;
  };
  ok("  2.7 は読める", parse("2.7") !== null);
  ok("  ⚠ 2.7 = 2.7.0（同じ）", cmp(parse("2.7"), parse("2.7.0")) === 0);
  ok("  ⚠ 2.7 < 2.7.1", cmp(parse("2.7"), parse("2.7.1")) < 0);
}

console.log("\n■ ③ 文字列で比べない（2.7.9 vs 2.7.74 の罠）");
{
  const parse = (v) => String(v).split(".").map((x) => Number(x));
  const cmp = (a, b) => {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d !== 0) return d; }
    return 0;
  };
  ok("  ⚠ 文字列だと 2.7.9 > 2.7.74 になる（罠の確認）", "2.7.9" > "2.7.74");
  ok("  ⚠ 数字なら 2.7.9 < 2.7.74（正しい）", cmp(parse("2.7.9"), parse("2.7.74")) < 0);
}

console.log("\n■ ④ 読めない版は別枠（古いとも新しいとも言わない）");
{
  ok("  versions_unreadable を返す", /versions_unreadable/.test(src));
  ok("  ⚠ 「古いとも新しいとも言わない」と書いてある", /古いとも新しいとも言わない|新旧を決めない/.test(src));
  ok("  comparable で分けている", /comparable/.test(src));
  ok("  v 付きも読む（^v を除く）", /replace\(\/\^v\/i/.test(src));
}

console.log("\n■ ⑤ 新しい版の件数が少ない時は判断しない");
{
  ok("  ⚠ 5件未満では confident: false", /MIN_N_FOR_JUDGE = 5/.test(src) && /confident: topVer\.n >= MIN_N_FOR_JUDGE/.test(src));
  ok("  統括が「件数がまだ少ない」と言う", /件数がまだ少ない/.test(sup));
  ok("  ⚠ 新しい版の完走率を根拠に出す", /いまの版の実際の検索/.test(sup));
}

console.log("\n■ ⑥ 統括の言葉に版が出る（配線）");
{
  ok("  evidence に「いまの版の実際の検索」を足している", /label: "いまの版の実際の検索"/.test(sup));
  ok("  ⚠ 版の数字を出す（v2.7.74 のように）", /v\$\{String\(au\.latest\.version\)\}/.test(sup));
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
