// npx tsx app/lib/__tests__/compose-vocab.test.ts
import assert from "node:assert/strict";
import { composeVocabUnifiedOn, applySceneConstraints, requiredRolesLine, stripWritingBlueprintOrder, PART_TO_ROLES, PURPOSE_TO_ROLE, FOCUS_TO_ROLE } from "../compose-vocab";
import { buildWritingBlueprintNote, BASE_ORDER } from "../writing-blueprint";
import { readTurnUnderstanding, readSevenFields, buildSentencePlan } from "../compose-sentence-plan";
import { SENTENCE_ROLES } from "../takeuchi-anatomy-roles";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const ON = { COMPOSE_VOCAB_UNIFIED: "on" };

t("既定 off", () => { assert.equal(composeVocabUnifiedOn({}), false); assert.equal(composeVocabUnifiedOn(ON), true); });

t("対応表: 段9つ・趣旨6・重点7 は全部、文の役目13種に写る", () => {
  for (const p of BASE_ORDER) assert.ok(PART_TO_ROLES[p].length && PART_TO_ROLES[p].every((r) => (SENTENCE_ROLES as readonly string[]).includes(r)), p);
  for (const r of [...Object.values(PURPOSE_TO_ROLE), ...Object.values(FOCUS_TO_ROLE)]) assert.ok((SENTENCE_ROLES as readonly string[]).includes(r), r);
});

// 条件の番: 場面の設計図は「書かない段: 誘い」。設計図に誘導（内覧へ）の従の行があれば外す（主は外さない）
const meta = { turn_contract: { asks: [{ quote: "家賃6万までで", route: "promise", about: "search_condition" }] }, appeal_timing: { kind: "viewing", level: "suggest" } };
const plan = buildSentencePlan(readTurnUnderstanding(meta), readSevenFields(meta));

t("off の時は設計図を変えない", () => {
  const r = applySceneConstraints(plan, "conditions", {});
  assert.deepEqual(r.rows.map((x) => x.role), plan.rows.map((x) => x.role));
});
t("on: 書かない段（条件の番の誘い）に当たる従の行を外す・主は残す", () => {
  assert.deepEqual(plan.rows.map((x) => x.role), ["keep", "viewing"]);
  const r = applySceneConstraints(plan, "conditions", ON);
  assert.deepEqual(r.rows.map((x) => x.role), ["keep"]);
  assert.deepEqual(r.removed, ["viewing"]);
});
t("on: 要る段で設計図に無い役目は1行に（検討中の番の支える一言＝信頼）", () => {
  const m2 = { turn_contract: { asks: [], close_only: true } };
  const p2 = buildSentencePlan(readTurnUnderstanding(m2), readSevenFields(m2));
  const r = applySceneConstraints(p2, "considering", ON);
  assert.ok(r.requiredRoles.includes("trust"));
  assert.match(requiredRolesLine(r.requiredRoles), /要る役目.*信頼を得る/);
});
t("on: 場面の設計図の注記から並び・要る段・書かない段の行だけ外す（受けの言葉・ご査収・長さは残す）", () => {
  const wb = buildWritingBlueprintNote({ scene: "conditions", routeBranch: null, questions: [], sentThisTurn: false, promiseOutstanding: false });
  const s = stripWritingBlueprintOrder(wb);
  assert.doesNotMatch(s, /この順で段を組む|要る段: |書かない段: /);
  assert.match(s, /文の設計図（1文ずつ・文の統括）」に従う/);
  assert.match(s, /受けの言葉/);
  assert.match(s, /長さ: /);
});
console.log(`compose-vocab: ${n} pass`);
