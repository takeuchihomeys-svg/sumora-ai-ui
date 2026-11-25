/**
 * 2.8.282 実測 #1640（2026-11-25 13:14・v2.8.281・41分止まった）:
 *   一括が `autofill` の段のまま、finished も error も付かず started で残った。
 *   原因は axlx-switch-customer の返事に上限が無いこと（underbar の非同期の返事が来ないと永久に待つ）。
 *
 *   ① 送る側に上限がある（リアプロ・itandi の両方）
 *   ② 打ち切った時は「応答が無い」と同じ道（1回やり直し → 直接入力）に流れる
 *   ③ 条件を入れる段が上限を過ぎて、ページが入力を始めていない時は、その客をもう一度回す
 *   ④ 入力が本当に走っている時は割らない
 *   ⑤ 決まり（正本）と page-script の一覧が揃っている
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..", "..");
const bg = fs.readFileSync(path.join(root, "chrome-extension/background.js"), "utf8");
const ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
const man = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
const rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, extra) { if (c) pass++; else { fail++; console.log("NG: " + name + (extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 220))); } }
function semverOk(v, min) {
  const a = String(v).split(".").map(Number), b = String(min).split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) > (b[i] || 0)) return true; if ((a[i] || 0) < (b[i] || 0)) return false; }
  return true;
}
/** 名前の関数を切り出す（async も含む・次の「\n}\n」まで） */
function topFn(src, name) {
  let i = src.indexOf("function " + name + "(");
  if (i < 0) return "";
  if (src.slice(i - 6, i) === "async ") i -= 6;
  const s = src.slice(i).replace(/\r\n/g, "\n");
  const e = s.indexOf("\n}\n");
  return e < 0 ? s : s.slice(0, e + 3);
}

console.log("\n■ 版");
ok("manifest ≥2.8.282", semverOk(man.version, "2.8.282"), man.version);
ok("page ≥2.8.282", semverOk((ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1], "2.8.282"));
ok("rules ≥2.8.282", semverOk((rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1], "2.8.282"));

console.log("\n■ ① 送る側に上限がある");
const swReal = bg.slice(bg.indexOf("var _sendSwitch = function ()"));
const swRealBody = swReal.slice(0, swReal.indexOf("var _H = self.AxlxCustomerHandoff"));
ok("リアプロ: 上限の値を持つ", /var _SWITCH_SEND_TIMEOUT_MS = 30000;/.test(bg));
ok("リアプロ: _withTimeout で包む", /_sendSwitch = function \(\) \{\s*return _withTimeout\(new Promise/g.test(bg));
ok("リアプロ: 打ち切りに名前を付ける", /"realpro_switch"\)/.test(swRealBody));
const swIt = bg.slice(bg.indexOf("var _sendItandiSwitch = function ()"));
const swItBody = swIt.slice(0, swIt.indexOf("var batchItandiSwitched"));
ok("itandi: _withTimeout で包む", /return _withTimeout\(new Promise/.test(swItBody));
ok("itandi: 上限30秒", /30000, "itandi_switch"\)/.test(swItBody));

console.log("\n■ ② 打ち切った時は「応答が無い」と同じ道へ");
ok("リアプロ: 打ち切りを応答なしに読み替える", /if \(_sw && _sw\.__timeout\) \{[\s\S]{0,220}switch-no-answer-timeout/.test(bg));
ok("リアプロ: 印を残す", /switch_timeout/.test(bg));
ok("itandi: 打ち切りを応答なしに読み替える", /if \(_itSw && _itSw\.__timeout\) \{[\s\S]{0,220}switch-no-answer-timeout/.test(bg));
ok("打ち切りは1回目のやり直し（読み直し）へ流れる", /popup-no-answer|_ensureRealproTab\([\s\S]{0,600}_restartFillDoneWaiter/.test(bg));
ok("打ち切りの後は直接入力の道がある", /AXLX_NO_FILL_START: リアプロのページが条件の入力を始めませんでした（直接入力でも）/.test(bg));

console.log("\n■ ③ 入力を始めていない autofill は起こす");
const dead = topFn(bg, "_bulkAutofillDeadKick");
ok("_bulkAutofillDeadKick がある", dead.length > 400);
ok("autofill の段だけ見る", /p\.phase !== "autofill"/.test(dead));
ok("上限＋1分を過ぎた時だけ", /BULK_PHASE_GRACE_MS/.test(dead) && !/BULK_KICKABLE_PHASES\[/.test(dead));
ok("ページに入力を始めたかを聞く（realpro）", /_probeRealproTab/.test(dead));
ok("ページに入力を始めたかを聞く（itandi）", /_probeItandiTab/.test(dead));
ok("入力中は割らない", /probe\.fillRunning\) return \{ ok: false, reason: "filling" \}/.test(dead));
ok("この客をもう一度（retrySame）", /_bulkKick\("autofill_dead", \{ retrySame: true \}\)/.test(dead));
ok("印を残す", /autofill_dead_kick/.test(dead));
ok("見回り（20秒）から呼ばれる", /p\.phase === "autofill"\) _bulkAutofillDeadKick\(\)\.catch/.test(bg));

console.log("\n■ ④ retrySame の決め方（vm で動かす）");
(function () {
  const kick = topFn(bg, "_bulkKick");
  const ctx = {
    console: { log() {}, warn() {} },
    Date,
    _bulkKickAt: 0, _bulkPhase: null, _bulkPhaseRunId: null, _manualBulkGen: 0, _manualBulkAlive: false, _bulkQueue: null,
    _bulkQueueLoad: async () => ctx._q,
    _bulkQueueSave: (p) => { ctx._q = Object.assign({}, ctx._q, p); },
    _auditStep() {}, _withTimeout: (p) => p, _publishBulkGrasp: async () => {},
    _manualBulkRun: (o) => { ctx._calls.push(o); },
    _calls: [],
  };
  vm.createContext(ctx);
  vm.runInContext(topFn(bg, "_bulkClampStart") + "\n" + kick, ctx);
  const reset = (q) => { ctx._q = q; ctx._bulkKickAt = 0; ctx._calls.length = 0; };
  (async () => {
    try {
      reset({ ids: ["a", "b", "c"], index: 1, stage: "running", cid: "b" });
      const r1 = await ctx._bulkKick("autofill_dead", { retrySame: true });
      ok("retrySame → 同じ客（index 1）から", r1.ok && ctx._calls[0] && ctx._calls[0].startIndex === 1);
      reset({ ids: ["a", "b", "c"], index: 1, stage: "running", cid: "b" });
      const r2 = await ctx._bulkKick("t");
      ok("retrySame 無しの running は進めない（二重送信の防止は残る）", !r2.ok && r2.reason === "running_not_done" && ctx._calls.length === 0);
      reset({ ids: ["a", "b", "c"], index: 0, stage: "done", cid: "a" });
      await ctx._bulkKick("t");
      ok("done は今まで通り次の客から", ctx._calls[0] && ctx._calls[0].startIndex === 1);
      reset({ ids: ["a", "b", "c"], index: 2, stage: "done", cid: "c", sentCids: ["a"] });
      await ctx._bulkKick("t");
      ok("handledCids が無い古い記録は、送った人の次（2人目）へ戻す", ctx._calls[0] && ctx._calls[0].startIndex === 1, ctx._calls[0] && ctx._calls[0].startIndex);
    } catch (e) {
      ok("retrySame の vm が落ちない", false, String(e && e.stack || e));
    }
  })();
})();

console.log("\n■ ⑤ 決まりと一覧が揃っている");
ok("page-script の一覧に足した", /"bulk_switch_no_forever_wait"/.test(ps));
ok("正本に決まりがある", /id: "bulk_switch_no_forever_wait"/.test(rules) && /since: "2\.8\.282"/.test(rules));
ok("marker がコードに実在する", rules.includes("_SWITCH_SEND_TIMEOUT_MS") && /_SWITCH_SEND_TIMEOUT_MS/.test(bg));
ok("点検の段の名前が正本と一致", /switch_timeout/.test(rules) && /switch_timeout/.test(bg) && /autofill_dead_kick/.test(rules) && /autofill_dead_kick/.test(bg));

setTimeout(function () {
  console.log("\n" + (fail ? "✗ " + fail + "/" + (pass + fail) + " 失敗" : "✓ 全 " + pass + " 件 OK"));
  if (fail) process.exit(1);
}, 300);
