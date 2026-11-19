// 実行: node tests/chrome-extension/implied-fill-done-v2828.test.js
// 2.8.128 竹内さん（2026-11-19）「ちゃんと改善されたのか／徹底的に」
// 実測（search_audits 1530・1535・1538）: 検索を押した後 fill-done が届かず idle_close になっても、一覧では PDF 送付が始まっていた。
//   旧は fill-done を最大30分待つ → 次のお客さんへ進めない。
// 固定する形: 一覧の送付の合図（進み・完了）が来たら、番号が合う待ち（番号が無い時は待ちが1本だけ）の fill-done を解く／
//   完了の合図が待ち手より先に来たら覚えて、後から作る待ち手がすぐ受け取る／前のお客さんの合図で次のお客さんを解かない。
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }
const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8").replace(/\r\n/g, "\n");

const a = bg.indexOf("var _earlyBatchDone = [];");
const b = bg.indexOf("function _createBatchCustomerDoneWaiter(");
ok("切り出せる", a > 0 && b > a, { a, b });
const code = bg.slice(a, b);

function makeEnv() {
  const log = { resolved: [], steps: [], notify: [] };
  const sandbox = {
    console: { warn() {}, log() {} },
    setTimeout, clearTimeout, Date,
    _fillDoneWaiters: [],
    _notifyFillDone(site, cid) {
      log.notify.push([site, cid]);
      sandbox._fillDoneWaiters = sandbox._fillDoneWaiters.filter((w) => !(String(w.customerId) === String(cid)));
      log.resolved.push(cid);
    },
    _auditOpenRunId() { return "run1"; },
    _auditStep(rid, k, d) { log.steps.push([k, d]); },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { sandbox, log };
}
const W = (cid, site) => ({ customerId: cid, site: site || "realnetpro", timer: null });

console.log("■ 一覧の送付の合図で fill-done を解く");
{
  const { sandbox: s, log } = makeEnv();
  s._fillDoneWaiters = [W("A")];
  ok("番号が合う → 解く", s._impliedFillDone("A", "realnetpro", "送付の進み") === true && log.resolved[0] === "A");
  ok("記録（fill_done_implied）を残す", log.steps.some((x) => x[0] === "fill_done_implied"));
}
{
  const { sandbox: s, log } = makeEnv();
  s._fillDoneWaiters = [W("B")];
  ok("前のお客さん(A)の合図では次のお客さん(B)の待ちを解かない", s._impliedFillDone("A", "realnetpro", "x") === false && log.resolved.length === 0);
}
{
  const { sandbox: s, log } = makeEnv();
  s._fillDoneWaiters = [W("A")];
  ok("番号が無い時は待ちが1本だけなら解く", s._impliedFillDone(null, "realnetpro", "x") === true && log.resolved[0] === "A");
}
{
  const { sandbox: s, log } = makeEnv();
  s._fillDoneWaiters = [W("A", "realnetpro"), W("B", "itandi")];
  ok("番号が無く、別サイトの待ちがあっても自分のサイトで1本なら解く（取り違えない）", s._impliedFillDone(null, "realnetpro", "x") === true && log.resolved[0] === "A");
}
{
  const { sandbox: s, log } = makeEnv();
  s._fillDoneWaiters = [W("A"), W("B")];
  ok("番号が無く同じサイトに2本ある時は解かない", s._impliedFillDone(null, "realnetpro", "x") === false && log.resolved.length === 0);
}
{
  const { sandbox: s, log } = makeEnv();
  s._fillDoneWaiters = [];
  ok("待ちが無ければ何もしない", s._impliedFillDone("A", "realnetpro", "x") === false);
}

console.log("■ 完了の合図が待ち手より先に来た時");
{
  const { sandbox: s } = makeEnv();
  s._rememberEarlyBatchDone("A", "realnetpro", 7, null);
  const e = s._takeEarlyBatchDone("A", "realnetpro");
  ok("覚えた完了を後から受け取れる（件数付き）", !!e && e.propertyCount === 7);
  ok("1回受け取ったら無くなる", s._takeEarlyBatchDone("A", "realnetpro") === null);
}
{
  const { sandbox: s } = makeEnv();
  s._rememberEarlyBatchDone("A", "realnetpro", 3, null);
  ok("別のお客さんは受け取れない", s._takeEarlyBatchDone("B", "realnetpro") === null);
  ok("別のサイトは受け取れない", s._takeEarlyBatchDone("A", "itandi") === null);
}
{
  const { sandbox: s } = makeEnv();
  s._rememberEarlyBatchDone("A", "realnetpro", 3, null);
  s._clearEarlyBatchDone("A", "realnetpro");
  ok("新しい回の始まりで消える（前の回の完了を持ち越さない）", s._takeEarlyBatchDone("A", "realnetpro") === null);
}
{
  const { sandbox: s } = makeEnv();
  s._rememberEarlyBatchDone("A", "realnetpro", 3, null);
  s._earlyBatchDone[0].at = Date.now() - 4 * 60 * 1000;
  ok("3分過ぎたら使わない", s._takeEarlyBatchDone("A", "realnetpro") === null);
}

console.log("■ 配線");
ok("完了の合図で fill-done を先に解く", /_impliedFillDone\(msg\.customerId \|\| null, _msgSite, "全ページ送信の完了合図"\); \} catch \(_\) \{\}\s*\n\s*_notifyBatchCustomerDone\(/.test(bg));
ok("送付の進みでも解く", /_impliedFillDone\(msg\.customerId \|\| null, _msgSite, "送付の進み"\)/.test(bg));
ok("待ちが無い時の完了を覚える", /_rememberEarlyBatchDone\(customerId, site, propertyCount, audit\)/.test(bg));
ok("待ち手を作る時にまず先着の完了を確かめる", /function _createBatchCustomerDoneWaiter\([^)]*\) \{\s*\n\s*var _early = _takeEarlyBatchDone/.test(bg));
ok("fill-done の待ちを作る時に前の先着を消す", /_clearEarlyBatchDone\(customerId, site === "itandi"/.test(bg));

console.log("■ 送付中の点検が6分で idle_close に閉じない");
{
  const a2 = bg.indexOf("function _auditTouchIdleTimer(");
  const b2 = bg.indexOf("function _auditFinish(");
  ok("関数がある", a2 > 0 && b2 > a2);
  const timers = new Map();
  const fired = [];
  const sb = {
    console: { warn() {} }, Map,
    _auditSingleTimers: timers, AUDIT_SINGLE_CLOSE_MS: 50,
    AUDIT_IDLE_CLOSE_EXTRA() { return { error_kind: "idle_close" }; },
    _auditFinish(rid, x) { fired.push([rid, x.error_kind]); },
    setTimeout, clearTimeout,
    _auditTracker: { findOpen(cid, site) { return cid === "A" && site === "realpro" ? { run_id: "r1", trigger: "single" } : cid === "H" ? { run_id: "r2", trigger: "bulk_manual" } : null; } },
  };
  vm.createContext(sb);
  vm.runInContext(bg.slice(a2, b2), sb);
  timers.set("r1", setTimeout(() => fired.push(["r1", "OLD"]), 30));
  sb._auditTouchIdleTimer("A", "realnetpro");
  setTimeout(() => {
    ok("進みが来ると古い閉じ待ちは捨てて張り直す（古い方は鳴らない）", !fired.some((f) => f[1] === "OLD"), fired);
    setTimeout(() => {
      ok("張り直した閉じ待ちは時間が来れば idle_close で閉じる", fired.some((f) => f[0] === "r1" && f[1] === "idle_close"), fired);
      const before = timers.size;
      sb._auditTouchIdleTimer("H", "realnetpro");
      sb._auditTouchIdleTimer("Z", "realnetpro");
      ok("一括の回・知らない客・元から閉じ待ちが無い回には触らない", timers.size === before && !timers.has("r2"));
      ok("配線: 送付の進みで張り直す", /_auditTouchIdleTimer\(msg\.customerId \|\| null, _msgSite\)/.test(bg));
      console.log("\n" + passed + " 件 ✓ / " + failed + " 件 ✗");
      process.exit(failed ? 1 : 0);
    }, 120);
  }, 45);
  return;
}
console.log("\n" + passed + " 件 ✓ / " + failed + " 件 ✗");
process.exit(failed ? 1 : 0);
