// npx tsx app/lib/__tests__/compose-lead-judge-first.test.ts
// 手元の答案 w10-seven-on3（BRAIN_SEVEN_FIELDS=on・q022・q072）で、誘導先の食い違いの直し（COMPOSE_LEAD_JUDGE_FIRST）を確かめる
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readTurnUnderstanding, readSevenFields, buildSentencePlan, sentencePlanNote, readComposeContext, handoffLeaks, composeLeadJudgeFirstOn } from "../compose-sentence-plan";

const rows = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "scripts/compose-understanding/brains-seven-on3.json"), "utf8")) as Array<{ id: string; rep: number; brain: Record<string, unknown> }>;
const q022 = rows.find((r) => r.id === "q022" && r.rep === 3)!.brain; // seven_read.lead=answer_only・appeal_timing=apply/suggest（竹内さん＝申込へ）
const q072 = rows.find((r) => r.id === "q072" && r.rep === 1)!.brain; // seven_read.lead=viewing・方向の文=apply（竹内さん＝申込へ）
const run = (env: string | undefined, b: Record<string, unknown>) => {
  const prev = process.env.COMPOSE_LEAD_JUDGE_FIRST;
  if (env == null) delete process.env.COMPOSE_LEAD_JUDGE_FIRST; else process.env.COMPOSE_LEAD_JUDGE_FIRST = env;
  try { return readSevenFields(b); } finally { if (prev == null) delete process.env.COMPOSE_LEAD_JUDGE_FIRST; else process.env.COMPOSE_LEAD_JUDGE_FIRST = prev; }
};
let n = 0;
assert.equal(composeLeadJudgeFirstOn({}), false); n++;
// 既定 off＝7つの欄の lead のまま（今の挙動）
assert.equal(run(undefined, q022).leadTo, "answer_only"); n++;
assert.equal(run(undefined, q072).leadTo, "viewing"); n++;
// on＝判断の側（訴求のタイミング → 方向の文）を先に・7つの欄の読みは leadAlt に残す
const s22 = run("on", q022); assert.equal(s22.leadTo, "apply"); assert.equal(s22.leadAlt, "answer_only"); n++;
const s72 = run("on", q072); assert.equal(s72.leadTo, "apply"); assert.equal(s72.leadAlt, "viewing"); n++;
// 食い違わない番は触らない（q022#1: lead keep・訴求のタイミング apply → apply に・q022#2 は方向の文が無くても訴求のタイミングで apply）
const r1 = rows.find((r) => r.id === "q022" && r.rep === 1)!.brain;
assert.equal(run("on", r1).leadTo, "apply"); n++;
// 設計図の誘導の行に7つの欄の読みを添え、受け渡しの漏れは0のまま
process.env.COMPOSE_LEAD_JUDGE_FIRST = "on";
try {
  const note = sentencePlanNote(buildSentencePlan(readTurnUnderstanding(q072), readSevenFields(q072), { scene: "viewing", ctx: readComposeContext(q072) }));
  assert.match(note, /申込・抑えるへ.*7つの欄の読みは内覧（判断の側を先にした）/);
  assert.deepEqual(handoffLeaks(q072, note), []); n++;
} finally { delete process.env.COMPOSE_LEAD_JUDGE_FIRST; }
console.log(`compose-lead-judge-first: ${n} pass`);
