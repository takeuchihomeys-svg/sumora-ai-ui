// 地域・駅の段が「学習の記録」に残るか（2026-11-14）
//
// 竹内さん「ほかちゃんと録画したの学習できてるかな／自動モード学習できているか」
//
// 実測:
//   - 学習の元: 3180件・学んだ欄69個・押す順番11通り・画面ごとの手順 form/modal
//   - しかし `screen_flow.modal` に **所在地絞り込み / 区を選ぶ / 町字を選ぶ** が無い
//     （`確定してリストへ` だけがある）
//   - 記録の全種類は 15 種類で、地域・駅の段は **0件**
//   - 版 2.7.22 の写真234枚は **すべて shot_ops が空**（録画の経路で ops が空）
//
// 実行: node tests/chrome-extension/learn-area-in-record.test.js
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const SRC = path.join(ROOT, "chrome-extension");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
};

console.log("■ ① 地域の段が学習の記録に入る");
{
  const ps = read("page-script.js");
  t("_auditStepP が _audit の有無に関係なく記録する", /if \(!_audit\) return;[\s\S]{0,200}__axlxRecNoteName/.test(ps) || /__axlxRecNoteName[\s\S]{0,900}if \(!_audit\) return;/.test(ps));
  t("所在地絞り込みを開く段がある", /_auditStepP\('modal', 'area'\)/.test(ps));
  t("区を選ぶ段がある", /_auditStepP\('ward', null\)/.test(ps));
  t("町字を選ぶ段がある", /_auditStepP\('town', null\)/.test(ps));
  t("確定してリストへ の段がある", /_auditStepP\('modal_confirm'/.test(ps));
  t("日本語の名前に変換している", /modal: "所在地絞り込み"/.test(ps));
  t(" 区を選ぶ", /ward: "区を選ぶ"/.test(ps));
  t(" 町字を選ぶ", /town: "町字を選ぶ"/.test(ps));
}

console.log("■ ② 駅の段も入る");
{
  const ps = read("page-script.js");
  t("沿線・駅絞り込みを開く段", /_auditStepP\('station', '沿線・駅絞り込みを開く'\)/.test(ps));
  t("沿線を選ぶ段", /_auditStepP\('station_line', '沿線を選ぶ'\)/.test(ps));
  t("駅の設定へ進む段", /_auditStepP\('station_next_press'/.test(ps));
  t("日本語の名前に変換している", /station: "沿線・駅絞り込み"/.test(ps));
}

console.log("■ ③ 記録の入口（_recNoteName）が正しい");
{
  const rec = read("human-learn-record.js");
  t("関数がある", rec.includes("function _recNoteName"));
  t("window に公開している", rec.includes("window.__axlxRecNoteName = _recNoteName"));
  t("輪に積む", /_opsRing\.push\(\{ t: t, k: "step"/.test(rec));
  t("上限60", /OPS_RING_MAX = 60/.test(rec));
  t("拾った回数を数える（診断用）", rec.includes("_opsSeen++"));
  t("なぜ空かを残す（axlx_ops_diag）", rec.includes("axlx_ops_diag"));
  t("_opsSeen の宣言が1か所だけ", (rec.match(/var _opsSeen = 0;/g) || []).length === 1, (rec.match(/var _opsSeen = 0;/g) || []).length);
}

console.log("■ ④ 録画の経路でも ops を送る");
{
  const bg = read("background.js");
  t("録画が aaxlx-recent-ops を聞く", /axlx-recent-ops/.test(bg));
  /**
   * 2026-11-14 竹内さん「取り組む」:
   *   操作が取れなかった**理由**も DB に残すようにした（`k:"diag"` の1件を混ぜる）。
   *   → 「ops: _opsForSend」と「空なら理由を入れる」の両方を見る。
   */
  t("録画の撮影に ops を渡す",
    /ops: _opsForSend/.test(bg) && /if \(\(!ops \|\| !ops\.length\) && _lastOpsWhy\)/.test(bg));
  t("  ⚠ 操作が空でも「なぜ空か」を DB に残す（k:diag）", /k: "diag"/.test(bg));
  t("_takeShot が ops を job に渡す", /ops: Array\.isArray\(msg\.ops\) \? msg\.ops : null/.test(bg));
  t("送信の中身に shot_ops を入れる", /shot_ops: Array\.isArray\(job\.ops\)/.test(bg));
}

console.log("■ ⑤ 学習の束に地域の段が入る（シミュレーション）");
{
  // 地域の段を含む並びで、screen_flow.modal に地域の手順が出るか
  const brain = fs.readFileSync(path.join(ROOT, "app", "lib", "human-learn-brain.ts"), "utf8");
  t("screen_flow を束に入れている", brain.includes("screen_flow: shotLearn.screens"));
  t("learnFromShots を使っている", brain.includes("learnFromShots"));

  const shot = fs.readFileSync(path.join(ROOT, "app", "lib", "shot-learn.ts"), "utf8");
  t("所在地絞り込み を modal の印にしている", /所在地絞り込み\|沿線・駅絞り込み/.test(shot));
  t("区を選ぶ も印にしている", /区を選ぶ/.test(shot));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
