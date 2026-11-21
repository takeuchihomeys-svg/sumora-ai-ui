// お客様ごとの全体の統括の計画（作業員M 2026-11-21・台帳 #101）
// 実行: npx tsx app/lib/__tests__/customer-plan.test.ts
import { customerPlanMode, buildCustomerPlan, planChangedFields, conductorBriefPlanOn, planBriefSection } from "../customer-plan";
let passed = 0, failed = 0;
const t = (name: string, ok: boolean, extra?: unknown) => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`, extra ?? ""); } };

t("既定 shadow・off で止まる", customerPlanMode({}) === "shadow" && customerPlanMode({ CUSTOMER_PLAN: "off" }) === "off");
const meta = {
  analyzed_msg_ts: "2026-11-21T01:00:00Z",
  checkpoint_stage: "proposing",
  conductor_focus: { focus: "push_viewing" },
  turn_aims: { state: "刺さっている", turn_aim: "内覧の日を決める", mid_aim: "今週中に内覧", plant: "抑えの提案" },
  conductor_brief: { next: { dest: "viewing", strength: "invite", timing: "now" } },
  next_send_link: { kind: "same_property", refs: [{ sent_id: "sf:a|aix|properties_sent" }], why: "x" },
  situation_now: { v: 1, promises_open: [{ promise_id: "sf:p|manual|check_promised", kind: "check_promised", due_h: 5 }], sent: [{ sent_id: "s1", kind: "properties_sent", props: ["物件A"] }, { sent_id: "s2", kind: "estimate_sent", props: [] }] },
  ask_ledger: { items: [{ id: "qaaa", route: "reply" }, { id: "qbbb", route: "none" }] },
  customer_mindset: { state: "刺さっている" },
  property_search_params: { area: "北区", rent_max: 80000, layouts: ["1LDK", "2K"], ng_properties: [{ property_name: "x" }], customer_name: "伏せる" },
};
const p1 = buildCustomerPlan({ meta, status: "proposing", prev: null, nowIso: "2026-11-21T01:01:00Z" })!;
t("駅・重点・狙い", p1.station.status === "proposing" && p1.station.checkpoint_stage === "proposing" && p1.focus === "push_viewing" && p1.aims.mid_aim === "今週中に内覧" && p1.aims.since === "2026-11-21T01:01:00Z", p1);
t("次に送る物（指示書の行き先・強さ・つながり）", p1.next_send.dest === "viewing" && p1.next_send.push_strength === "invite" && p1.next_send.link_kind === "same_property" && p1.next_send.link_refs[0].sent_id === "sf:a|aix|properties_sent", p1.next_send);
t("開いている約束（promise_id）", p1.promises_open.length === 1 && p1.promises_open[0].promise_id === "sf:p|manual|check_promised");
t("要件（ask_id・触れない物は除く）", JSON.stringify(p1.asks.open) === JSON.stringify(["qaaa"]) && p1.asks.promised.length === 0, p1.asks);
t("送った物（sent_id）", p1.sent_recent.length === 2 && p1.sent_recent[0].sent_id === "s1");
t("探す条件は鍵と短い値だけ（名前は入れない）", p1.property_policy.area === "北区" && p1.property_policy.layouts === "2件" && p1.property_policy.ng_properties === "1件" && !("customer_name" in p1.property_policy), p1.property_policy);
t("初めての計画", JSON.stringify(p1.changed) === JSON.stringify(["新しい計画"]));
// 次の番: 狙いは同じ・気持ちが変わった・約束が果たされた
const meta2 = { ...meta, customer_mindset: { state: "迷い" }, situation_now: { v: 1, promises_open: [], sent: meta.situation_now.sent } };
const p2 = buildCustomerPlan({ meta: meta2, status: "proposing", prev: JSON.parse(JSON.stringify(p1)), nowIso: "2026-11-21T05:00:00Z" })!;
t("中期の狙いが同じなら since を引き継ぐ", p2.aims.since === "2026-11-21T01:01:00Z", p2.aims);
t("気持ちの動き", p2.feeling.state === "迷い" && p2.feeling.prev_state === "刺さっている" && p2.feeling.moved === true, p2.feeling);
t("変わった欄", p2.changed.includes("feeling") && p2.changed.includes("promises_open") && !p2.changed.includes("aims") && !p2.changed.includes("station"), p2.changed);
// 前の番から持ち越した要件があればそれを使う
const p3 = buildCustomerPlan({ meta: { ...meta, ask_carry: { open: ["qold"], promised: ["qpro"] } }, prev: null, nowIso: "x" })!;
t("持ち越した要件（ask_carry）が先", JSON.stringify(p3.asks) === JSON.stringify({ open: ["qold"], promised: ["qpro"] }), p3.asks);
t("meta が無ければ null", buildCustomerPlan({ meta: null, nowIso: "x" }) === null);
t("meta.turn_aims のキャメルの形（turnAim・midAim）も読む", buildCustomerPlan({ meta: { turn_aims: { state: "迷い", turnAim: "見積を送る", midAim: "内覧へ", plant: "" } }, nowIso: "x" })!.aims.mid_aim === "内覧へ" && buildCustomerPlan({ meta: { turn_aims: { turnAim: "見積を送る" } }, nowIso: "x" })!.aims.turn_aim === "見積を送る");
t("気持ちが読めなかった番（null）は動きにしない", !planChangedFields(p1, { ...p1, feeling: { state: null, prev_state: "刺さっている", moved: false } }).includes("feeling"));
t("同じ計画なら変わった欄は無い", planChangedFields(p1, { ...p1, updated_at: "later", aims: { ...p1.aims, since: "other" } }).length === 0);
// 読む側（CONDUCTOR_BRIEF_PLAN・既定 off）
{
  t("CONDUCTOR_BRIEF_PLAN 既定 off", conductorBriefPlanOn({}) === false && conductorBriefPlanOn({ CONDUCTOR_BRIEF_PLAN: "on" }) === true);
  const prevPlan = JSON.parse(JSON.stringify({ ...p1, promises_open: [{ promise_id: "sf:p1", kind: "check_promised", due_h: 30 }, { promise_id: "sf:p2", kind: "x", due_h: 3 }], asks: { open: ["qa", "qb"], promised: [] } }));
  const now = Date.parse("2026-11-21T07:01:00Z");
  const sameNext = planBriefSection(prevPlan, { conductor_brief: { next: { dest: "viewing" } }, customer_mindset: { state: "迷い" } }, now)!;
  t("計画の欄: 狙い・続いている時間", sameNext.mid_aim === "今週中に内覧" && sameNext.aim_hours === 6, sameNext);
  t("計画の欄: 次の一手が計画と同じ", sameNext.next_vs_plan === "same" && sameNext.prev_next.dest === "viewing");
  t("計画の欄: 24時間以上開いている約束", JSON.stringify(sameNext.overdue_promises) === JSON.stringify(["sf:p1"]));
  t("計画の欄: 持ち越した要件の数・気持ちの動き", sameNext.carried_open === 2 && sameNext.feeling_moved === "刺さっている→迷い", sameNext);
  t("計画の欄: 次の一手が変わった", planBriefSection(prevPlan, { conductor_brief: { next: { dest: "estimate" } } }, now)!.next_vs_plan === "changed");
  t("計画の欄: 今の一手が無ければ unknown", planBriefSection(prevPlan, {}, now)!.next_vs_plan === "unknown");
  t("前の計画が無ければ null", planBriefSection(null, {}, now) === null && planBriefSection({ v: 2 }, {}, now) === null);
}
console.log(`\ncustomer-plan: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
