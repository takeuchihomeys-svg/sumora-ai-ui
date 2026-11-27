// 2.8.328 段階1（2026-11-27 竹内さん「１つずつ外しを完全に消す」）: 入れる前の残りは外さず止める（構造を見る）
// 見るもの: ①消した関数が残っていない ②残りを見つけたら外さず止める関所がある（クリックが無い）
//          ③background が leftover_stuck で一括を止める ④自己点検（悪い入力を止める）
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..", "..", "chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8").replace(/\r\n/g, "\n");
const bg = fs.readFileSync(path.join(root, "background.js"), "utf8").replace(/\r\n/g, "\n");
let pass = 0, fail = 0;
function ok(n, c, d) { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (d ? " :: " + d : "")); } }

// 関数の本体を取り出す（function 宣言の字下げと同じ字下げの閉じ「}」まで）
function body(src, name) {
  const re = new RegExp("\\n( *)function " + name + "\\(");
  const m = re.exec(src);
  if (!m) return "";
  const indent = m[1];
  const start = m.index + 1;
  const close = "\n" + indent + "}\n";
  const end = src.indexOf(close, start);
  return end < 0 ? src.slice(start) : src.slice(start, end + close.length);
}
// 消した関数（呼び出し・宣言のどちらも無いこと）
const GONE = ["_clearChecksOneByOne", "_resetFieldsOneByOne", "_leftoverSweepNames", "_leftoverNamedInputs"];
function goneNames(src) {
  return GONE.filter((n) => new RegExp("(^|[^A-Za-z0-9_])" + n + "\\(").test(src));
}

ok("消した関数（1つずつ外し・段の外し）が page-script に残っていない", goneNames(ps).length === 0, goneNames(ps).join(","));
ok("ward/station の外し関所は1つずつ外す代わりに残りを見る（_residueGateThen）", /function _residueGateThen\(/.test(ps));
ok("入る前の残りを見る関所（_softResidueThen）が残りがあれば止める", /function _softResidueThen\(/.test(ps));
ok("駅・沿線の押して外す状態機械は関所1つになった（_advanceForcePlaceClearViaStationFirst は外さない）", /function _advanceForcePlaceClearViaStationFirst\(/.test(ps) && !/_uncheckVisibleStationsLikeHuman\(/.test(ps));

const gateBody = body(ps, "_residueGateThen");
ok("_residueGateThen は残りがあれば leftover_stuck で止めて外さない（クリックなし）", /_leftoverAbort\(/.test(gateBody) && /leftover_stuck:/.test(gateBody) && !/click/i.test(gateBody), gateBody.slice(0, 120));
const softBody = body(ps, "_softResidueThen");
ok("_softResidueThen は残りがあれば止め、無ければ先へ（クリックなし）", /_leftoverAbort\(/.test(softBody) && /done\(\)/.test(softBody) && !/click/i.test(softBody));
const advBody = body(ps, "_advanceForcePlaceClearViaStationFirst");
ok("駅・沿線の関所は残りを数えて、0なら true、あれば止めて false（クリックなし）", /return true;/.test(advBody) && /return false;/.test(advBody) && /_leftoverAbort\(/.test(advBody) && !/click/i.test(advBody));
ok("関所の止めた合図は1分に1回だけ（二重に送らない）", /__axlxResidueAbortAt/.test(advBody));
const unBody = body(ps, "_uncheckLeftoversThenRest");
ok("残ったチェックは外さず止める（_uncheckLeftoversThenRest は leftover_stuck）", /leftover_stuck:/.test(unBody) && !/\.click\(\)/.test(unBody) && !/enqueueHumanClick\(/.test(unBody), unBody.slice(0, 120));

// 段階2-A（2026-11-27）: 「沿線のみ」の駅残りは外さず関所で止める（その場の1つずつ外しは無い）
ok("沿線のみ（駅の指定なし）は残りの駅を関所で見る（1つずつ外さない）", /_residueGateThen\("station", _closeAndSearch, "沿線のみ", "station_clear_only_gate"\)/.test(ps) && !/"沿線のみ: 駅" \+ n \+ "をカーソルで外す"/.test(ps));
// 段階2-B（2026-11-27 リセットボタン基準）: 不要駅は外さず止める。止めた客の待ちは先へ進まない（停止フラグ）
ok("不要駅（今の客の駅指定の外）は数えて止める（1つずつ外さない）", !/_stClearN/.test(ps) && /_stResidue\.length/.test(ps) && /_leftoverAbort\("leftover_stuck: 前のお客さんの駅が残っている/.test(ps));
// 段階2-B（stop_all・2026-11-27）: 所在地・沿線の残りも外さず止める（人が選んだ物も含む）。自分が押した沿線だけ残す
// 残りは eq_rm（今の客の「外:ペット」条件を合わせる所）1か所だけ。前客の残りを1つずつ外す所は無い
ok("1つずつ外す（押して外す）はペットの条件合わせ1か所だけ", (ps.match(/_toggleCheckboxLikeHuman\([^)]*false\)/g) || []).length === 1 && /eq_rm\[\]/.test(ps));
ok("所在地を開く前・前客の地域・沿線の外しは、クリックせず止める", /_leftoverAbort\('leftover_stuck: 所在地の選択が残っている/.test(ps) && /_leftoverAbort\('leftover_stuck: 所在地の前のお客さんの地域が残っている/.test(ps) && /_lineResidueStop = true;/.test(ps) && /_auditStepP\('station_line_stop'/.test(ps));
ok("止めた客の待ち（waitForClick）は停止フラグが立つと先へ進まない", /function waitForClick[\s\S]{0,400}if \(window\.__axlxLeftoverHalt\) return;/.test(ps));
ok("停止フラグは止めた時に立ち、新しい客の入力を始める時に下りる", /window\.__axlxLeftoverHalt = true;/.test(ps) && /window\.__axlxLeftoverHalt = false;/.test(ps));
ok("background が leftover_stuck で一括を止める（次の客へ進まない）", /leftover_stuck:/.test(bg) && /_batchShouldStop = true/.test(bg) && /__BATCH_STOPPED__/.test(bg));

// ④ 自己点検: 悪い入力（消した関数が残っている・関所が無い）を本当に止めるか
{
  const bad = "\n  function _clearChecksOneByOne(x) { x.click(); }\n";
  ok("自己点検: 消した関数が残った入力は止まる（goneNames が検出する）", goneNames(bad).indexOf("_clearChecksOneByOne") >= 0);
  const noGate = "\n  function _somethingElse() {}\n";
  ok("自己点検: 関所が無い入力は止まる（body が空）", body(noGate, "_residueGateThen") === "");
  const clicky = "\n  function _residueGateThen(kind) { el.click(); }\n  }\n";
  ok("自己点検: クリックの入った関所は止まる（click 検出）", /click/i.test(body(clicky, "_residueGateThen")));
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
