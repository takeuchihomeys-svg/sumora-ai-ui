/**
 * `was`/`now` が「送信する時に捨てられていない」かのテスト（2026-11-15 竹内さん）
 *
 *   竹内さん「3組目の悠さんは駅での検索なので、前に残っていた
 *     泉大津市・西成区・住之江区・浪速区を外すために押している」
 *
 * ★ 2回続けて見落とした真の原因
 *   `_pushOp` で `was`/`now` を正しく積んでいたのに、**送信する時に捨てていた**。
 *   送信の変換（`_recentOps`）は `by` と `opened` だけを返していて、
 *   `was`/`now` が**入っていなかった**。
 *   実測: まりあさんの録画151枚で `was` が **0件**・2.7.79 の録画でも 0件。
 *
 * ★ なぜ気づきにくかったか
 *   `_pushOp` の中だけ見ると完璧に見える。**「積む」と「送る」の2段階**があり、
 *   2段目で落ちていた。→ テストで両方を確かめる。
 *
 * 実行: node tests/chrome-extension/was-sent-v2780.test.js
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "../..");
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("  ✗ " + name); } };

const rec = fs.readFileSync(path.join(ROOT, "chrome-extension/human-learn-record.js"), "utf8");

// ── ① 積む段階（_pushOp）────────────
t("押す前の状態（was）を積む", /_opObj\.was = wasChecked/.test(rec));
t("押した後の状態（now）を積む", /_opObj\.now = _chkEl\.checked/.test(rec));
t("label の中の input を探す", /querySelector\('input\[type="checkbox"\], input\[type="radio"\]'\)/.test(rec));

// ── ② 送る段階（_recentOps の変換）★ここが抜けていた ────────────
const sendBlock = (() => {
  const i = rec.indexOf("function _recentOps");
  if (i < 0) return "";
  // 2.8.313: 長い説明コメントが増えて固定の長さ（3000字）では届かない。次の関数（_recentOpsWithDiag）の手前までを見る
  const j = rec.indexOf("function _recentOpsWithDiag", i);
  return rec.slice(i, j > i ? j : Math.min(rec.length, i + 9000));
})();
// 2.8.313: 送り方は `was: o.was`（オブジェクトの中）から明示代入 `row.was = o.was`（2026-11-16 DB実測で was/now/cs キーが欠落→object spread に頼らず明示代入）に変わった。was を送る事は同じ
t("送る時に was を入れる", /row\.was = o\.was/.test(sendBlock), sendBlock.slice(0, 200));
t("送る時に now を入れる", /row\.now = o\.now/.test(sendBlock));
t("真偽だけ送る（typeof で確かめる）", /typeof o\.was === "boolean"/.test(sendBlock));

// ── ③ 二重に見落とさない（積む所と送る所の両方）────────────
t("積む所に was がある", (rec.match(/_opObj\.was/g) || []).length >= 1);
t("送る所にも was がある", (rec.match(/row\.was = o\.was/g) || []).length >= 1);

// ── ④ サーバーが受け取る ────────────
const route = fs.readFileSync(path.join(ROOT, "app/api/human-motion/route.ts"), "utf8");
t("サーバーが was を受け取る", /typeof r\.was === "boolean"/.test(route));
t("サーバーが now を受け取る", /typeof r\.now === "boolean"/.test(route));

// ── ⑤ 実測の失敗を残している ────────────
t("2回続けて見落としたと書いてある", /2回続けて見落とした|見落とした/.test(rec));
t("送る時に捨てていたと書いてある", /送信する時に捨てていた|送る時に捨て/.test(rec));

// ── ⑥ 構文 ────────────
let ok = true;
try { new Function(rec); } catch (e) { ok = false; console.log("    " + e.message); }
t("構文が通る", ok);

console.log(`\n${pass} 合格 / ${fail} 不備`);
if (fail) process.exit(1);
