// 2.8.128: busy_other_customer は一括を止めず、最後に1回だけやり直す（2回目は飛ばす）。human_takeover は今まで通り止める
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("✓ " + name); } else { fail++; console.log("✗ " + name); } }

const root = path.join(__dirname, "..", "..", "chrome-extension");
const handoffSrc = fs.readFileSync(path.join(root, "customer-handoff.js"), "utf8");
const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");

const sandbox = { self: {}, globalThis: {}, console };
sandbox.self = sandbox; sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(handoffSrc, sandbox);
const H = sandbox.AxlxCustomerHandoff || sandbox.self.AxlxCustomerHandoff;

ok("モジュールが読める", !!H && typeof H.busyRetryDecision === "function");
ok("busy_other_customer は一括を止めない", H.gateHoldsBatch("busy_other_customer") === false);
ok("human_takeover は一括を止める", H.gateHoldsBatch("human_takeover") === true);

const set = new Set();
const msg = "page-script側エラー（スキップ）: busy_other_customer: 前のお客さんの入力中";
ok("1回目は retry", H.busyRetryDecision(msg, 101, set) === "retry");
ok("同じ客の2回目は give_up", H.busyRetryDecision(msg, "101", set) === "give_up");
ok("別の客の1回目は retry", H.busyRetryDecision(msg, 202, set) === "retry");
ok("関係ないエラーは null", H.busyRetryDecision("timeout", 101, new Set()) === null);
ok("番号が無い busy は give_up（無限に回さない）", H.busyRetryDecision(msg, null, new Set()) === "give_up");
ok("Error オブジェクトでなく undefined でも落ちない", H.busyRetryDecision(undefined, 1, new Set()) === null);

// 配線
ok("background: _busyRetried を一括ごとに作り直す（2か所）", (bg.match(/_busyRetried = new Set\(\)/g) || []).length >= 3);
ok("background: 手動一括の catch で最後に積み直す", /_bulkTargets\.push\(_bc\)/.test(bg));
ok("background: キューの catch で最後に積み直す", /targets\.push\(_again\)/.test(bg));
ok("background: busy_retry_queued / busy_give_up を点検に残す", /busy_retry_queued/.test(bg) && /busy_give_up/.test(bg));
ok("background: やり直す回は『検索できなかった』を知らせない（2か所）", /_bd !== "retry"/.test(bg) && /_bulkBd !== "retry"/.test(bg));

console.log("\n結果: " + pass + " pass / " + fail + " fail");
process.exit(fail ? 1 : 0);
