// app/lib/__tests__/auto-search-plan.test.ts
// v2.5.44 自動便の状態で分ける回し方（2026-09-30 竹内さんの決定）のテスト。
// 材料は本番の 2026-09-30 のお客様の状態（scripts/audit-auto-search-plan.ts --json・id は先頭8文字・名前なし）。
// 実行: npx tsx app/lib/__tests__/auto-search-plan.test.ts
import {
  classifyAutoSearchState, planFor, selectPlannedTargets, dormantWeekdays, priorityOfState, planByCustomerPayload, planOfPayload, planEnv,
  PLAN_TABLE, NEW_UPDATE_DAYS, PLAN_MAX_PAGES, OFF_AFTER_DAYS, PM_PLAN, pmRunDecision, type AutoSearchStateInput,
} from "../auto-search-plan";
import { SEARCH_MAX_PAGES, MAX_TARGETS_PER_RUN } from "../auto-search-schedule";
import * as fs from "fs";
import * as path from "path";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra: unknown = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra !== "" ? ` -- ${JSON.stringify(extra).slice(0, 400)}` : ""}`); }
}
// 2026-09-30（水）10:00 JST
const NOW = Date.parse("2026-09-30T10:00:00+09:00");
const DATE = "2026-09-30";
const base = { has_condition: true } as const;

// ── 本番の実物（2026-09-30） ──
const NEW_HOT: AutoSearchStateInput = { ...base, id: "bce0d0df", status: "hot", created_at: "2026-08-31T14:33:40Z", first_proposal_at: null, last_proposal_at: null, last_customer_msg_at: "2026-09-06T07:47:11Z", last_condition_change_at: null, last_search_by_site: null };
const NEW_INQ: AutoSearchStateInput = { ...base, id: "aa28c294", status: "new_inquiry", created_at: "2026-09-07T04:31:27Z", first_proposal_at: null, last_proposal_at: null, last_customer_msg_at: "2026-09-07T04:31:19Z", last_condition_change_at: null, last_search_by_site: null };
const COND: AutoSearchStateInput = { ...base, id: "a9bd4ddd", status: "hot", created_at: "2026-09-14T08:25:40Z", first_proposal_at: "2026-09-14T01:28:44Z", last_proposal_at: "2026-09-29T03:34:50Z", last_customer_msg_at: "2026-09-29T15:16:47Z", last_condition_change_at: "2026-09-29T02:46:45Z", last_search_by_site: { realpro: "2026-09-29T01:53:08Z" } };
const COND_NOSEARCH: AutoSearchStateInput = { ...base, id: "3c7cac82", status: "hot", created_at: "2026-09-25T03:13:25Z", first_proposal_at: "2026-09-25T04:43:24Z", last_proposal_at: "2026-09-25T04:43:39Z", last_customer_msg_at: "2026-09-26T08:44:56Z", last_condition_change_at: "2026-09-25T07:34:59Z", last_search_by_site: null };
const ACTIVE_HOT: AutoSearchStateInput = { ...base, id: "96572af8", status: "hot", created_at: "2026-09-13T01:29:20Z", first_proposal_at: "2026-09-14T08:43:56Z", last_proposal_at: "2026-09-23T04:28:56Z", last_customer_msg_at: "2026-09-28T09:59:56Z", last_condition_change_at: "2026-09-14T03:33:51Z", last_search_by_site: null };
const ACTIVE: AutoSearchStateInput = { ...base, id: "a26a8042", status: "property_search", created_at: "2026-06-20T07:17:35Z", first_proposal_at: "2026-08-17T06:46:16Z", last_proposal_at: "2026-09-23T02:50:12Z", last_customer_msg_at: "2026-09-08T04:34:47Z", last_condition_change_at: "2026-09-09T04:55:58Z", last_search_by_site: null };
const DORMANT_HOT: AutoSearchStateInput = { ...base, id: "d3826766", status: "hot", created_at: "2026-09-11T01:41:10Z", first_proposal_at: "2026-09-13T07:21:13Z", last_proposal_at: "2026-09-13T07:21:14Z", last_customer_msg_at: "2026-09-14T08:24:43Z", last_condition_change_at: "2026-09-11T03:02:41Z", last_search_by_site: null };
const DORMANT: AutoSearchStateInput = { ...base, id: "4d51caa5", status: "property_search", created_at: "2026-09-11T22:33:23Z", first_proposal_at: "2026-09-11T09:24:58Z", last_proposal_at: "2026-09-18T07:37:15Z", last_customer_msg_at: "2026-09-12T03:53:59Z", last_condition_change_at: null, last_search_by_site: { realpro: "2026-09-28T03:54:53Z" } };
const DORMANT2: AutoSearchStateInput = { ...base, id: "42a89f52", status: "property_search", created_at: "2026-09-05T21:00:05Z", first_proposal_at: "2026-09-06T03:41:30Z", last_proposal_at: "2026-09-22T03:39:52Z", last_customer_msg_at: "2026-09-17T09:21:37Z", last_condition_change_at: "2026-09-06T03:03:45Z", last_search_by_site: { itandi: "2026-09-28T02:06:37Z" } };
const OLD_NEVER: AutoSearchStateInput = { ...base, id: "ab29f4bb", status: "property_search", created_at: "2026-05-19T07:40:35Z", first_proposal_at: null, last_proposal_at: null, last_customer_msg_at: null, last_condition_change_at: null, last_search_by_site: null };

const S = (i: AutoSearchStateInput) => classifyAutoSearchState(i, NOW).state;

console.log("── 状態（実際の送付・発言・条件の変更で決める）");
t("★ 新規: 届けた送付0件（登録から1か月・status=hot でも新規＝登録日数で切らない）", S(NEW_HOT) === "new" && S(NEW_INQ) === "new");
t("★ 条件の言い直し: 前回の検索（9/29 10:53）の後に条件が変わった（11:46）", S(COND) === "cond_changed");
t("条件の言い直し: 前回の検索の記録が無い人も7日以内の変更なら", S(COND_NOSEARCH) === "cond_changed");
t("言い直しでも次の検索（変更より後）が終われば元の状態へ（1回だけ）", classifyAutoSearchState({ ...COND, last_search_by_site: { realpro: "2026-09-30T02:00:00Z" } }, NOW).state === "active");
t("8日より前の変更は言い直しにしない", classifyAutoSearchState({ ...COND_NOSEARCH, last_condition_change_at: "2026-09-21T00:00:00Z" }, NOW).state !== "cond_changed");
t("★ 動いている: 発言2日前（送付7日前）", S(ACTIVE_HOT) === "active");
t("動いている: 送付7日前（発言22日前）＝7日以内は動いている", S(ACTIVE) === "active");
t("★ 要対応で止まっている: 送付17日前・発言16日前・status=hot", S(DORMANT_HOT) === "dormant_hot");
t("★ 止まっている: 送付12日前・発言18日前（8日以上なし）", S(DORMANT) === "dormant" && S(DORMANT2) === "dormant");
t("何も動きが無いまま30日を超えた（5月登録・送付も発言も無し）→ 対象外", S(OLD_NEVER) === "off" && OFF_AFTER_DAYS === 30);
t("申込中・保留・条件なし・送付が読めない → 対象外",
  classifyAutoSearchState({ ...ACTIVE, status: "applying" }, NOW).state === "off" && classifyAutoSearchState({ ...ACTIVE, status: "pending" }, NOW).state === "off"
  && classifyAutoSearchState({ ...ACTIVE, has_condition: false }, NOW).state === "off" && classifyAutoSearchState({ ...ACTIVE, first_proposal_at: undefined }, NOW).state === "off");
t("8日目で止まっている（7日は動いている）", classifyAutoSearchState({ ...DORMANT, last_proposal_at: "2026-09-22T03:00:00Z", last_customer_msg_at: null }, NOW).state === "dormant"
  && classifyAutoSearchState({ ...DORMANT, last_proposal_at: "2026-09-23T03:00:00Z", last_customer_msg_at: null }, NOW).state === "active");

console.log("── 回し方の表（午前）");
for (const mode of ["am"] as const) {
  const n = planFor("new", mode, DATE, NEW_HOT.id)!;
  t(`★ ${mode}: 新規は AD 順・更新日14・止める線なし・ピンポイント・5ページ`, n.sort === "ad" && n.days === NEW_UPDATE_DAYS && n.days === 14 && !n.stop_at_last && n.is_wide === false && n.max_pages === 5, n);
  const c = planFor("cond_changed", mode, DATE, COND.id)!;
  t(`★ ${mode}: 言い直しの直後は新規と同じ`, c.sort === "ad" && c.days === 14 && !c.stop_at_last, c);
  const a = planFor("active", mode, DATE, ACTIVE.id, { lastSearchAt: "2026-09-29T08:00:00Z", nowMs: NOW })!;
  t(`★ ${mode}: 送った後は更新順・前回の検索以降だけ（止める線・元の更新日1＝空きで広げる）`, a.sort === "updated" && a.stop_at_last && a.days === 1, a);
  const h = planFor("dormant_hot", mode, DATE, DORMANT_HOT.id, { lastProposalAt: DORMANT_HOT.last_proposal_at, nowMs: NOW })!;
  t(`★ ${mode}: 要対応で止まっている人は毎日・更新順（前回の検索の記録なし→最後に届けた17日前から＝14）`, !!h && h.sort === "updated" && h.stop_at_last && h.days === 14, h);
}
console.log("── 午後の便（2026-09-30 竹内「午後の便は今日の更新がないか見るだけ…もっと限定的に」）");
{
  const afterAm = "2026-09-30T02:10:00Z"; // 今日の午前の検索
  for (const [st, id] of [["new", NEW_HOT.id], ["cond_changed", COND.id], ["active", ACTIVE.id], ["dormant_hot", DORMANT_HOT.id]] as const) {
    const p = planFor(st, "pm", DATE, id, { lastSearchAt: afterAm, nowMs: NOW })!;
    t(`★ pm ${st}: 更新順・更新日1・午前以降だけ（止める線）・2ページ・広げてなし（新規も AD 順にしない）`, !!p && p.sort === "updated" && p.days === 1 && p.stop_at_last && p.max_pages === 2 && p.widen_chain === false && p.is_wide === false, p);
  }
  const noSearchNew = planFor("new", "pm", DATE, NEW_HOT.id, { nowMs: NOW })!;
  t("pm: 前回の検索が無い新規は更新日14（空きで広げる）・並びは更新順", noSearchNew.days === 14 && noSearchNew.sort === "updated", noSearchNew);
  const noSearchAct = planFor("active", "pm", DATE, ACTIVE.id, { lastProposalAt: ACTIVE.last_proposal_at, nowMs: NOW })!;
  t("pm: 前回の検索が無い送った後の人は最後に届けた日から（7日前→7）・更新順", noSearchAct.days === 7 && noSearchAct.sort === "updated");
  t("pm の表は1か所（PM_PLAN）: 2ページ・広げてなし・止める線あり", PM_PLAN.max_pages === 2 && PM_PLAN.widen_chain === false && PM_PLAN.stop_at_last && PM_PLAN.sort === "updated");
  t("午前は広げての続きを許す（widen_chain）", planFor("new", "am", DATE, NEW_HOT.id)!.widen_chain === true);
  t("AUTO_SEARCH_STOP_AT_LAST=off は午後も止める線なし", planFor("active", "pm", DATE, "x", { lastSearchAt: afterAm, stopAtLast: false })!.stop_at_last === false);
  const NOW_PM = Date.parse("2026-09-30T16:00:00+09:00");
  t("★ 今日の検索で通す候補が1件でもあれば午後は回さない", pmRunDecision({ ...ACTIVE, pass_today: 3 }, NOW_PM).run === false);
  t("★ 午前に検索して候補0件 → 回す（理由: 今日の検索で候補0件）", (() => { const d = pmRunDecision({ ...ACTIVE, pass_today: 0, last_search_by_site: { realpro: afterAm } }, NOW_PM); return d.run && d.why.startsWith("今日の検索で通す候補0件"); })());
  t("★ 今日まだ検索が終わっていない（午前に回らなかった・失敗・時間切れ）→ 回す", (() => { const d = pmRunDecision({ ...ACTIVE, pass_today: 0, last_search_by_site: { realpro: "2026-09-29T02:00:00Z" } }, NOW_PM); return d.run && d.why.startsWith("今日まだ検索が終わっていない"); })());
  t("候補の数が読めない → 回す（検索は止めない側）", pmRunDecision({ ...ACTIVE, pass_today: undefined }, NOW_PM).run === true);
}
t("前回の検索が無い送った後の人: 最後に届けた日から（7日前→7）", planFor("active", "am", DATE, ACTIVE.id, { lastProposalAt: ACTIVE.last_proposal_at, nowMs: NOW })!.days === 7);
t("週1回の AD 順は無い（送った後はどの曜日も更新順）", [0, 1, 2, 3, 4, 5, 6].every((k) => {
  const d = new Date(Date.parse(`${DATE}T12:00:00+09:00`) + k * 86400_000 + 9 * 3600_000).toISOString().slice(0, 10);
  return planFor("active", "am", d, ACTIVE.id)!.sort === "updated";
}));
t("表は1か所: 並びが AD 順なのは新規と言い直しだけ", Object.entries(PLAN_TABLE).filter(([, r]) => r.sort === "ad").map(([k]) => k).join() === "new,cond_changed");
t("ページの上限は自動便と同じ 5", PLAN_MAX_PAGES === SEARCH_MAX_PAGES);
t("AUTO_SEARCH_STOP_AT_LAST=off → 止める線なし", planFor("active", "am", DATE, "x", { lastSearchAt: "2026-09-29T08:00:00Z", stopAtLast: false })!.stop_at_last === false
  && planEnv({ AUTO_SEARCH_STOP_AT_LAST: "off" }).stopAtLast === false && planEnv({}).stopAtLast === true && planEnv({ AUTO_SEARCH_PLAN: "legacy" }).legacy === true);
t("対象外はどの便にも入れない", planFor("off", "am", DATE, "x") === null);

console.log("── 止まっている人は週2回（その日の午前・午後はその日で午前の候補0件の時だけ＝selectPlannedTargets）");
{
  const week = Array.from({ length: 7 }, (_, k) => new Date(Date.parse("2026-09-28T12:00:00+09:00") + k * 86400_000 + 9 * 3600_000).toISOString().slice(0, 10)); // 月〜日
  for (const c of [DORMANT, DORMANT2]) {
    const am = week.filter((d) => planFor("dormant", "am", d, c.id) !== null).length;
    const pmDays = week.filter((d) => planFor("dormant", "pm", d, c.id) !== null);
    const amDays = week.filter((d) => planFor("dormant", "am", d, c.id) !== null);
    t(`★ ${c.id}: 1週間で午前2回・午後はその2日だけ（候補0件の時）`, am === 2 && JSON.stringify(pmDays) === JSON.stringify(amDays), { am, pmDays, days: dormantWeekdays(DATE, c.id) });
  }
  const wd = dormantWeekdays(DATE, DORMANT.id);
  t("2つの曜日は2日以上離す", wd.length === 2 && Math.min((wd[1] - wd[0] + 7) % 7, (wd[0] - wd[1] + 7) % 7) >= 2, wd);
  // 60人で曜日がばらける（全員同じ曜日にならない）
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 60; i++) for (const w of dormantWeekdays(DATE, `c${i}`)) counts[w]++;
  t("お客様ごとに曜日がばらける（どの曜日も60人中30人を超えない・0人の曜日なし）", counts.every((x) => x > 0 && x <= 30), counts);
  t("同じ週・同じ人は同じ曜日（cron の再実行で変わらない）", JSON.stringify(dormantWeekdays(DATE, DORMANT.id)) === JSON.stringify(dormantWeekdays("2026-10-01", DORMANT.id)));
}

console.log("── 今日の対象（本番の実物の10人 × 朝夕）");
{
  const all = [NEW_HOT, NEW_INQ, COND, COND_NOSEARCH, ACTIVE_HOT, ACTIVE, DORMANT_HOT, DORMANT, DORMANT2, OLD_NEVER];
  const am = selectPlannedTargets(all, "am", DATE, NOW);
  t("状態の内訳", JSON.stringify(am.byState) === JSON.stringify({ new: 2, cond_changed: 2, active: 2, dormant_hot: 1, dormant: 2, off: 1 }), am.byState);
  const order = am.targets.map((x) => `${x.state}:${x.priority}`);
  const pr = am.targets.map((x) => x.priority);
  t("★ 優先: ③言い直し → ①新規 → 要対応（動いている hot・止まっている hot）→ ②動いている → ④止まっている", pr.every((p, k) => k === 0 || pr[k - 1] <= p)
    && am.targets[0].state === "cond_changed" && am.targets.findIndex((x) => x.id === DORMANT_HOT.id) < am.targets.findIndex((x) => x.id === ACTIVE.id)
    && am.targets.findIndex((x) => x.id === ACTIVE_HOT.id) < am.targets.findIndex((x) => x.id === ACTIVE.id), order);
  t("要対応（hot）の動いている人は要対応の段", priorityOfState("active", "hot") === 2 && priorityOfState("active", "property_search") === 3 && priorityOfState("dormant", null) === 4);
  const NOW_PM = Date.parse("2026-09-30T16:00:00+09:00");
  // 午後: 午前で候補が出た人（pass_today>0）は回さない。0件の人・今日まだの人だけ
  const withPass = all.map((x, k) => ({ ...x, pass_today: k % 2 === 0 ? 2 : 0 }));
  const pm = selectPlannedTargets(withPass, "pm", DATE, NOW_PM);
  t("★ 午後は今日の候補0件の人だけ（候補のある人は notThisRun に理由）", pm.targets.every((x) => withPass.find((y) => y.id === x.id)!.pass_today === 0)
    && pm.notThisRun.some((x) => x.why.startsWith("今日の検索で通す候補 2件")), pm.targets.map((x) => x.id));
  t("★ 午後の対象には理由（runReason）が付く", pm.targets.length > 0 && pm.targets.every((x) => typeof x.runReason === "string" && x.runReason.length > 0));
  t("午後: 止まっている人は週2回の日でなければ回さない", !pm.targets.some((x) => x.state === "dormant") && pm.notThisRun.filter((x) => x.state === "dormant" && x.why.startsWith("週2回の日でない")).length === 2);
  const cut = selectPlannedTargets(all, "am", DATE, NOW, { limit: 3 });
  t("上限で切る（上位から・残りは overLimit）", cut.targets.length === 3 && cut.overLimit.length === am.targets.length - 3 && cut.targets.map((x) => x.id).join() === am.targets.slice(0, 3).map((x) => x.id).join() && MAX_TARGETS_PER_RUN === 60);
  // payload の形（拡張が読む）
  const pbc = planByCustomerPayload(am.targets.map((x) => ({ id: x.id, plan: x.plan, days: x.state === "active" ? 3 : x.plan.days })));
  const e = pbc[ACTIVE.id];
  t("★ plan_by_customer[id] = { state, sort, is_wide:false, days, stop_at_last, max_pages, widen_chain, reason }", !!e && Object.keys(e).join() === "state,sort,is_wide,days,stop_at_last,max_pages,widen_chain,reason" && e.days === 3 && e.sort === "updated" && e.stop_at_last === true && e.widen_chain === true, e);
  t("planOfPayload で読める・無い人は undefined", planOfPayload({ plan_by_customer: pbc }, NEW_HOT.id)?.sort === "ad" && planOfPayload({ plan_by_customer: pbc }, "nobody") === undefined && planOfPayload({}, NEW_HOT.id) === undefined);
}

console.log("── 状態は last_property_sent_at で決めない（9/30 の監査: 列で「直近3日」の53人のうち42人は実際の送付が4日以上前・無し）");
{
  // 列は今日（自動検索の回で merge-pdfs が書いた）でも、実際にお客様へ届けたのは12日前・発言18日前 → 止まっている
  const withDirtyCol = { ...DORMANT, last_property_sent_at: "2026-09-30T01:00:00Z" } as AutoSearchStateInput & { last_property_sent_at: string };
  t("★ 列が今日でも止まっている", S(withDirtyCol) === "dormant");
}

console.log("── 配線");
{
  const root = path.join(__dirname, "..", "..", "..");
  const route = fs.readFileSync(path.join(root, "app/api/cron/auto-property-search/route.ts"), "utf8");
  t("cron: 状態で選ぶ（selectPlannedTargets・loadStateInputs）・legacy で今まで", route.includes("selectPlannedTargets(") && route.includes("loadStateInputs(") && route.includes("selectAutoSearchTargets(withCondition"));
  t("cron: payload に plan_by_customer・dry_run に状態の内訳", route.includes("plan_by_customer: pbc") && route.includes("states: stateBreakdown"));
  t("★ cron: 計画の時は午後も1人1命令（一括は legacy だけ）", route.includes(`if (isBatchedRun(mode) && planMode === "legacy") {`));
  t("cron: dry_run の明細に午後の対象の理由", route.includes("run_reason: stateById.get(id)?.runReason"));
  t("材料: 今日の候補（property_pickups verdict=pass）を読む", fs.readFileSync(path.join(root, "app/lib/auto-search-plan-server.ts"), "utf8").includes(`.eq("verdict", "pass").gte("created_at", mid)`));
  const srv = fs.readFileSync(path.join(root, "app/lib/auto-search-plan-server.ts"), "utf8");
  t("材料に last_property_sent_at を読まない・isProposalSend を使う", !srv.includes(".select(\"id, last_property_sent_at") && !/select\([^)]*last_property_sent_at/.test(srv) && srv.includes("isProposalSend("));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
