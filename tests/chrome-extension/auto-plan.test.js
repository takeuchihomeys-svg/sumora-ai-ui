// 実行: node tests/chrome-extension/auto-plan.test.js
// 2026-09-30 v2.5.44（拡張）: サーバーの自動便の計画 payload.plan_by_customer[id]（app/lib/auto-search-plan.ts）をお客様ごとに読む。
//   ・sort・stop_at_last・max_pages をお客様ごとに（無ければ今まで通り）
//   ・AD 並べ替えは sort="ad" の人だけ（"updated" の人・広げての続きの sort="updated" はしない）
//   ・stop_at_last:false（新規・言い直し）の人は last_by_site があっても止める線を置かない
//   ・AIX モード（🧠 でない）の PC も source=web_brain＋chain_picker の命令をそのまま実行できる（web_brain を弾く所が無い）
const fs = require("fs");
const path = require("path");
const R = require("../../chrome-extension/auto-run.js");
const U = require("../../chrome-extension/update-order-stop.js");
const M = require("../../chrome-extension/mode-core.js");
let pass = 0, fail = 0;
function eq(name, a, b) { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok ? "" : `\n      expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`)); }
function ok(name, c) { eq(name, !!c, true); }
const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");
const NOW = Date.parse("2026-09-30T08:00:00Z"); // 17:00 JST

// 本番の午前の便の形（cron 1人1命令・v2.5.44 サーバー）＋午後の便（1人1命令・2ページ・止める線あり）
const AM_NEW = {
  source: "auto_schedule", mode: "am", is_wide: false, rp_update_days: 14, sort: "ad", max_pages: 5,
  update_days_plan: { v: 1, by_customer: { c_new: { days: 14, base_days: 14, gap_hours: null, last_search_at: null, widened: false, last_by_site: { realpro: "2026-09-29T02:00:00Z" } } } },
  plan_by_customer: { c_new: { state: "new", sort: "ad", is_wide: false, days: 14, stop_at_last: false, max_pages: 5, widen_chain: true, reason: "新規" } },
};
const PM = {
  source: "auto_schedule", mode: "pm", is_wide: false, rp_update_days: 1, sort: "updated", max_pages: 5,
  update_days_plan: { v: 1, by_customer: {
    c_act: { days: 1, base_days: 1, gap_hours: 6, last_search_at: "2026-09-30T02:00:00Z", widened: false, last_by_site: { realpro: "2026-09-30T02:00:00Z", itandi: "2026-09-30T02:10:00Z" } },
    c_new: { days: 1, base_days: 1, gap_hours: 6, last_search_at: "2026-09-30T02:00:00Z", widened: false, last_by_site: { realpro: "2026-09-30T02:00:00Z" } },
  } },
  plan_by_customer: {
    c_act: { state: "active", sort: "updated", is_wide: false, days: 1, stop_at_last: true, max_pages: 2, widen_chain: false, reason: "午後" },
    c_new: { state: "new", sort: "updated", is_wide: false, days: 1, stop_at_last: true, max_pages: 2, widen_chain: false, reason: "午後" },
  },
};
// 1命令に何人も入った命令（legacy の午後・古いサーバー）で人ごとに違う計画
const MIXED = {
  source: "auto_schedule", mode: "pm", is_wide: false, rp_update_days: 1, sort: "updated", max_pages: 5,
  plan_by_customer: {
    a: { state: "new", sort: "ad", is_wide: false, days: 14, stop_at_last: false, max_pages: 5 },
    b: { state: "active", sort: "updated", is_wide: false, days: 1, stop_at_last: true, max_pages: 2 },
  },
};
// search-widen-chain が積む広げての続き（web_brain・送った後＝updated・自動便から続いた＝AIX の PC も拾える印）
const CHAIN_UPD = { source: "web_brain", is_wide: true, rp_update_days: 7, chain: { kind: "additional" }, sort: "updated", max_pages: 5, chain_picker: "aix_or_brain", chain_origin: "auto_schedule",
  update_days_plan: { v: 1, by_customer: { c1: { days: 7, base_days: 7, gap_hours: null, last_search_at: null, widened: false } } } };
const CHAIN_NEW = Object.assign({}, CHAIN_UPD, { chain: { kind: "new" }, sort: "ad" });
const MANUAL_WB = { source: "web_brain", rp_update_days: 3, update_days_plan: { v: 1, by_customer: { c1: { days: 3, base_days: 3, gap_hours: null, last_search_at: null, widened: false } } } };

console.log("\n■ planForCustomer（plan_by_customer の読み方）");
{
  eq("そのお客様の分を読む", R.planForCustomer(PM, "c_act"), { state: "active", sort: "updated", stop_at_last: true, max_pages: 2, widen_chain: false });
  eq("id は文字列でも数でも", R.planForCustomer({ plan_by_customer: { "12": { sort: "ad", stop_at_last: false, max_pages: 5 } } }, 12), { state: null, sort: "ad", stop_at_last: false, max_pages: 5, widen_chain: null });
  eq("その人の分が無い → null（今まで通り）", R.planForCustomer(PM, "zzz"), null);
  eq("plan_by_customer の無い命令 → null", R.planForCustomer({ source: "auto_schedule", mode: "am" }, "c1"), null);
  eq("変な値は null に（sort・ページ・止める線）", R.planForCustomer({ plan_by_customer: { x: { sort: "zzz", max_pages: -1, stop_at_last: "yes" } } }, "x"), { state: null, sort: null, stop_at_last: null, max_pages: null, widen_chain: null });
  eq("payload が無い → null", R.planForCustomer(null, "x"), null);
}

console.log("\n■ payloadForCustomer → optsFromPayload（お客様ごとの並び・ページ）");
{
  const a = R.payloadForCustomer(MIXED, "a", NOW), b = R.payloadForCustomer(MIXED, "b", NOW);
  eq("★ 同じ命令でも新規の人は AD 順・5ページ", R.optsFromPayload(a), { mode: "pm", rp_update_days: 1, rp_update_days_none: false, sort: "ad", max_pages: 5 });
  eq("★ 送った後の人は更新順・2ページ", R.optsFromPayload(b), { mode: "pm", rp_update_days: 1, rp_update_days_none: false, sort: "updated", max_pages: 2 });
  ok("元の命令の payload は書き換えない（_plan は写しだけ）", !("_plan" in MIXED) && a !== MIXED);
  const pmNew = R.payloadForCustomer(PM, "c_new", NOW);
  eq("午後の便: 新規も更新順・2ページ・更新日1（前回の検索が6時間前＝広げない）", R.optsFromPayload(pmNew), { mode: "pm", rp_update_days: 1, rp_update_days_none: false, sort: "updated", max_pages: 2 });
  const amNew = R.payloadForCustomer(AM_NEW, "c_new", NOW);
  eq("午前の便の新規: AD 順・更新日14・5ページ", R.optsFromPayload(amNew), { mode: "am", rp_update_days: 14, rp_update_days_none: false, sort: "ad", max_pages: 5 });
  const none = R.payloadForCustomer({ source: "auto_schedule", mode: "pm", rp_update_days: 1, sort: "updated", max_pages: 5 }, "c1", NOW);
  eq("計画の無い命令は今まで通り（上の sort・max_pages）", R.optsFromPayload(none), { mode: "pm", rp_update_days: 1, rp_update_days_none: false, sort: "updated", max_pages: 5 });
  const other = R.payloadForCustomer(MIXED, "zzz", NOW);
  ok("その人の分が無い時は元の payload のまま（_plan なし）", other === MIXED);
}

console.log("\n■ allowAdSort（お客様ごとの AD 並べ替え）");
{
  const recA = R.record("a", "realnetpro", R.optsFromPayload(R.payloadForCustomer(MIXED, "a", NOW)), NOW);
  const recB = R.record("b", "realnetpro", R.optsFromPayload(R.payloadForCustomer(MIXED, "b", NOW)), NOW);
  ok("★ sort=ad の人（新規）は AD 高い順へ並べ替える", R.allowAdSort(R.forCustomer(recA, "a", "realnetpro", NOW + 1000)));
  ok("★ sort=updated の人（送った後）は並べ替えない", !R.allowAdSort(R.forCustomer(recB, "b", "realnetpro", NOW + 1000)));
  ok("指定なし（手動）は今まで通り並べ替える", R.allowAdSort(null));
}

console.log("\n■ chain（広げての続き・web_brain）の sort・max_pages");
{
  const o = R.optsFromPayload(R.payloadForCustomer(CHAIN_UPD, "c1", NOW));
  eq("★ 送った後の広げて: sort=updated・5ページ（旧は null＝AD 順）", o, { mode: null, rp_update_days: 7, rp_update_days_none: false, sort: "updated", max_pages: 5 });
  ok("★ sort=updated の広げては AD 並べ替えをしない", !R.allowAdSort(R.forCustomer(R.record("c1", "realnetpro", o, NOW), "c1", "realnetpro", NOW)));
  const n = R.optsFromPayload(R.payloadForCustomer(CHAIN_NEW, "c1", NOW));
  ok("新規の広げて（sort=ad）は AD 並べ替え", n.sort === "ad" && R.allowAdSort(R.forCustomer(R.record("c1", "realnetpro", n, NOW), "c1", "realnetpro", NOW)));
  eq("手の AIXツールの一括検索（sort も max_pages も無い）は今まで通り", R.optsFromPayload(R.payloadForCustomer(MANUAL_WB, "c1", NOW)), { mode: null, rp_update_days: 3, rp_update_days_none: false, sort: null, max_pages: null });
  eq("web_brain で計画も sort も無い → null（今まで通り）", R.optsFromPayload({ source: "web_brain", rp_update_days: 3 }), null);
  eq("pageLimit: 広げての max_pages を使う", R.pageLimit(o, R.DEFAULT_MAX_PAGES), 5);
  eq("pageLimit: 午後の便は2ページ", R.pageLimit(R.optsFromPayload(R.payloadForCustomer(PM, "c_act", NOW)), R.DEFAULT_MAX_PAGES), 2);
}

console.log("\n■ stop_at_last（前回の検索より古い行で止める線）");
{
  const amNew = R.payloadForCustomer(AM_NEW, "c_new", NOW);
  ok("★ stop_at_last:false（新規・言い直し）は last_by_site があっても線を置かない", !R.stopLineAllowed(amNew) && !!U.lastSearchFor(AM_NEW.update_days_plan.by_customer.c_new, "realnetpro"));
  ok("★ stop_at_last:true（午後・送った後）は置く", R.stopLineAllowed(R.payloadForCustomer(PM, "c_act", NOW)) && U.lastSearchFor(PM.update_days_plan.by_customer.c_act, "realnetpro") === "2026-09-30T02:00:00Z");
  ok("計画の無い命令は今まで通り置いてよい", R.stopLineAllowed(R.payloadForCustomer({ source: "auto_schedule", mode: "pm" }, "c1", NOW)) && R.stopLineAllowed(null));
  const bg = read("background.js");
  ok("background: 線は stopLineAllowed(_custPayload) の時だけ", /var _uoLast = \(!batchIsWide && !searchOverride [\s\S]{0,300}_AR\.stopLineAllowed\(_custPayload\)\)\)\s*\n\s*\? self\.AxlxUpdateOrderStop\.lastSearchFor/.test(bg));
  ok("background: 指定はお客様の写し（_custPayload）から（_autoOpts はその後の予備）", /_AR\.optsFromPayload\(_custPayload\) \|\| _autoOpts/.test(bg));
  ok("background: _buildBatchConditions の並び・ページは optsFromPayload の1か所から", /sort_order: _arOpts \? \(_arOpts\.sort \|\| null\) : null,\s*\n\s*max_pages: _arOpts \? \(_arOpts\.max_pages \|\| null\) : null/.test(bg));
  ok("background: 自動便の上の sort だけを読む所が残っていない", !/sort_order: autoSched/.test(bg));
}

console.log("\n■ AIX モード（🧠 でない）の PC が web_brain＋chain_picker を実行できる");
{
  const aix = M.behavior("aix", false);
  ok("AIX の PC は ?aix=1 で拾う（サーバーが chain_picker=aix_or_brain を足して渡す）", aix.claimCommands && aix.claimAix && !aix.claimBrainCommands);
  const bg = read("background.js");
  // 見送り（cancelled）は自動便（auto_schedule）×ブレイン中だけ。web_brain を弾く所は無い
  const cancels = bg.match(/cmd\.payload\.source === "[a-z_]+" && _bh\.runAutoSchedule === false/g) || [];
  eq("拾った後の見送りは auto_schedule だけ", cancels, ['cmd.payload.source === "auto_schedule" && _bh.runAutoSchedule === false']);
  ok("web_brain をブレインの PC だけと見て弾く条件が無い", !/source === "web_brain"[^\n]{0,80}(return|cancelled)/.test(bg) && !/if \([^\n]{0,60}isWebBrain[^\n]{0,60}(_bh\.|brainMode|claimBrain)/.test(bg));
  ok("pending の取り方は mode-core の behavior（aix=1 / brain=1）", /if \(_bh\.claimAix\) _qs\.push\("aix=1"\);/.test(bg) && /if \(_bh\.claimBrainCommands\) _qs\.push\("brain=1"\);/.test(bg));
}

console.log("\n■ 心拍（running のまま30分で戻す見張りに掛けない）");
{
  const bg = read("background.js");
  ok("_watchProgress が10分おきに heartbeat を送る", /if \(_batchWatch\.commandId && now - _heartbeatAt > 10 \* 60000\) \{\s*\n\s*_heartbeatAt = now;\s*\n\s*try \{ _updateBatchCommand\(_batchWatch\.commandId, \{ heartbeat: true \}\); \} catch \(_\) \{\}/.test(bg));
  ok("版 2.5.45", JSON.parse(read("manifest.json")).version === "2.5.45");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
