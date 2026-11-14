// tests/chrome-extension/learn-from-run-v2769.test.js
// 実行: node tests/chrome-extension/learn-from-run-v2769.test.js
// 2026-11-14 竹内さん「直近画像から 画像を連続でみて左側の押したところのこと…データベースの入っている直近の録画から連続して統括が学習する」
//   「重要な発見を統括の部分で重要度上げておく」「これで画像の部分から学習できるようにする」
//
//   ★ 実測で確立した方法（このテストで固定する）
//     ① 写真全体を読ませると、AI は**中央に重なった拡張の小窓**を読む（実測）
//        ビジポイント / 近い順で検索 / リアプロで看護師募集 / Bandit利用で割合 / 全自動キーコピー
//     ② **左34%（検索条件のサイドバー）を切り出して 1200px に拡大**すると本物の欄が読める
//        マップ検索 / 駅からの移動手段(select) / 賃料(select) / 管理費・共益費含む(checkbox)
//     ③ **位置で束ねると失敗する**（同じ欄でも y が 0.5 ずれる＝写真ごとにスクロール位置が違う）
//        → **名前で束ねて中央値**を取る
//     ④ 名前が2枚以上で同じ物だけ採用（1枚だけは誤読）
//
//   ⚠ 1枚だけ読むと誤読する: 「磁性会社こらみ」「所在物件つじ込み」「駅徒歩駅中」「間賃履歴」
//   → **連続画像で多数決**すると「マップ検索7回」「賃料7回」「検索6回」のように確かな物だけ残る
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const dir = path.join(__dirname, "..", "..");
const src = fs.readFileSync(path.join(dir, "app", "lib", "shot-learn-server.ts"), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

/** 本体と同じ決まりを写す（本体の文字は ■④ で見る） */
function voteFieldsFromRuns(perShot, opt) {
  const minVotes = (opt && opt.minVotes) || 2;
  const acc = new Map();
  for (const fields of perShot) {
    const seen = new Set();
    for (const f of fields || []) {
      const nm = typeof (f && f.name) === "string" ? f.name.trim() : "";
      if (!nm) continue;
      if (seen.has(nm)) continue;
      seen.add(nm);
      if (!acc.has(nm)) acc.set(nm, { kinds: new Map(), xs: [], ys: [], n: 0 });
      const v = acc.get(nm);
      v.n++;
      const kd = String((f && f.kind) || "other");
      v.kinds.set(kd, (v.kinds.get(kd) || 0) + 1);
      if (typeof f.x === "number") v.xs.push(f.x);
      if (typeof f.y === "number") v.ys.push(f.y);
    }
  }
  const med = (a) => {
    if (!a.length) return 0;
    const s = a.slice().sort((p, q) => p - q);
    return Math.round(s[Math.floor(s.length / 2)] * 100) / 100;
  };
  const out = [];
  for (const [nm, v] of acc) {
    if (v.n < minVotes) continue;
    const kind = [...v.kinds.entries()].sort((a, b) => b[1] - a[1])[0][0];
    out.push({ name: nm, kind, x: med(v.xs), y: med(v.ys), votes: v.n });
  }
  return out.sort((a, b) => b.votes - a.votes);
}

console.log("■ ① 名前で束ねる（位置で束ねると失敗する）");
{
  // ⚠ 実測の形: 同じ欄なのに y が大きく違う（スクロール位置が違う）
  const shots = [
    [
      { name: "賃料", kind: "select", x: 0.07, y: 0.85 },
      { name: "検索", kind: "button", x: 0.17, y: 0.56 },
    ],
    [
      { name: "賃料", kind: "select", x: 0.09, y: 0.61 },
      { name: "検索", kind: "button", x: 0.17, y: 0.31 },
    ],
    [
      { name: "賃料", kind: "select", x: 0.07, y: 0.66 },
      { name: "検索", kind: "button", x: 0.17, y: 0.78 },
    ],
  ];
  const out = voteFieldsFromRuns(shots);
  ok("  ⚠ 3枚から2つの欄（同じ欄は1つにまとまる）", out.length === 2, out.length);
  const rent = out.find((o) => o.name === "賃料");
  ok("  賃料が3回", rent && rent.votes === 3, rent);
  ok("  ⚠ 位置は中央値（y は 0.61〜0.85 の真ん中）", rent && rent.y === 0.66, rent && rent.y);
  ok("  種類は select", rent && rent.kind === "select", rent && rent.kind);
}

console.log("\n■ ② 名前が読めない物は捨てる（null を学習に混ぜない）");
{
  const shots = [
    [{ name: null, kind: "button", x: 0.1, y: 0.2 }, { name: "検索", kind: "button", x: 0.17, y: 0.5 }],
    [{ name: null, kind: "button", x: 0.1, y: 0.2 }, { name: "検索", kind: "button", x: 0.17, y: 0.5 }],
  ];
  const out = voteFieldsFromRuns(shots);
  ok("  ⚠ null は残らない", out.every((o) => o.name !== null), out.map((o) => o.name));
  ok("  名前のある物だけ残る（検索1つ）", out.length === 1 && out[0].name === "検索", out);
}

console.log("\n■ ③ 1枚だけの名前は採用しない（誤読を学習に混ぜない）");
{
  const shots = [
    [{ name: "磁性会社こらみ", kind: "button", x: 0.17, y: 0.5 }],   // 誤読・1回だけ
    [{ name: "マップ検索", kind: "button", x: 0.17, y: 0.1 }],
    [{ name: "マップ検索", kind: "button", x: 0.17, y: 0.1 }],
  ];
  const out = voteFieldsFromRuns(shots);
  ok("  ⚠ 1回だけの誤読は残らない", !out.some((o) => o.name === "磁性会社こらみ"), out.map((o) => o.name));
  ok("  2回出た物は残る（マップ検索）", out.some((o) => o.name === "マップ検索" && o.votes === 2), out);
}

console.log("\n■ ④ 1枚の中で同じ名前を2回数えない");
{
  const shots = [[
    { name: "賃料", kind: "select", x: 0.07, y: 0.85 },
    { name: "賃料", kind: "select", x: 0.07, y: 0.9 },   // 同じ写真に2回（上下限）
  ], [
    { name: "賃料", kind: "select", x: 0.07, y: 0.85 },
  ]];
  const out = voteFieldsFromRuns(shots);
  const rent = out.find((o) => o.name === "賃料");
  ok("  ⚠ 1枚の中で重複しても1回と数える（2枚で2回）", rent && rent.votes === 2, rent);
}

console.log("\n■ ⑤ 本体（shot-learn-server.ts）が同じ決まりを持っている");
{
  ok("  ⚠ 左34%を切り出している", /LEFT_CROP_RATIO = 0\.34/.test(src));
  ok("  ⚠ 1200px に拡大している", /resize\(\{ width: 1200/.test(src));
  ok("  ⚠ 切り出した座標を元に戻している（x × 0.34）", /\* LEFT_CROP_RATIO/.test(src));
  ok("  ⚠ 左で読めない時だけ全体で読む（保険）", /左で読めなかった時だけ全体で読む/.test(src));
  ok("  voteFieldsFromRuns がある", /export function voteFieldsFromRuns/.test(src));
  ok("  ⚠ 名前で束ねている", /名前で束ねる/.test(src));
  ok("  ⚠ 位置のばらつきを実測した記録がある", /ばらつき 0\.50|y が 0\.47/.test(src));
  ok("  learnFromLatestRun がある", /export async function learnFromLatestRun/.test(src));
  ok("  ⚠ 大きい写真から読む（shot_w の降順）", /Number\(b\.shot_w\)[\s\S]{0,40}Number\(a\.shot_w\)/.test(src));
}

console.log("\n■ ⑥ 拡張側（小窓を隠す・押したら何が開いたかを送る）");
{
  const rec = fs.readFileSync(path.join(dir, "chrome-extension", "human-learn-record.js"), "utf8");
  ok("  小窓を隠す（_hideForShot）", /function _hideForShot|_hideForShot/.test(rec));
  ok("  ⚠ opened を shot_ops に載せている", /opened: o\.opened \|\| null/.test(rec));
}

console.log("\n■ ⑦ 構文");
{
  let okc = true;
  try { execFileSync(process.execPath, ["--check", path.join(dir, "chrome-extension", "human-learn-record.js")], { stdio: "pipe" }); }
  catch { okc = false; }
  ok("  human-learn-record.js の構文が通る", okc);
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
