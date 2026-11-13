// 録画ループが多重に走らないこと（2026-11-14）
//
// 竹内さん「なんで自動モードまだかいぜんされていないのか／撮影したのはデータベースにはいっているよ」
//
// 実測:
//   写真はDBに入っている（200枚・URLも有効）。入っていないのは **shot_ops（操作の記録）**。
//   2分間で392枚・間隔 2ms/17ms（1.5〜3.5秒間隔なら最大80枚）。
//   → **録画ループが多重に走っていた**。
//
// 原因: `_recIsOn()` が `!!_recTimer` だけを見ていた。
//   Chrome は Service Worker を数十秒で止めるので、起き直すたびに `_recTimer` が null に戻る
//   → 復帰処理が「録画中」と知りながら**新しいループを追加**していた。
//   → 2本3本になり captureVisibleTab の制限（2回/秒）に当たり続け、
//     全部 capture_error（写真は失敗）になっていた。
//
// 実行: node tests/chrome-extension/rec-single-loop.test.js
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
};

console.log("■ ① 世代番号で1本だけにする");
{
  const bg = read("background.js");
  t("_recGen を持つ", /var _recGen = 0;/.test(bg));
  t("_recIsOn が世代で判定する", /return _recGen > 0;/.test(bg));
  t("_recTick が世代を受け取る", /async function _recTick\(gen\)/.test(bg));
  t("自分の世代でなければ止まる", /if \(gen != null && gen !== _recGen\) return;/.test(bg));
  t("次の1枚も世代を見て予約する", /if \(gen == null \|\| gen === _recGen\) \{[\s\S]{0,200}_recTick\(gen\)/.test(bg));
}

console.log("■ ② 開始・停止で世代を動かす");
{
  const bg = read("background.js");
  t("開始で世代を増やす", /_recGen = \(_recGen \|\| 0\) \+ 1;/.test(bg));
  t("開始で世代を保存する", /gen: gen/.test(bg));
  t("停止で世代を0に戻す", /_recGen = 0;/.test(bg));
}

console.log("■ ③ SW の起き直しでループを増やさない（今回の原因）");
{
  const bg = read("background.js");
  // 復帰処理の中に「すでに走っていれば何もしない」があるか
  const seg = bg.slice(bg.indexOf("SW が起き直した時: 録画中だったら続ける"));
  t("すでに走っていれば何もしない", /if \(_recGen > 0\) return;/.test(seg.slice(0, 2500)));
  t("保存された世代を引き継ぐ", /var gen = Number\(m\.gen\) \|\| 0;/.test(seg.slice(0, 2500)));
  t("復帰でも世代を渡して起動", /_recTick\(_recGen\)/.test(seg.slice(0, 2500)));
}

console.log("■ ④ 起動箇所はすべて世代を渡す");
{
  const bg = read("background.js");
  const calls = (bg.match(/_recTick\((?!gen\)|_recGen\))/g) || []);
  t("世代なしの _recTick() が無い", !/_recTick\(\s*\)/.test(bg), calls);
  const withGen = (bg.match(/_recTick\(gen\)|_recTick\(_recGen\)/g) || []);
  t("世代つきの起動が3か所", withGen.length >= 3, withGen.length);
}

console.log("■ ⑤ 撮影の制限（2回/秒）を守る");
{
  const bg = read("background.js");
  /**
   * 2026-11-14 竹内さん「データベースで連続で写真保存できてたんやから、間隔は前の細かいの方が良い」:
   *   間隔は **700ms**（細かい方）。capture_error の原因は多重ループであって間隔ではなかった。
   */
  t("間隔は700ms（細かい方・DBに連続保存できていた実績）", /CAP_MIN_GAP_MS = 700/.test(bg));
  t("制限に当たったら0.9秒待つ", /await new Promise\(function \(r\) \{ setTimeout\(r, 900\) \}\);/.test(bg));
}

console.log("■ ⑥ 録画が ops を聞くタブを間違えない");
{
  const bg = read("background.js");
  t("前に出ているタブを最優先", /active: true, lastFocusedWindow: true/.test(bg));
  t("全タブに聞いて回る", /for \(var ti = 0; ti < order\.length/.test(bg));
  t("取れた件数を残す", /axlx_rec_ops/.test(bg));
}

console.log("■ ⑦ 版が上がっている（Chrome が更新を認識する）");
{
  const m = JSON.parse(read("manifest.json"));
  t("2.7.23 以降", /^2\.7\.(2[3-9]|[3-9]\d)$/.test(m.version) || parseFloat(m.version.slice(4)) >= 23, m.version);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
