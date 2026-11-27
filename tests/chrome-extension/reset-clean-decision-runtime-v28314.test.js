/**
 * 2.8.314 「リセットで空と確かめた直後は、客切替でも強制の全部外しを立てない」の実行試験（page-script.js の実物のコードを動かす）。
 *
 *   これまでの試験は「コードの文字列がある」と「helper 単体」だけだった（fillRealpro を偽の画面で通す試験が無かった）。
 *   fillRealpro は約1400行で偽の画面では動かせないため、判断の3か所（_willClear／_switchedCust／_needForcePlace）の
 *   実物の文をそのまま取り出して、偽の window・印・フォームの状態で動かし、旗と記録を確かめる。
 *   → 判断の文が書き換わって取り出せなくなったら、試験が赤になる（黙って通らない）。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..", "..");
const ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8").replace(/\r\n/g, "\n");

let pass = 0, fail = 0;
function ok(name, c, extra) { if (c) pass++; else { fail++; console.log("NG: " + name + (extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 260))); } }
function fnSrc(src, header) {
  const i = src.indexOf(header);
  if (i < 0) return "";
  const s = src.slice(i);
  const e = s.indexOf("\n  }\n");
  return e < 0 ? s : s.slice(0, e + 5);
}
function between(a, b, from) {
  const i = ps.indexOf(a, from || 0);
  if (i < 0) return null;
  const j = ps.indexOf(b, i);
  if (j < 0) return null;
  return { src: ps.slice(i, j), end: j };
}

console.log("\n■ 実物の文を取り出せるか（書き換わったらここで赤）");
const fresh = fnSrc(ps, "  function _axResetCleanFresh() {");
const helper = fnSrc(ps, "  function _resetCleanSkipsForcePlace(stamp) {");
const blkWill = between("var _willClear = false;", "if (_willClear) {");
const blkSwitch = between("var _swPrev = String(window.__axlxSwitchPrevCid", "_resetAutoPicked();");
const blkNeed = between("var _needForcePlace = !!window.__axlxForceClearAllPlace;", "window.__axlxLineForceClearedOnce = false;");
ok("_axResetCleanFresh を取り出せた", fresh.length > 50);
ok("_resetCleanSkipsForcePlace を取り出せた", helper.length > 50);
ok("_willClear の判断を取り出せた", !!blkWill, null);
ok("_switchedCust の判断を取り出せた", !!blkSwitch, null);
ok("_needForcePlace の判断を取り出せた", !!blkNeed, null);
if (!blkWill || !blkSwitch || !blkNeed) { console.log(`\n${pass} pass / ${fail} fail`); process.exit(1); }

/** 1回分の判断を実物の文で動かして、旗と記録を返す */
function run(o) {
  const steps = [];
  const store = {};
  if (o.mark === "fresh") store.axlx_reset_clean = JSON.stringify({ at: Date.now() - 2000, cid: "p" });
  if (o.mark === "old") store.axlx_reset_clean = JSON.stringify({ at: Date.now() - 11 * 60 * 1000, cid: "p" });
  const win = {
    sessionStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } },
    __axlxSwitchPrevCid: o.prev, __axlxForceClearAllPlace: o.force || undefined, __axlxPostSendClearGap: o.gap || undefined,
  };
  const ctx = {
    window: win, _fillCustomerId: o.next, _AX_RESET_CLEAN_KEY: "axlx_reset_clean", Date, JSON, String,
    _resetFormState: () => ({ empty: o.empty !== false }),
    _audit: {}, _auditStepP: (k) => steps.push(k), _publishNowAction: () => {}, _resetAutoPicked: () => {},
  };
  vm.createContext(ctx);
  const code = [
    fresh, helper,
    "var _willClear = false;",
    blkWill.src.replace("var _willClear = false;", ""),
    "this.__willClear = _willClear;",
    "try {" + blkSwitch.src.replace(/\n\s*_resetAutoPicked\(\);\s*$/, ""),
    "var _needForcePlace = !!window.__axlxForceClearAllPlace;" + blkNeed.src.slice("var _needForcePlace = !!window.__axlxForceClearAllPlace;".length),
  ].join("\n");
  try { vm.runInContext(code, ctx, { filename: "page-decision.js" }); }
  catch (e) { return { err: String(e && e.message || e), steps }; }
  return {
    steps, force: !!win.__axlxForceClearAllPlace, needWard: !!win.__axlxNeedClearWard, needStation: !!win.__axlxNeedClearStation,
    willClear: !!ctx.__willClear, markLeft: "axlx_reset_clean" in store,
  };
}

console.log("\n■ 客が変わった回（前客 c1 → 今客 c2）");
{
  const a = run({ prev: "c1", next: "c2", mark: "fresh", empty: true });
  ok("実物の文が動く（構文・参照の誤りが無い）", !a.err, a);
  ok("リセットで空と確認済み＋今も空 → 強制の全部外しの旗を立てない", a.force === false && a.needWard === false && a.needStation === false, a);
  ok("  外す予告（_willClear）も立てない（段が clear にならない）", a.willClear === false, a);
  ok("  記録に reset_clean_no_force_place が出て、place_redo は出ない", a.steps.includes("reset_clean_no_force_place") && !a.steps.includes("place_redo"), a.steps);
  ok("  印（axlx_reset_clean）はここでは消さない（後ろの leftover 判定が使う）", a.markLeft === true, a);

  const b = run({ prev: "c1", next: "c2", mark: "none" });
  ok("印が無い → 今まで通り強制で外す", b.force === true && b.needWard === true && b.needStation === true && b.willClear === true, b);
  ok("  記録は place_redo（reset_clean_no_force_place は出ない）", b.steps.includes("place_redo") && !b.steps.includes("reset_clean_no_force_place"), b.steps);

  const c = run({ prev: "c1", next: "c2", mark: "fresh", empty: false });
  ok("印はあるが今は空でない → 今まで通り強制で外す（残りを外し忘れない）", c.force === true && c.willClear === true && c.steps.includes("place_redo"), c);

  const d = run({ prev: "c1", next: "c2", mark: "old", empty: true });
  ok("印が10分より古い → 今まで通り強制で外す", d.force === true && d.steps.includes("place_redo"), d);
}

console.log("\n■ 他の所が強制を立てている回は省かない（2.8.314）");
{
  const a = run({ prev: "c1", next: "c2", mark: "fresh", empty: true, force: true, gap: true });
  ok("送付後の外し未完（force＋gap）は印があっても強制のまま", a.force === true && a.needWard === true && a.needStation === true && a.willClear === true, a);
  ok("  『省いた』印は出ない（強制が立っているのに省いたと記録しない）", !a.steps.includes("reset_clean_no_force_place") && a.steps.includes("place_redo"), a.steps);
  const b = run({ prev: "c1", next: "c2", mark: "fresh", empty: true, gap: true });
  ok("gap だけ立っていれば外す予告（_willClear）は立つ", b.willClear === true, b);
}

console.log("\n■ 客が変わらない回・初回（今まで通り）");
{
  const same = run({ prev: "c1", next: "c1", mark: "fresh", empty: true });
  ok("同じ客 → 強制は立たない・place_keep・省いた印は出ない", same.force === false && same.steps.includes("place_keep") && !same.steps.includes("reset_clean_no_force_place"), same);
  const first = run({ prev: "", next: "c2", mark: "none" });
  ok("初回（前客なし）→ 強制は立たない・place_keep", first.force === false && first.steps.includes("place_keep") && first.willClear === false, first);
  const noNext = run({ prev: "c1", next: "", mark: "fresh", empty: true });
  ok("今客の番号が無い → 客切替とみなさない（place_keep）", noNext.force === false && noNext.steps.includes("place_keep"), noNext);
}

console.log("\n■ 壊れた印・例外でも落ちない");
{
  const broken = run({ prev: "c1", next: "c2", mark: "none" });
  ok("印なしでも実物の文は例外を出さない", !broken.err, broken);
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
