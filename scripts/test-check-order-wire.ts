// scripts/test-check-order-wire.ts — 判断の順番の型を meta につなぐ土台（app/lib/check-order-wire.ts）のテスト（LLM/DB なし・費用0・作業員22）
// 実行: npx tsx scripts/test-check-order-wire.ts
import assert from "node:assert/strict";
import { cuesFromMeta, checkOrderRecord, checkOrderDigest } from "../app/lib/check-order-wire";
import { checkOrderMode, CHECK_ORDER_TYPES } from "../app/lib/check-order";
import { allocationFromMeta } from "../app/lib/conductor-allocation";
import { toFreshDigest } from "../app/lib/brain-layers";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const sent = { action_ledger: { summary: "", facts: { propertiesSentCount: 3, estimateSent: false, pickupPromisedUnfulfilled: false, lastStaffEntry: { kind: "aix", status: "sent" } } } };

t("既定は off（CHECK_ORDER_TABLE 未設定）", () => {
  const prev = process.env.CHECK_ORDER_TABLE;
  delete process.env.CHECK_ORDER_TABLE;
  assert.equal(checkOrderMode(), "off");
  process.env.CHECK_ORDER_TABLE = "shadow"; assert.equal(checkOrderMode(), "shadow");
  if (prev === undefined) delete process.env.CHECK_ORDER_TABLE; else process.env.CHECK_ORDER_TABLE = prev;
});

t("off の時は digest に co が無い（meta に check_order が無い）", () => {
  const d = toFreshDigest({ analyzed_msg_ts: null, action: "property_send" }, null) as Record<string, unknown>;
  assert.ok(!("co" in d));
  const rec = checkOrderRecord({ ...sent }, "property_share");
  const d2 = toFreshDigest({ analyzed_msg_ts: null, action: "property_send", check_order: rec }, null) as Record<string, unknown>;
  assert.equal(d2.co, "T4|property_share");
  assert.equal(d2.aix, d.aix);
});

t("返信か AIX かの欄（action・reply_mode・aix_now・turn_contract の route）は手がかりに使わない", () => {
  const base = { ...sent, customer_questions: ["初期費用はいくら？"], turn_contract: { asks: [{ quote: "初期費用", kind: "question", basis: "company_fact", route: "reply" }] } };
  const a = checkOrderRecord({ ...base, action: "estimate_sheet", reply_mode: "aix", aix_now: "estimate_sheet" }, "cost");
  const b = checkOrderRecord({ ...base, action: null, reply_mode: "auto_reply", turn_contract: { asks: [{ quote: "初期費用", kind: "question", basis: "company_fact", route: "aix" }] } }, "cost");
  assert.deepEqual(a, b);
  assert.equal(a.type, "T8_cost");
});

t("場面と読みから型を選ぶ（物件が届いた・お礼・検討・条件・初回・結果が揃った・T12）", () => {
  assert.equal(checkOrderRecord(sent, "property_share").type, "T4_property_shared");
  assert.equal(checkOrderRecord({ ...sent, read_candidates: { turn: "brought_property", options: [], chosen: null, by: null } }, "other").type, "T4_property_shared");
  assert.equal(checkOrderRecord(sent, "ack").type, "T5_ack_hypothesis");
  assert.equal(checkOrderRecord(sent, "considering").type, "T6_considering");
  assert.equal(checkOrderRecord({ ...sent, condition_change_type: "rent_change" }, "other").type, "T1_conditions_first");
  assert.equal(checkOrderRecord({ action_ledger: { summary: "", facts: { propertiesSentCount: 0, estimateSent: false, pickupPromisedUnfulfilled: false, lastStaffEntry: null } } }, "other").type, "T11_first_contact_hearing");
  assert.equal(checkOrderRecord({ ...sent, now_vs_later: { asked_now: [], our_open: "募集状況を確認する約束", ready_now: ["確認の結果"], this_turn: "deliver" } }, "question").type, "T10_result_ready");
  const t12 = checkOrderRecord({ ...sent, our_send_uptake: [{ part: "x", kind: "property", uptake: "accepted", hook: "hooked", degree: "strong", point: "広さ・間取り", cue: null }], customer_mindset: { state: "刺さっている", anxiety: { target: "先に取られる", direction: "前向き" }, hesitation: null, decideGap: null } }, "considering");
  assert.equal(t12.type, "T12_hooked_comparing_taken");
  assert.ok(t12.cands.includes("T6_considering"));
  assert.ok(t12.cues.includes("hooked") && t12.cues.includes("takenWorry"));
});

t("問い: 根拠（会話・資料・会社の事実）がある＝T2・根拠が無い＝スタッフしか知らない候補 T3", () => {
  const q = (basis: string | null) => checkOrderRecord({ ...sent, turn_contract: { asks: [{ quote: "畳は変えられる？", kind: "question", basis }] } }, "question");
  assert.equal(q("material").type, "T2_question_fact");
  assert.equal(q(null).type, "T3_question_staff_only");
  assert.equal(cuesFromMeta({ ...sent }, "question").staffOnly, null);
});

t("手がかりが無い番は型なし（null）・候補は表にある型だけ", () => {
  const r = checkOrderRecord({ ...sent }, "other");
  assert.equal(r.type, null);
  assert.equal(checkOrderDigest(r), null);
  const known = new Set(CHECK_ORDER_TYPES.map((x) => x.id));
  for (const sc of ["ack", "question", "conditions", "property_share", "cost", "viewing", "apply", "considering", "other"]) for (const c of checkOrderRecord({ ...sent, customer_questions: ["?"] }, sc).cands) assert.ok(known.has(c), c);
  assert.equal(checkOrderRecord(null, null).type, null);
});

t("配分が型の id を読む（場面より先）", () => {
  const rec = checkOrderRecord({ ...sent, our_send_uptake: [{ hook: "hooked" }], customer_mindset: { anxiety: { target: "先に取られる" } } }, "considering");
  const a = allocationFromMeta({ check_order_type: rec.type, scene_evidence: { scene: "considering" } })!;
  assert.equal(a.name, "T12_hooked_comparing_taken/d");
  assert.equal(a.from, "type");
});

console.log(`\n${n} 件 ok`);
