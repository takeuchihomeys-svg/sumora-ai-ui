// 実行: node tests/chrome-extension/area-human-flow-v2697.test.js
// 2026-11-11 竹内さん「地域の部分も直接データ反映させるのではなくて
//   1 所在地絞り込み をおす 2 該当する地域をおす 3 確定してリストへ
//   この順番におすようにする。そうすればちゃんとできるようになるから」
//
//   ⚠ 旧は `detail_ward` が無いと**モーダルを使わず、チェックボックスに直接値を入れる**経路だった
//     （＝サイトに「押した」と伝わらない事がある）。city_codes だけでも**人が押す順**にする。
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const ps = read("page-script.js");

console.log("■ ① 区のコードだけでも「モーダルを使う」経路に入る");
{
  /**
   * 2026-11-14: `hasModalWard` は**暫定**を先に決め、`locationMode` の確定後に**再計算**する形に変えた。
   *   理由: `locationMode` は後で定義されるので、先に計算すると undefined になる（地域が動かないバグ）。
   */
  ok("hasModalWard は detail_ward が無くても city_codes があれば true（確定後に再計算）",
    /hasModalWard = !!\(cond\.detail_ward\) \|\| \(hasCities && locationMode === "area"\);/.test(ps));
  ok("直接チェックボックス方式は「モーダルを使わない時だけ」", /_useDirectCities = \(locationMode === "area" && !hasModalWard\)/.test(ps));
}

console.log("\n■ ② 人の順番: 所在地絞り込み → 該当の地域 → 確定してリストへ");
{
  // 1
  ok("① 所在地絞り込み を押す（waitForClick）", /STEP1: 「所在地絞り込み＋」が出るまで待ってクリック/.test(ps) && /clickByText\(\['所在地絞り込み＋', '所在地絞り込み\+', '所在地絞り込み'\]\)/.test(ps));
  // 2
  ok("③ 該当の区を押す（コードで探す）", /clickWardPrecise\(\[wardFull, wardShort\]\)/.test(ps));
  ok("  区を押した事を覚える（_noteWardPicked）", /_noteWardPicked\(codes\[ci2\]/.test(ps));
  // 3
  ok("③ 「確定してリストへ」を押す", /_findByText\(\['確定してリストへ', 'この条件で絞り込む', '決定'\]\)/.test(ps));
  ok("  押した事を点検に残す（modal_confirm）", /_auditStepP\('modal_confirm', '確定してリストへ'\)/.test(ps));
  ok("  カーソルを動かしてから押す（人の形）", /_humanPointerClick\(conf, function \(\) \{ try \{ conf\.click\(\); \} catch \(_\) \{\} \}\)/.test(ps));
  // 2026-11-11 竹内さん「確定してリストへ」: ×（とじる）より**確定を先に**押す
  ok("×より「確定してリストへ」を先に探す", (() => {
    const iFn = ps.indexOf("function closeAreaModal()");
    const seg = ps.slice(iFn, iFn + 1400);
    const iConf = seg.indexOf("確定してリストへ");
    const iX = seg.indexOf("this_window_close");
    return iConf > 0 && iX > 0 && iConf < iX;
  })());
}

console.log("\n■ ③ 既にチェック済みでも「確定してリストへ」まで進む");
{
  ok("チェック済みでもスキップして閉じる（確定を押す）", /選択済み → 選び直さず「確定してリストへ」まで進みます/.test(ps));
  ok("チェック済みの区も覚える（モーダルが閉じても場所ありと分かる）", /checkedInputs\.forEach\(function \(inp\) \{ _noteWardPicked\(inp\.value, ""\); \}\)/.test(ps));
}

console.log("\n■ ④ 駅も同じ5段階（沿線・駅絞り込み → 沿線 → 駅の設定へ進む → 駅 → 確定してリストへ）");
{
  // 2026-11-11 竹内さん「駅の場合は 1沿線・駅絞り込み 2該当する沿線 3駅の設定へ進む 4該当する駅 5確定してリストへ」
  ok("① 沿線・駅絞り込み を押す", /clickByText\(\['沿線・駅絞り込み＋', '沿線・駅絞り込み\+', '沿線・駅絞り込み'\]\)/.test(ps));
  ok("② 該当の沿線を押す（clickLineButtons）", /if \(hasRoutes\) clickLineButtons\(cond\.route_ids\)/.test(ps));
  ok("③ 「駅の設定へ進む」を押す", /clickByText\(\['駅の設定へ進む', '駅の設定へ進む›', '駅の設定へ進む>'\]\)/.test(ps));
  ok("④ 該当の駅を押す（selectStationsByName）", /selectStationsByName\(cond\.station_names\)/.test(ps));
  ok("⑤ 「確定してリストへ」を押す（駅モーダル）", /function closeStationModal\(\)/.test(ps) && /station_confirm/.test(ps));
  ok("⑤ は ×（とじる）より**確定を先に**押す", (() => {
    const iFn = ps.indexOf("function closeStationModal()");
    const seg = ps.slice(iFn, iFn + 1200);
    const iConf = seg.indexOf("確定してリストへ");
    const iX = seg.indexOf("this_window_close");
    return iConf > 0 && iX > 0 && iConf < iX;
  })());
  ok("「駅の設定へ進む」は押し終わるまで次へ進まない（_stationNextPressed）", /if \(_stationNextPressed\) \{/.test(ps));
  ok("駅ページに移ったかを確かめる（移っていなければ押し直す）", /まだ路線の一覧のまま/.test(ps));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
