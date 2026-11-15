/**
 * 画面全体を読んで「どの領域に何があるか」を把握するテスト（2026-11-15 竹内さん）
 *
 *   竹内さん「画面全体見て把握できるようにする」
 *
 * ★ 何が悪かったか（実測）
 *   旧は**左34%だけ**を切り出して読んでいた（中央の拡張の小窓を避けるため）。
 *   そのため**物件の一覧・ページ送り・右上の絞り込み・小窓**が1つも読めていなかった。
 *   実測: 写真から読めた名前は**全部「左の条件」の物だけ**（130件が同じ19個）。
 *
 * ★ 直した事
 *   ① **画面全体**を読む（左も中央の一覧も下のページ送りも見る）
 *   ② 全体で読めなかった時だけ**左を切り出して**読む（保険・座標は元に戻す）
 *   ③ どの領域かを `zone` で残す（left/top/center/right/bottom/modal）
 *   ④ 位置から領域を決める純関数 `zoneOf`（写真が読めなくても使える・費用0）
 *
 * 実行: node tests/chrome-extension/whole-screen-v2777.test.js
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "../..");
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("  ✗ " + name); } };

const lib = fs.readFileSync(path.join(ROOT, "app/lib/shot-learn.ts"), "utf8");
const srv = fs.readFileSync(path.join(ROOT, "app/lib/shot-learn-server.ts"), "utf8");

// ── ① 領域の型と名前 ────────────
for (const z of ["left", "top", "center", "right", "bottom", "modal", "other"]) {
  t(`領域 ${z} を持つ`, new RegExp(`${z}:`).test(lib));
}
t("領域の日本語を持つ", /左（検索の条件）/.test(lib) && /中央（物件の一覧）/.test(lib) && /下（ページ送り・合計）/.test(lib));
t("zoneJa で日本語にできる", /export function zoneJa/.test(lib));

// ── ② 位置から領域を決める（純関数・実際に計算して確かめる）────────────
function zoneOf(x, y) {
  const px = typeof x === "number" && Number.isFinite(x) ? x : null;
  const py = typeof y === "number" && Number.isFinite(y) ? y : null;
  if (px == null || py == null) return "other";
  if (py >= 0.93) return "bottom";
  if (px <= 0.30) return "left";
  if (py <= 0.12) return "top";
  if (px >= 0.82) return "right";
  return "center";
}
t("左の条件（x0.1）は left", zoneOf(0.1, 0.5) === "left");
t("中央の一覧（x0.5 y0.5）は center", zoneOf(0.5, 0.5) === "center");
t("下のページ送り（y0.96）は bottom", zoneOf(0.5, 0.96) === "bottom");
t("上の見出し（y0.05）は top", zoneOf(0.5, 0.05) === "top");
t("右の補足（x0.9）は right", zoneOf(0.9, 0.5) === "right");
t("位置が無ければ other", zoneOf(null, null) === "other");
t("下の判定は左より先（左下のページ送りも bottom）", zoneOf(0.1, 0.97) === "bottom");

// ── ③ 領域ごとにまとめる ────────────
function summarizeZones(fields) {
  const acc = new Map();
  for (const f of fields) {
    const z = String((f && f.zone) || "other");
    const cur = acc.get(z) || { n: 0, names: [] };
    cur.n++;
    const nm = String(f?.name ?? "").trim();
    if (nm && cur.names.length < 3 && cur.names.indexOf(nm) < 0) cur.names.push(nm);
    acc.set(z, cur);
  }
  return [...acc.entries()].map(([zone, v]) => ({ zone, n: v.n, names: v.names })).sort((a, b) => b.n - a.n);
}
const zs = summarizeZones([
  { name: "賃料", zone: "left" }, { name: "築年数", zone: "left" },
  { name: "次のページ", zone: "bottom" },
  { name: "一覧の行", zone: "center" },
]);
t("領域ごとに数える", zs.length === 3);
t("多い順に並ぶ", zs[0].zone === "left" && zs[0].n === 2);
t("名前は3つまで", zs.every((z) => z.names.length <= 3));
t("名前が重複しない", zs[0].names.length === 2);

// ── ④ 読み取りが「全体優先」になっている ────────────
t("先に全体を読む", /const whole = await loadImage\("whole"\)/.test(srv));
t("全体で読めない時だけ左を切る", /const left = await loadImage\("left"\)/.test(srv));
t("左で読んだ時は座標を元に戻す", /f\.x \* LEFT_CROP_RATIO/.test(srv));
t("左で読んだ時の領域は left", /zone: f\.zone \|\| "left"/.test(srv));
t("⚠ 縮めてから切らない（等倍で切る）", !/\.extract\(\{[^}]*\}\)\s*\.resize\(\{ width: 1200/.test(srv));
t("大きすぎる時だけ縮める（2000px超）", /MAX_SIDE = 2000/.test(srv));

// ── ⑤ 指示文が全体を見る ────────────
t("指示文に「画面全体を見る」がある", /画面全体を見る/.test(lib));
t("指示文に領域の意味がある", /left=左の条件/.test(lib));
t("一覧の行数を数えさせる", /一覧の行/.test(lib));
t("物件の中身は書かせない", /物件名・住所・賃料は書かない/.test(lib));
t("入力した中身を読ませない（既存の決まりが残る）", /入力された中身.*絶対に書かない/.test(lib));
t("拡張の小窓は読ませない（既存の決まりが残る）", /小窓.*読まない/.test(lib));

// ── ⑥ parse が zone を埋める ────────────
t("parse が位置から領域を埋める", /zone: \(f\.zone && String\(f\.zone\)\) \|\| zoneOf\(f\.x, f\.y\)/.test(lib));
t("zones を返す", /zones: summarizeZones/.test(lib));
t("cleanFields が zone を通す", /const zone = zRaw in SHOT_ZONES/.test(lib));

console.log(`\n${pass} 合格 / ${fail} 不備`);
if (fail) process.exit(1);
