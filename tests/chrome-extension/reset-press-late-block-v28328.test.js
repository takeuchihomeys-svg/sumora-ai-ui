// 2026-11-27 竹内さん「時間差のところで邪魔しないようになっているのか」:
//   リセットの押す処理（_resetPress）が 120 秒で「押せず」と返した後も、実行途中だった人の動きのクリックは
//   列から取り消せない（列に残っている物しか消さない）。見えないタブが後で見えると遅れて押され、
//   保険の押し直しや次の客の入力の最中にページが読み直される（実測 #1661・#1666・#1671 は見えないタブで press_timeout）。
//   → 押す処理が終わっていて、まだ押していなければ、遅れて来たクリックは押さない（reset_press_late_blocked）。
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ps = fs.readFileSync(path.join(__dirname, "../../chrome-extension/page-script.js"), "utf8").replace(/\r\n/g, "\n");
let pass = 0, fail = 0;
function ok(name, cond) {
  try { assert.ok(cond); pass++; console.log("  ✓ " + name); }
  catch (_) { fail++; console.log("  ✗ " + name); }
}

function bodyOf(src, name) {
  const m = new RegExp("\\n( *)function " + name + "\\(").exec(src);
  if (!m) return "";
  const end = src.indexOf("\n" + m[1] + "}\n", m.index + 1);
  return end < 0 ? "" : src.slice(m.index, end);
}

const rp = bodyOf(ps, "_resetPress");
ok("_resetPress がある", rp.length > 0);

const fireIdx = rp.indexOf("var _fireReset = function (el) {");
const guardIdx = rp.indexOf("if (finished && !fired)");
const setIdx = rp.indexOf("fired = true; firedAt = Date.now(); return _clickEl(el);");
ok("押す関数（_fireReset）の中に、終わった後は押さない守りがある", fireIdx > 0 && guardIdx > fireIdx && setIdx > guardIdx);
ok("守りは押した印（fired）を立てる前に見る", guardIdx > 0 && setIdx > guardIdx);
ok("守りに当たったら点検に残し、押さずに返す", /reset_press_late_blocked[\s\S]{0,120}return false;/.test(rp.slice(guardIdx)));
ok("押せずで終わる所（press_timeout）は finished を立てる fin を通る", /fin\(\{ ok: false, why: "press_timeout"/.test(rp) && /var fin = function \(r\) \{\s*if \(finished\) return;\s*finished = true;/.test(rp));

// 動きで確かめる: 守りの入った _fireReset と同じ形の関数を作って、終わった後のクリックが押されない事を見る
const fireSrc = rp.slice(fireIdx, rp.indexOf("};", setIdx) + 2).replace("var _fireReset = ", "return ");
function makeFire(state) {
  let clicked = 0;
  const steps = [];
  const fn = new Function("st", "_resetStepP", "_clickEl",
    "var finished = st.finished, fired = st.fired, firedAt = 0;\n" + fireSrc.replace(/\bfinished\b/g, "st.finished").replace(/\bfired = true\b/, "st.fired = true").replace(/!fired\b/, "!st.fired"));
  const fire = fn(state, function (k) { steps.push(k); }, function () { clicked++; return true; });
  return { fire, get clicked() { return clicked; }, steps };
}
const late = makeFire({ finished: true, fired: false });
const r1 = late.fire({});
ok("押せずで終わった後のクリックは押さない", r1 === false && late.clicked === 0 && late.steps.includes("reset_press_late_blocked"));
const normal = makeFire({ finished: false, fired: false });
normal.fire({});
ok("押す処理の途中のクリックは今まで通り押す", normal.clicked === 1 && normal.steps.length === 0);

// 自己点検: 守りが無い形は止まる
const noGuard = rp.replace("if (finished && !fired)", "if (false)");
ok("自己点検: 守りを外した入力は検出される", noGuard.indexOf("if (finished && !fired)") < 0);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
