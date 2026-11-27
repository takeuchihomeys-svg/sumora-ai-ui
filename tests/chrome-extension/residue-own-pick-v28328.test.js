// 2.8.328（2026-11-27 竹内さん「ほかの手順の部分で邪魔される可能性もある」）:
//   残りがあれば止める関所が、この回で自分が押した駅・沿線を「前のお客さんの残り」と数えて止めていた。
//   ①沿線のみの関所（station_clear_only_gate）＝沿線だけの客は必ず止まる
//   ②沿線・駅の段の強制の確かめ（_advanceForcePlaceClearViaStationFirst）＝自分の沿線を押した後の2回目で止まる
//   ③詰まりの立て直し（同じ関数）＝入力の途中で自分の駅・沿線を数えて止まる
//   → 自分が押した物（__axlxLinePickedRun・_axStationPicked）は数えない。覚えは入力の開始で空に戻るので、入力前の関所は今まで通り全部数える。
const fs = require("fs"), path = require("path");
const ps = fs.readFileSync(path.join(__dirname, "../../chrome-extension/page-script.js"), "utf8").replace(/\r\n/g, "\n");
let pass = 0, fail = 0;
function ok(n, c, d) { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (d ? " :: " + d : "")); } }
function body(src, name) {
  const m = new RegExp("\\n( *)function " + name + "\\(").exec(src);
  if (!m) return "";
  const end = src.indexOf("\n" + m[1] + "}\n", m.index + 1);
  return end < 0 ? "" : src.slice(m.index + 1, end + m[1].length + 2);
}

const own = body(ps, "_isOwnPlacePick");
const adv = body(ps, "_advanceForcePlaceClearViaStationFirst");
const gate = body(ps, "_residueGateThen");
ok("自分が押した駅・沿線か（_isOwnPlacePick）がある", own.length > 0);
ok("沿線は __axlxLinePickedRun、駅・沿線は _axStationPicked で見る", /__axlxLinePickedRun\[k\]/.test(own) && /_axStationPicked\[k\]/.test(own));
ok("区・町は見ない（区の関所は今まで通り全部数える）", !/city_code|town_code/.test(own));

// 数える前に除く（n++ より前）
function skipsBeforeCount(src, guard) {
  const g = src.indexOf(guard), c = src.indexOf("n++");
  return g > 0 && c > g;
}
ok("強制の確かめは自分の物を数える前に除く", skipsBeforeCount(adv, "if (_isOwnPlacePick(nm, inp.value)) return;"));
ok("駅の関所（_residueGateThen station）も自分の物を数える前に除く", skipsBeforeCount(gate, 'if (kind === "station" && _isOwnPlacePick(nm, inp.value)) return;'));

// 覚えは入力の開始で空に戻る（入力前の関所では前の残りを全部数える）
const fillStartLp = ps.indexOf("window.__axlxLinePickedRun = {};");
const fillStartRp = ps.indexOf("\n    _resetPicked();");
const doResetGate = ps.indexOf('"モーダルを閉じる前", "station_modal_close_gate"');
ok("沿線の覚えは入力の開始で空に戻る", fillStartLp > 0);
ok("駅の覚えは入力の開始で空に戻る（_resetPicked）", fillStartRp > 0);
ok("入力前の駅の関所（_doReset のモーダルを閉じる前）は覚えを空にした後", doResetGate > fillStartLp && doResetGate > fillStartRp);
ok("止めの合図の1分の印は入力の開始で戻す（前の客の印で合図が出ないのを防ぐ）", /window\.__axlxLeftoverHalt = false; window\.__axlxResidueAbortAt = 0;/.test(ps));
ok("沿線のみの関所は駅の関所（_residueGateThen station）を通る", /_residueGateThen\("station", _closeAndSearch, "沿線のみ", "station_clear_only_gate"\)/.test(ps));

// 動きで確かめる: 関所の数え方を、フォームの checked と覚えを与えて走らせる
function runAdv(checked, linePicked, stPicked) {
  const doc = { querySelectorAll: (sel) => checked.filter((c) => sel.indexOf('"' + c.name + '"') >= 0).map((c) => ({ value: c.value })) };
  const win = { __axlxLinePickedRun: linePicked };
  const stopped = [];
  const fn = new Function("document", "window", "_axStationPicked", "_audit", "_auditStepP", "_leftoverAbort",
    own.replace(/^function _isOwnPlacePick/, "function _isOwnPlacePick") + "\n" + adv + "\nreturn _advanceForcePlaceClearViaStationFirst();");
  const r = fn(doc, win, stPicked, false, () => {}, (m) => stopped.push(m));
  return { r, stopped };
}
const a1 = runAdv([{ name: "route_id[]", value: "R1" }], { R1: 1 }, {});
ok("自分が押した沿線だけなら止めない（沿線のみ・2回目の確かめ）", a1.r === true && a1.stopped.length === 0);
const a2 = runAdv([{ name: "route_id[]", value: "R1" }, { name: "station_id[]", value: "S9" }], { R1: 1 }, { S9: {} });
ok("自分が押した駅・沿線だけなら止めない（詰まりの立て直し）", a2.r === true && a2.stopped.length === 0);
const a3 = runAdv([{ name: "route_id[]", value: "R1" }, { name: "route_id[]", value: "R7" }], { R1: 1 }, {});
ok("自分の物でない沿線が1本でもあれば止める（前の客の残り・人が選んだ物）", a3.r === false && a3.stopped.length === 1);
const a4 = runAdv([{ name: "station_id[]", value: "S1" }], {}, {});
ok("入力の開始直後（覚えが空）は残りを全部数えて止める", a4.r === false && a4.stopped.length === 1);

// 自己点検: 除く行を外した形は止まる（試験が効いている）
const advNoSkip = adv.replace("if (_isOwnPlacePick(nm, inp.value)) return;", "");
ok("自己点検: 除く行が無い形は検出される", !skipsBeforeCount(advNoSkip, "if (_isOwnPlacePick(nm, inp.value)) return;"));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
