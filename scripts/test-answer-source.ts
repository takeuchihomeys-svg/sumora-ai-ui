// scripts/test-answer-source.ts — 答えの出所の名前の正（7つ）と読み替えの1か所（app/lib/answer-source.ts）のテスト（LLM/DB なし・費用0・作業員22）
// 実行: npx tsx scripts/test-answer-source.ts
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { ANSWER_SOURCE_KINDS, STAFF_WHO, fromBrainAnswerSource, fromContractBasis, answerSourceLabel, checkResultReadyOf } from "../app/lib/answer-source";
import { subValuesOf } from "../app/lib/decided-subfields";
import { ANSWER_SOURCES } from "../app/lib/brain-now-later";
import { PART_WHO, toComposeSource, ASK_PARTS_FIELD } from "../app/lib/ask-parts";
import { askPartsOf } from "../app/lib/compose-decided";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

t("正は7つ（作業員10 の文の側の名前）・staff_only の中は作業員7b の who と同じ3つ", () => {
  assert.deepEqual([...ANSWER_SOURCE_KINDS], ["material", "record", "conversation", "company_fact", "general", "staff_only", "checked_result"]);
  assert.deepEqual([...STAFF_WHO], [...PART_WHO]);
});

t("作業員16 の4つ → 7つ: material_value は出所の印で 資料／記録／会話・none → general・staff_only は who つき・確かめた結果があれば checked_result", () => {
  for (const s of ANSWER_SOURCES) assert.ok((ANSWER_SOURCE_KINDS as readonly string[]).includes(fromBrainAnswerSource(s).kind), s);
  assert.equal(fromBrainAnswerSource("material_value").kind, "material");
  assert.equal(fromBrainAnswerSource("material_value", { record: true }).kind, "record");
  assert.equal(fromBrainAnswerSource("material_value", { basis: "conversation" }).kind, "conversation");
  assert.equal(fromBrainAnswerSource("none").kind, "general");
  assert.deepEqual(fromBrainAnswerSource("staff_only", { who: "mgmt" }), { kind: "staff_only", who: "mgmt" });
  assert.deepEqual(fromBrainAnswerSource("staff_only", { checkResultReady: true }), { kind: "checked_result" });
  assert.equal(answerSourceLabel({ kind: "staff_only", who: "phone" }), "スタッフだけ（電話で確かめる）");
});

t("turn_contract の basis → 7つ", () => {
  assert.equal(fromContractBasis("company_fact", "reply").kind, "company_fact");
  assert.equal(fromContractBasis("general", "reply").kind, "general");
  assert.equal(fromContractBasis(null, "promise").kind, "staff_only");
  assert.equal(fromContractBasis("judgement", "reply").kind, "staff_only");
  assert.equal(fromContractBasis(null, "promise", { checkResultReady: true }).kind, "checked_result");
});

t("作業員7b の toComposeSource は1か所の読み替えを呼ぶだけ（前の答えと同じ）", () => {
  assert.equal(toComposeSource("material_value"), "material"); assert.equal(toComposeSource("none"), "general");
  assert.equal(toComposeSource("company_fact"), "company_fact"); assert.equal(toComposeSource("staff_only"), "staff_only");
  const src = readFileSync(resolve(__dirname, "../app/lib/ask-parts.ts"), "utf8");
  assert.match(src, /fromBrainAnswerSource/);
});

t("ブレインへの指示の文は変えない（16 の4つのまま）", () => {
  for (const s of ANSWER_SOURCES) assert.ok(ASK_PARTS_FIELD.includes(s), s);
  assert.deepEqual([...ANSWER_SOURCES], ["company_fact", "material_value", "staff_only", "none"]);
});

t("parts[]（7b）がある依頼は、部分ごとの出所と確かさを先に使う（実例 12643 の形）", () => {
  const p = askPartsOf([{ quote: "鍵交換は必須ですか？外せますか？", basis: "company_fact", route: "reply", answer: "x",
    parts: [{ part: "必須か", source: "company_fact", certainty: "assertable", route: "reply" }, { part: "外せるか", source: "staff_only", certainty: "needs_check", route: "promise", who: "mgmt" }] }])[0];
  assert.deepEqual([p.source.kind, p.now, p.check, p.certainty], ["company_fact", "必須か", "外せるか", "assertable"]);
});

t("読み替えの関数は answer-source の1か所だけ（app/lib の中で material_value を分ける三項の式を他に持たない）", () => {
  const dir = resolve(__dirname, "../app/lib");
  const bad = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "answer-source.ts").filter((f) => /=== "material_value" \? "material"/.test(readFileSync(join(dir, f), "utf8")));
  assert.deepEqual(bad, []);
});
t("確かめた結果が手元にある番（now_vs_later.ready_now）は staff_only を checked_result に（作業員16 の注意）", () => {
  const m = { now_vs_later: { ready_now: ["確認の結果"] }, turn_contract: { asks: [{ quote: "空いていますか", kind: "question", route: "promise", answer: "確認させて頂きます" }] } };
  assert.equal(checkResultReadyOf(m), true); assert.equal(checkResultReadyOf({}), false);
  assert.equal(subValuesOf(m)["fact.source"], "checked_result");
  assert.equal(subValuesOf({ turn_contract: m.turn_contract })["fact.source"], "staff_only");
});
console.log(`\n${n} 件 ok`);
