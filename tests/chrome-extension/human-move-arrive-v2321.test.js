// 2.8.321 押す物は「カーソルが着いてから」押す（移動が途中で打ち切られたら動かし直す）
//   竹内さん 2026-11-27「駅入れるところで直接入力が入ってしまうところがあった・1つ1つ人間のようにカーソル動かして押していく」
//   原因: pointer-ui の moveTo は打ち切られると reject せず false で終わる。旧は戻り値を見ずに待ち時間のあと押していた。
//   試験は文言の有無だけにしない: 偽のカーソルを動かし、「着く前に押していない」を順番で確かめる。
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..", "..");
const page = fs.readFileSync(path.join(root, "chrome-extension", "page-script.js"), "utf8").replace(/\r\n/g, "\n");
const sa = fs.readFileSync(path.join(root, "chrome-extension", "search-audit.js"), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (detail ? " :: " + detail : "")); }
}

const s0 = page.indexOf("  function _humanPointerClick(");
const s1 = page.indexOf("\n  function _fireAt(");
ok("_humanPointerClick を取り出せる", s0 > 0 && s1 > s0);
const fnSrc = page.slice(s0, s1);

// moves: 各回の結果（true=着いた / false=打ち切り / "far"=true を返すが欄の外にいる）
function makeEnv(plan) {
  const log = []; // 順番の記録: "move" / "fire"
  const steps = [];
  let moveN = 0;
  let curPos = { x: 5, y: 5 };
  const rect = { left: 100, top: 100, right: 200, bottom: 130, width: 100, height: 30 };
  const el = { tagName: "LABEL", getBoundingClientRect: () => rect, dispatchEvent() {} };
  const P = {
    ensure() { return true; },
    setTarget() {},
    moveTo() {
      const r = plan[Math.min(moveN, plan.length - 1)];
      moveN++;
      log.push("move");
      if (r === true) { curPos = { x: 150, y: 115 }; return Promise.resolve(true); }
      if (r === "far") { curPos = { x: 500, y: 500 }; return Promise.resolve(true); }
      return Promise.resolve(false);
    },
    moveToEl() { return this.moveTo(); },
    visiblePosition() { return curPos; },
    drift() { return Promise.resolve(); },
  };
  const sandbox = {
    window: { AxlxHumanWait: { pointerPath: () => [], logNormalDelay: () => 120 }, AxlxPointerUi: P, innerWidth: 1200, innerHeight: 800 },
    Promise, setTimeout, Math, Date, console,
    _clickEl() {}, isVisible: () => true, _labelForCheckbox: () => null, _visibleHitPoint: () => null,
    _hitPlain: () => true, _hitOkAt: () => true, _opLabel: () => "桜川", _audit: { steps: [] },
    _auditStepP: (k, d) => steps.push({ k, d }), _pointer: { x: 0, y: 0 },
    _pressNote() {},
    _fireAt: (e, fire) => { log.push("fire"); try { fire(e); } catch (_) {} return Promise.resolve(true); },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSrc + "\nthis.__f = _humanPointerClick;", sandbox);
  return { run: () => sandbox.__f(el, function () {}, null, null), log, steps, moves: () => moveN };
}

(async () => {
  console.log("■ 1. 着いたら1回で押す（動かし直さない）");
  {
    const e = makeEnv([true]);
    await e.run();
    ok("動かしたのは1回", e.moves() === 1, "moves=" + e.moves());
    ok("押す（fire）は動かした後", e.log.join(",") === "move,fire", e.log.join(","));
    ok("動かし直しの印は出ない", !e.steps.some((s) => s.k === "move_retry" || s.k === "press_no_arrive"));
  }

  console.log("■ 2. 途中で打ち切られた（false）→ 着くまで動かし直してから押す");
  {
    const e = makeEnv([false, false, true]);
    await e.run();
    ok("3回動かした", e.moves() === 3, "moves=" + e.moves());
    ok("押す（fire）は最後に着いた後の1回だけ", e.log.join(",") === "move,move,move,fire", e.log.join(","));
    ok("動かし直しの印（move_retry）が2回残る", e.steps.filter((s) => s.k === "move_retry").length === 2);
    ok("着かないまま押した印は出ない", !e.steps.some((s) => s.k === "press_no_arrive"));
  }

  console.log("■ 3. true でも欄から遠い所にいる → 着いたと見ず動かし直す");
  {
    const e = makeEnv(["far", true]);
    await e.run();
    ok("2回動かした", e.moves() === 2, "moves=" + e.moves());
    ok("押すのは欄の近くに着いた後", e.log.join(",") === "move,move,fire", e.log.join(","));
  }

  console.log("■ 4. 3回でも着かない → 押す（駅の選びを落とさない）・印を残す");
  {
    const e = makeEnv([false]);
    await e.run();
    ok("動かすのは3回まで", e.moves() === 3, "moves=" + e.moves());
    ok("最後に1回だけ押す", e.log.filter((x) => x === "fire").length === 1 && e.log[e.log.length - 1] === "fire", e.log.join(","));
    ok("press_no_arrive が1回残る（DB で数えられる）", e.steps.filter((s) => s.k === "press_no_arrive").length === 1);
  }

  console.log("■ 5. 点検の一覧（間引きで消えない）");
  {
    const keep = /var KEEP_STEP = (\/.*\/[a-z]*);/.exec(sa);
    const K = keep ? new Function("return " + keep[1])() : null;
    ok("page:move_retry が点検に残る", !!K && K.test("page:move_retry"));
    ok("page:press_no_arrive が点検に残る", !!K && K.test("page:press_no_arrive"));
    ok("page:press_no_cursor_ui が点検に残る", !!K && K.test("page:press_no_cursor_ui"));
    ok("ページ側で即送信・間引き除外（_PIN・_clearKey）に入っている",
      /var _PIN = \/[^\n]*\|move_retry\|press_no_arrive\|press_no_cursor_ui\|/.test(page) && /var _clearKey = \/[^\n]*\|move_retry\|press_no_arrive\|press_no_cursor_ui\|/.test(page));
    ok("手順書の決まりの目印（_moveUntilArrived）が実在する", page.includes("_moveUntilArrived"));
    ok("_AXLX_RULES_DONE に human_move_arrive", /"human_move_arrive",/.test(page));
  }

  console.log("■ 6. 悪い入力を止める自己点検（旧の形に戻したら赤になる）");
  {
    const OLD = "return _move().then(function () {";
    ok("旧の「戻り値を見ずに押す」形（_move().then）が残っていない", !fnSrc.includes(OLD));
    ok("移動の失敗時にその場で押す分岐（reject 側で _fireAt）が残っていない", !/\}, function \(\) \{\s*return Promise\.resolve\(_fireAt\(el, fire, r, _aimPt\)\)/.test(fnSrc));
  }

  console.log(`\n結果: ${passed} 合格 / ${failed} 不合格`);
  process.exit(failed ? 1 : 0);
})();
