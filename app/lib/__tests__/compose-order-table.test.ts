// npx tsx app/lib/__tests__/compose-order-table.test.ts
import assert from "node:assert/strict";
import { composeOrderTableOn, orderTypeOf, applyOrderTable, orderBasisDigest, COMPOSE_ORDER_TABLE } from "../compose-order-table";
import { readTurnUnderstanding, readSevenFields, buildSentencePlan, sentencePlanNote, readComposeContext, handoffLeaks } from "../compose-sentence-plan";
import { CHECK_ORDER_TYPES } from "../check-order";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const ON = { COMPOSE_ORDER_TABLE: "on" };

t("既定 off・型の名前は作業員16 の確認の順番の型と同じ", () => {
  assert.equal(composeOrderTableOn({}), false);
  const ids = new Set(CHECK_ORDER_TYPES.map((x) => x.id));
  for (const k of Object.keys(COMPOSE_ORDER_TABLE)) assert.ok(ids.has(k), k);
});
t("型の決め方: 場面×主の役目（質問で主が確かめる約束＝T3）", () => {
  assert.equal(orderTypeOf("conditions", "keep"), "T1_conditions_first");
  assert.equal(orderTypeOf("question", "promise"), "T3_question_staff_only");
  assert.equal(orderTypeOf("question", "answer"), "T2_question_fact");
  assert.equal(orderTypeOf("other", "answer"), null);
});

// 費用の番（T8: 竹内さんの22通の並び answer>keep>barrier>trust）: 設計図の従が 信頼 → 申込へ の順で来ても、型の順に並べ替える
const meta = {
  turn_contract: { asks: [{ quote: "初期費用は分割できますか", route: "reply", about: "property_cost", answer: "カード払いのみ分割可" }] },
  seven_read: { point: { what: "分割の可否", how: "結論を先に" }, bridge: null, lead: "apply", appeal: null, latent: null, point_how: ["conclusion_first"], trust_how: ["support"], push: null },
};
const u = readTurnUnderstanding(meta), s = readSevenFields(meta);
const p = buildSentencePlan(u, s, { scene: "cost", ctx: readComposeContext(meta) });

t("off: 並べ替えない・判断の根拠は作る（digest 用）", () => {
  const r = applyOrderTable(p, u, "cost", {});
  assert.deepEqual(r.plan.rows.map((x) => x.role), p.rows.map((x) => x.role));
  assert.equal(r.basis.applied, false);
  assert.equal(r.basis.type, "T8_cost");
  assert.equal(r.noteLine, "");
  assert.match(orderBasisDigest(r.basis), /^型=T8_cost｜順=answer>.*｜主=answer（依頼の一番（turn_contract の lead_with））$/);
});
t("on: 主は先のまま・従は型の順・誘導の行に押す強さが無ければ型の多い形・締めの1行", () => {
  assert.deepEqual(p.rows.map((x) => x.role), ["answer", "trust", "apply"]);
  const r = applyOrderTable(p, u, "cost", ON);
  assert.equal(r.plan.rows[0].role, "answer");
  assert.deepEqual(r.plan.rows.map((x) => x.role), ["answer", "trust", "apply"]); // trust は型の順に入る・apply は型の順に無い＝後ろ
  assert.match(r.plan.rows[2].how ?? "", /押す強さ（この型の竹内さんの多い形 13\/22）: 押さない/);
  assert.match(r.noteLine, /T8_cost・竹内さんの22通.*締め（何卒 等）は無しが多い（付けたのは 4\/22）/);
});

t("作業員16 の now_vs_later・作業員17 の judge_basis も設計図に漏れなく届く", () => {
  const m2 = { ...meta, now_vs_later: { asked_now: ["初期費用は分割できるか"], our_open: "見積書を送った", ready_now: [], this_turn: "answer" }, judge_basis: { clues: ["分割の問い", "見積書の後"], readings: [{ reading: "まとまった費用が不安", focus: "answer" }], chosen: 0, chosenWhy: "費用の問い", priority: ["answer_question"], focus: "answer", order: [], orderWhy: "" } };
  const note = sentencePlanNote(buildSentencePlan(readTurnUnderstanding(m2), readSevenFields(m2), { scene: "cost", ctx: readComposeContext(m2) }));
  assert.deepEqual(handoffLeaks(m2, note), []);
  assert.match(note, /今の番と後の番（ブレイン）: 言われた事 初期費用は分割できるか・こちらの開いている事 見積書を送った・この番でする事 answer/);
  assert.match(note, /判断の根拠（ブレイン）: 手がかり 分割の問い／見積書の後・読み まとまった費用が不安（費用の問い）/);
});
console.log(`compose-order-table: ${n} pass`);
