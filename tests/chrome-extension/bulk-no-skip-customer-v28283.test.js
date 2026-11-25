/**
 * 2.8.283 竹内さん「1人目が終わると次の人が済んだと誤判定され3人目に飛ぶ／全顧客の終了判定」
 *   ① 片付いた客の id（handledCids）で「続ける位置」の上限を決める（実関数を vm で動かす）
 *   ② 完了の書き込みは世代の確認の後（古いループが位置を書き戻さない）
 *   ③ _bulkKick が上限を使う・止まりの印を残す
 *   ④ 全員が済んだら「全件完了」を1通だけ知らせる（止めた回・引き継がれた回は出さない）
 *   ⑤ 既にある安全装置（0件・最終ページ・検索前の関所）が残っている
 *   ⑥ 決まり（正本）と page-script の一覧が揃っている
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..", "..");
const bg = fs.readFileSync(path.join(root, "chrome-extension/background.js"), "utf8").replace(/\r\n/g, "\n");
const ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
const bd = fs.readFileSync(path.join(root, "chrome-extension/bulk-dl.js"), "utf8");
const man = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
const rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, extra) { if (c) pass++; else { fail++; console.log("NG: " + name + (extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 220))); } }
function semverOk(v, min) {
  const a = String(v).split(".").map(Number), b = String(min).split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) > (b[i] || 0)) return true; if ((a[i] || 0) < (b[i] || 0)) return false; }
  return true;
}
function topFn(src, name) {
  const i = src.indexOf("function " + name + "(");
  if (i < 0) return "";
  const s = src.slice(i);
  const e = s.indexOf("\n}\n");
  return e < 0 ? s : s.slice(0, e + 3);
}

console.log("\n■ 版");
ok("manifest ≥2.8.283", semverOk(man.version, "2.8.283"), man.version);
ok("page ≥2.8.283", semverOk((ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1], "2.8.283"));
ok("rules ≥2.8.283", semverOk((rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1], "2.8.283"));

console.log("\n■ ① 続ける位置の上限（実関数）");
const sandbox = { _bulkQueue: null };
vm.createContext(sandbox);
vm.runInContext(topFn(bg, "_bulkHandledCidsWith") + "\n" + topFn(bg, "_bulkClampStart"), sandbox);
const clamp = sandbox._bulkClampStart;
const ids = ["a", "b", "c", "d"];
ok("1人目だけ済み・start=1 → 1のまま（2人目から）", clamp(ids, ["a"], 1) === 1);
ok("【実害】1人目だけ済みで start=2（3人目）→ 1に戻す（2人目を飛ばさない）", clamp(ids, ["a"], 2) === 1);
ok("1・2人目済み・start=2 → 2", clamp(ids, ["a", "b"], 2) === 2);
ok("全員済み・start=4 → 4（終わり）", clamp(ids, ["a", "b", "c", "d"], 4) === 4);
ok("誰も済んでいない・start=2 → 0に戻す", clamp(ids, [], 2) === 0);
ok("途中が飛ばされている（a,c 済み・b 未）start=3 → 1", clamp(ids, ["a", "c"], 3) === 1);
ok("handled が配列でなくても落ちない", clamp(ids, null, 1) === 0);
ok("送り済みを戻さない（start が小さければそのまま）", clamp(ids, ["a", "b", "c"], 1) === 1);
sandbox._bulkQueue = { handledCids: ["a"] };
const h1 = sandbox._bulkHandledCidsWith("b");
ok("handledCids に足す", JSON.stringify(h1) === JSON.stringify(["a", "b"]));
ok("同じ id は二重に入れない", sandbox._bulkHandledCidsWith("a").length === 1);
sandbox._bulkQueue = { handledCids: Array.from({ length: 300 }, (_, i) => "x" + i) };
ok("200件までに切る", sandbox._bulkHandledCidsWith("z").length === 200);

console.log("\n■ ② 完了の書き込みは世代の確認の後");
const run = bg.slice(bg.indexOf("async function _manualBulkRun("));
const runBody = run.slice(0, run.indexOf("\nvar _manualBulkGen = 0;"));
const iGen = runBody.indexOf('stale_done_skip');
const iSave = runBody.indexOf('stage: "done", sentCids: _bulkSentCidsWith');
ok("世代の確認（stale_done_skip）が完了の書き込みより前", iGen > 0 && iSave > 0 && iGen < iSave);
ok("成功の完了で handledCids を書く", /sentCids: _bulkSentCidsWith\(String\(_bc\.id\)\), handledCids: _bulkHandledCidsWith/.test(runBody));
ok("エラーで飛ばした客も handledCids に入れる（世代が同じ時だけ書く）", /if \(_myGen === _manualBulkGen\) _bulkQueueSave\(\{ index: _bi, cid: String\(_bc\.id\), stage: "done", handledCids/.test(runBody));
ok("見張りで見送った客も handledCids に入れる", /watchStopApplies\(_watchStop, _bulkSite, Date\.now\(\)\)\) _bulkQueueSave\(\{[^}]*handledCids/.test(runBody) && /_watchSkipSite\(_bc, _bulkSite\)\) continue;/.test(runBody));
ok("再開しても handledCids を引き継ぐ", /handledCids: _resume && _bulkQueue && Array\.isArray\(_bulkQueue\.handledCids\)/.test(runBody));

console.log("\n■ ③ _bulkKick が上限を使う");
const kick = topFn(bg, "async _bulkKick").length ? "" : bg.slice(bg.indexOf("async function _bulkKick("));
const kickBody = kick.slice(0, kick.indexOf("\n}\n") + 3);
ok("_bulkClampStart を呼ぶ", /_clamped = _bulkClampStart\(q\.ids, _hk, start\)/.test(kickBody));
ok("handledCids が無い古い記録は sentCids で同じ上限", /Array\.isArray\(q\.handledCids\) \? q\.handledCids\.slice\(\) : \(Array\.isArray\(q\.sentCids\)/.test(kickBody));
ok("戻した時は kick_clamp を残す", /"kick_clamp"/.test(kickBody));
ok("上限の計算は開始（_manualBulkRun 呼び出し）より前", kickBody.indexOf("_bulkClampStart") < kickBody.indexOf("_manualBulkRun("));
ok("retrySame（入力前に死んだ客）は同じ客のまま", /if \(o\.retrySame\) start = idx;/.test(kickBody));

console.log("\n■ ④ 全員が済んだら『全件完了』（出口）");
ok("bulk_all_done を残す", /"bulk_all_done"/.test(runBody));
ok("止めた回では出さない（_batchShouldStop）", /!_batchShouldStop && _myGen === _manualBulkGen && _bulkTargets\.length > 0/.test(runBody));
ok("グループへ1通だけ送る", (runBody.match(/全件完了/g) || []).length >= 1 && /group_key: "pickup_group_id"/.test(runBody.slice(runBody.indexOf("bulk_all_done"))));
ok("全件完了は for の後（完了ログの直後）", runBody.indexOf("✔ 完了") < runBody.indexOf("bulk_all_done"));
ok("顧客ゼロなら出さない", /_bulkTargets\.length > 0/.test(runBody));

console.log("\n■ ⑤ 既にある安全装置が残っている（0件・最終ページ・検索前の関所）");
ok("0件: 一覧が0件でも枠を出す（把握中）", /一括把握中は一覧0件でも枠を出す/.test(bd));
ok("0件: sentCount を付けて 0件アナウンス", /sentCount を必ず付ける: 0件なら background が/.test(bd));
ok("最終ページ: 次にonclick無しは最終ページ扱い", /次にonclick無し → 最終ページ扱い/.test(bd));
ok("最終ページ: 次ボタンなしは終わりとして扱う", /次ボタンなし（最終ページ or 未対応構造）/.test(bd));
ok("検索前の関所: 家賃・更新日・築年・徒歩・場所を画面で確かめる", /検索を押す前の関所/.test(ps));
ok("場所が空なら全件検索せず中止", /全件検索防止のため中止/.test(ps));

console.log("\n■ ⑥ 決まり（正本）と page-script の一覧");
ok("正本に bulk_no_skip_customer", /id: "bulk_no_skip_customer"/.test(rules));
ok("正本の印が background にある", /_bulkClampStart/.test(bg));
ok("page-script の完了一覧に bulk_no_skip_customer", /"bulk_no_skip_customer"/.test(ps));
ok("since が 2.8.283", /id: "bulk_no_skip_customer"[\s\S]{0,900}since: "2\.8\.283"/.test(rules));

(async function simPart() {
  console.log("\n■ ⑦ 本物の一括ループ（シミュレーター）で通して確かめる");
  const sim = require("./lib/bulk-sim.js");
  const customers = (n) => Array.from({ length: n }, (_, i) => ({ id: "c" + (i + 1), name: "客" + (i + 1) }));
  const start = async (w, n) => {
    const sw = w.startSw();
    await w.run(10);
    sw.call("_manualBulkRun", { site: "realnetpro", ids: customers(n).map((c) => c.id), isWide: false, startIndex: 0, resume: false, why: "popup" });
    return sw;
  };
  const filled = (w) => w.autofills.map((a) => a.cid);
  const allDoneN = (w) => (w.fetches || []).filter((f) => /notify-group/.test(f.url) && /全件完了/.test(f.body)).length;

  // 7-1 3人が順に済み、最後に全件完了が1通だけ・位置が飛ばない
  let w = sim.createWorld({ customers: customers(3) });
  await start(w, 3);
  await w.run(20 * 60000);
  ok("7-1 3人を順に（飛ばない）", JSON.stringify(filled(w)) === JSON.stringify(["c1", "c2", "c3"]), filled(w).join(","));
  ok("7-1 全件完了は1通だけ", allDoneN(w) === 1, String(allDoneN(w)));
  const q = w.session.data.axlx_bulk_queue || {};
  ok("7-1 handledCids に3人とも入った", JSON.stringify((q.handledCids || []).slice().sort()) === JSON.stringify(["c1", "c2", "c3"]), JSON.stringify(q.handledCids));
  ok("7-1 ループは正常に終わっている", w.sw.get("_manualBulkAlive") === false && q.done === true);

  // 7-2 ストップした回は全件完了を出さない
  w = sim.createWorld({ customers: customers(3) });
  const sw2 = await start(w, 3);
  await w.run(40000);
  require("vm").runInContext("with (__auto) { _batchShouldStop = true }", sw2.sandbox);
  await w.run(20 * 60000);
  ok("7-2 ストップ → 全件完了は出ない", allDoneN(w) === 0, String(allDoneN(w)));

  // 7-3 1人目の送付完了の合図が落ち、裏も止められても、起こしは2人目から（3人目へ飛ばない・1人目に戻らない）
  w = sim.createWorld({ customers: customers(3), page: (cid) => (cid === "c1" ? { dropBatchDone: true } : {}) });
  await start(w, 3);
  await w.run(60000);
  w.killSw("idle");
  await w.run(15 * 60000);
  ok("7-3 起こしても c1→c2→c3（c1 の二重・c2 の飛ばしなし）", JSON.stringify(filled(w)) === JSON.stringify(["c1", "c2", "c3"]), filled(w).join(","));

  // 7-4 位置の記録（bulk_pos）が各客の段に残る
  w = sim.createWorld({ customers: customers(3) });
  await start(w, 3);
  await w.run(20 * 60000);
  const posSteps = [];
  w.db.forEach((r) => (r.steps || []).forEach((s) => { if (s && s.k === "bulk_pos") posSteps.push(String(s.d || "")); }));
  const posStr = posSteps.join("\n");
  ok("7-4 bulk_pos が記録に載る（3人分）", ["1/3", "2/3", "3/3"].every((s) => posStr.indexOf(s) >= 0), posSteps.length + "件");

  // 7-5 止めてリセットした時、その場で「止めた」として閉じる（abandoned にしない）
  w = sim.createWorld({ customers: customers(3) });
  const sw5 = await start(w, 3);
  await w.run(40000);
  sw5.call("_bulkResetAll", "user_reset");
  await w.run(60000);
  const fin = [];
  w.db.forEach((r) => { if (r && r.status === "finished" && /bulk_ended: user_reset/.test(String(r.error || ""))) fin.push(r); });
  ok("7-5 止めてリセット → finished（bulk_ended・stopped）を送る", fin.length >= 1 && fin[0].error_kind === "stopped", fin.length + "件");

  console.log("\n■ ⑧ 記録（コード）");
  ok("_bulkEndNow が回を閉じる", /function|async function _bulkEndNow/.test(bg) && /_auditFinish\(_bulkPhaseRunId, \{ error: "bulk_ended: " \+ w, error_kind: "stopped" \}\)/.test(bg));
  ok("bulk_pos を残す", /_auditStep\(_bulkAudit\.runId, "bulk_pos"/.test(bg));

  console.log("\n" + (fail ? "❌ " : "✅ ") + "pass=" + pass + " fail=" + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("NG: sim 例外 " + (e && e.stack || e)); process.exit(1); });
