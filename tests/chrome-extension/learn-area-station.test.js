// 「所在地絞り込み・沿線絞り込みが学習に残っているか」の試験（2026-11-13）
//
// 竹内さん「所在地絞り込みや沿線絞り込みの部分はどうなっているか。抜けていないのか」
//
// 実測（本番の記録）:
//   記録される操作は **15種類だけ**で、内訳は `左の`（235）と `(なし)`（843）。
//   **地域（所在地）の操作: 0種類 / 駅・沿線の操作: 0種類**。
//   `確定してリストへ｜span` はあるのに、**その前**（絞り込みを開く→区を押す→町字）が無い。
//
// 原因（2つ）:
//   ① 地域・駅は `waitForClick`（`clickByText` など）で押していて `enqueueHumanClick` を通らない
//      → `_opsRing`（学習の並び）に入らない
//   ② `_auditStepP` の先頭が `if (!_audit) return;` で、点検が無い回（自動モードの多く）は
//      段そのものが残らなかった
//
// 実行: node tests/chrome-extension/learn-area-station.test.js
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

console.log("■ ① 地域・駅の段が学習の並びに残る");
{
  const ps = read("page-script.js");
  const rec = read("human-learn-record.js");

  t("段を記録する時に学習の並びへも渡す", ps.includes("__axlxRecNoteName"));
  t("_audit が無くても学習の並びには残す", /try \{[\s\S]{0,400}__axlxRecNoteName[\s\S]{0,800}if \(!_audit\) return;/.test(ps));
  t("地域: 所在地絞り込みを開く段", /modal: "所在地絞り込み"/.test(ps));
  t("地域: 区を選ぶ段", /ward: "区を選ぶ"/.test(ps));
  t("地域: 町字を選ぶ段", /town: "町字を選ぶ"/.test(ps));
  t("地域: 確定してリストへ", /modal_confirm: "確定してリストへ"/.test(ps));
  t("駅: 沿線・駅絞り込みを開く段", /station: "沿線・駅絞り込み"/.test(ps));
  t("駅: 沿線を選ぶ段", /station_line: "沿線を選ぶ"/.test(ps));
  t("駅: 駅の設定へ進む段", /station_next_press: "駅の設定へ進む"/.test(ps));

  t("記録側に名前だけで積む入口がある", rec.includes("function _recNoteName"));
  t("外から呼べるように公開している", rec.includes("window.__axlxRecNoteName = _recNoteName"));
  t("同じ物を続けて積まない（120ms）", /last\.f === nmStr && t - Number\(last\.t \|\| 0\) < 120/.test(rec));
}

console.log("■ ② 駅の段を実際に記録している（STEP A・路線）");
{
  const ps = read("page-script.js");
  t("STEP A（開く）を段に残す", /_auditStepP\('station', '沿線・駅絞り込みを開く'\)/.test(ps));
  t("路線を押す段を残す", /_auditStepP\('station_line', '沿線を選ぶ'\)/.test(ps));
}

console.log("■ ③ 段の名前には条件の中身を入れない（区の名前など）");
{
  const ps = read("page-script.js");
  const seg = ps.slice(ps.indexOf("var _STEP_JA"), ps.indexOf("var _nm = _STEP_JA"));
  t("区の名前（大阪市〜区）を入れていない", !/大阪市/.test(seg));
  t("お客様の条件を入れていない", !/cond\./.test(seg));
}

console.log("■ ④ 積む中身は 名前・種類・時刻・間隔 だけ");
{
  const rec = read("human-learn-record.js");
  const seg = rec.slice(rec.indexOf("function _recNoteName"), rec.indexOf("window.__axlxRecNoteName"));
  t("時刻を持つ", /t: t/.test(seg));
  t("名前を持つ", /f: nmStr/.test(seg));
  t("間隔を持つ", /g: gap/.test(seg));
  t("種類は step 固定", /w: "step"/.test(seg));
  t("入力した中身を持たない", !/value/.test(seg));
}

console.log("■ ⑤ 上限で古い操作が消えない（地域は最初に押すので残る）");
{
  // 地域は検索の**最初**に押す。上限40で古い物から消えると地域が消える。
  // → 実際の記録は最長26件（上限に届いていない）ので今は消えていないが、
  //    長い検索では消えうる。地域の段は先頭側なので、上限を超えたら消える順序に注意。
  const rec = read("human-learn-record.js");
  t("古い物から捨てる（shift）", /while \(_opsRing.length > OPS_RING_MAX\) _opsRing.shift\(\)/.test(rec));
  t("上限を60に上げた（地域・駅の段が消えないように）", /OPS_RING_MAX = 60/.test(rec));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
