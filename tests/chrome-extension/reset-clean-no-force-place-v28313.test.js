/**
 * 2.8.313 「危険な部分を徹底的に直す」: リセットで空と確かめた直後は、客が変わっただけで
 *   「前客の場所を全部外す（強制）」の旗を立てない（空のフォームで小窓を開いて確かめる時間を省く）。
 *
 *   ① helper（_resetCleanSkipsForcePlace）の作りと、3か所の呼び出し
 *   ② helper を実関数で動かす（空と確認済みなら true・印が無い／古い／空でないなら false・stamp の時だけ audit）
 *   ③ 拒む範囲（送付後の外し未完・前の回のリセット引き継ぎは今まで通り）
 *   ④ 決まり（auto-procedure-rules）・版・audit の保持
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..", "..");
const rd = (p) => fs.readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
const ps = rd("chrome-extension/page-script.js");
const rules = rd("app/lib/auto-procedure-rules.ts");
const sa = rd("chrome-extension/search-audit.js");
const man = JSON.parse(rd("chrome-extension/manifest.json"));

let pass = 0, fail = 0;
function ok(name, c, extra) { if (c) pass++; else { fail++; console.log("NG: " + name + (extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 220))); } }
function semverOk(v, min) {
  const a = String(v).split(".").map(Number), b = String(min).split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) > (b[i] || 0)) return true; if ((a[i] || 0) < (b[i] || 0)) return false; }
  return true;
}
function fnSrc(src, header) {
  const i = src.indexOf(header);
  if (i < 0) return "";
  const s = src.slice(i);
  const e = s.indexOf("\n  }\n");
  return e < 0 ? s : s.slice(0, e + 5);
}

console.log("\n■ 版");
ok("manifest ≥2.8.313", semverOk(man.version, "2.8.313"), man.version);
ok("page ≥2.8.313", semverOk((ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1], "2.8.313"));
ok("rules ≥2.8.313", semverOk((rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1], "2.8.313"));

console.log("\n■ ① 作りと呼び出し");
const helper = fnSrc(ps, "  function _resetCleanSkipsForcePlace(stamp) {");
ok("helper がある", helper.length > 0);
ok("空と確認済みか（_axResetCleanFresh）で決める", /_axResetCleanFresh\(\)/.test(helper));
ok("stamp の時だけ audit に印", /if \(stamp && _audit\) _auditStepP\("reset_clean_no_force_place"/.test(helper));
ok("印（reset_clean）はここで消さない", !/removeItem/.test(helper));
ok("落ちない（try/catch）", /catch \(_\) \{ return false; \}/.test(helper));
ok("① 前客の外しの予告（_willClear）で使う", /_pCid !== _nCid && !_resetCleanSkipsForcePlace\(false\)\) _willClear = true/.test(ps));
ok("② 客切替の旗（_switchedCust）で使う", /if \(_switchedCust && !window\.__axlxForceClearAllPlace && _resetCleanSkipsForcePlace\(true\)\) _switchedCust = false;/.test(ps)); // 2.8.314: 他が強制を立てている回は省かない
ok("③ 場所の強制（_needForcePlace）で使う", /_p0 !== _n0 && !_resetCleanSkipsForcePlace\(false\)\) _needForcePlace = true/.test(ps));
ok("送付後の外し未完（PostSendClearGap）は今まで通り立てる", /if \(window\.__axlxPostSendClearGap\) _willClear = true;/.test(ps));
ok("決まりの id が拡張に入っている", /"reset_clean_no_force_place",\n(?:    "[a-z_]+",\n)*  \];/.test(ps));

console.log("\n■ ② helper を実関数で動かす");
function run(storage, empty, stamp) {
  const steps = [];
  const store = Object.assign({}, storage);
  const ctx = {
    window: { sessionStorage: { getItem: (k) => (k in store ? store[k] : null) } },
    _AX_RESET_CLEAN_KEY: "axlx_reset_clean",
    _resetFormState: () => ({ empty }),
    _audit: {},
    _auditStepP: (k) => steps.push(k),
    Date, JSON,
  };
  vm.createContext(ctx);
  const fresh = fnSrc(ps, "  function _axResetCleanFresh() {");
  vm.runInContext(fresh + "\n" + helper + "\nthis.__r = _resetCleanSkipsForcePlace(" + (stamp ? "true" : "false") + ");", ctx);
  return { r: ctx.__r, steps };
}
const now = Date.now();
const fresh = { axlx_reset_clean: JSON.stringify({ at: now - 1000 }) };
const old = { axlx_reset_clean: JSON.stringify({ at: now - 11 * 60 * 1000 }) };
{
  const a = run(fresh, true, true);
  ok("空と確認済み＋いまも空 → true・印を残す", a.r === true && a.steps.join() === "reset_clean_no_force_place", a);
  const b = run(fresh, true, false);
  ok("stamp=false（予告・場所の強制）なら印は残さない", b.r === true && b.steps.length === 0, b);
  const c = run(fresh, false, true);
  ok("印はあるがいまは空でない → false（今まで通り外す）", c.r === false && c.steps.length === 0, c);
  const d = run({}, true, true);
  ok("印が無い → false", d.r === false && d.steps.length === 0, d);
  const e = run(old, true, true);
  ok("印が 10 分より古い → false", e.r === false, e);
  const f = run({ axlx_reset_clean: "{壊れた" }, true, true);
  ok("壊れた印でも落ちない → false", f.r === false, f);
}

console.log("\n■ ③ 拒む範囲（前客の残りがある・送付後の外し未完は外す）");
{
  const sw = ps.slice(ps.indexOf("var _switchedCust = "), ps.indexOf("var _switchedCust = ") + 1400);
  ok("客切替でない回の『残りがある時の強制』には触れない（else if の分岐が残る）", /else if \(!window\.__axlxForceClearAllPlace\)/.test(sw), sw.slice(0, 200));
  ok("リセット引き継ぎ（_waitInheritedReset）の旗は別の所で立つ（この helper では変えない）", !/__axlxForceClearAllPlace\s*=/.test(helper));
}

console.log("\n■ ④ 決まり・audit");
ok("決まり reset_clean_no_force_place がある", /id: "reset_clean_no_force_place"/.test(rules));
ok("決まりの marker は helper 名", /marker: "_resetCleanSkipsForcePlace"/.test(rules) && ps.includes("_resetCleanSkipsForcePlace"));
ok("決まりの since は 2.8.313", /id: "reset_clean_no_force_place"[\s\S]{0,900}since: "2\.8\.313"/.test(rules));
ok("旧文（毎回 force）の食い違いを直した（task_change_api_every）", /task_gate_no_forced_refetch・2\.8\.309/.test(rules) && !/幹段（clear_then_fill・fill_start・handoff・clear）は force、他は soft/.test(rules));
ok("audit の保持（KEEP と RULE の両方に印の名前）", (sa.match(/reset_clean_no_force_place/g) || []).length >= 2, (sa.match(/reset_clean_no_force_place/g) || []).length);

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
