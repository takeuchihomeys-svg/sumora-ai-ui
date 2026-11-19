// npx tsx app/lib/__tests__/brain-vocab.test.ts
import assert from "node:assert/strict";
import { brainVocabMode, TOPICS, TOPIC_KEYS, normalizeTopic, normalizeConditionChange, CONDITION_KINDS, EXISTING_CONDITION_KINDS, STRENGTH_KINDS, normalizeStage, STAGE_KINDS, LEAD_TO_FOCUS_HINT, TOPIC_TO_NEED_HINT } from "../brain-vocab";
import { LEAD_TO } from "../takeuchi-anatomy-roles";
import { FOCUS_KINDS } from "../conductor-focus";
import { NEED_KINDS } from "../judge-basis-types";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
t("既定 off（BRAIN_VOCAB=shadow の時だけ記録）", () => { assert.equal(brainVocabMode({}), "off"); assert.equal(brainVocabMode({ BRAIN_VOCAB: "shadow" }), "shadow"); assert.equal(brainVocabMode({ BRAIN_VOCAB: "on" }), "off"); });
t("主題: 旧12種はすべて新しい名前に変換できる・2段に分かれる・ペット駐車場は staffFact", () => {
  const old = ["階数", "築年数", "費用", "駅距離", "広さ", "日当たり", "審査", "騒音治安", "家族構成", "設備", "ペット駐車場", "時期"];
  assert.equal(TOPICS.length, 12);
  for (const o of old) assert.ok(normalizeTopic(o), o);
  assert.equal(normalizeTopic("費用")!.group, "money_procedure");
  assert.equal(normalizeTopic("階数")!.group, "property");
  assert.equal(normalizeTopic("pet_parking")!.staffFact, true);
  assert.equal(normalizeTopic("階数")!.from, "old");
  assert.equal(normalizeTopic("その他"), null);
});
t("条件の変更: 既存7種＋入居時期・初期費用の上限・強さは must|want の2種（relax は種類）", () => {
  assert.deepEqual(STRENGTH_KINDS, ["must", "want"]);
  assert.ok((CONDITION_KINDS as readonly string[]).includes("condition_relax"));
  for (const k of EXISTING_CONDITION_KINDS) assert.ok((CONDITION_KINDS as readonly string[]).includes(k));
  const c = normalizeConditionChange({ kind: "move_in", strength: "must", scope: "permanent", text: "12月上旬までに" })!;
  assert.equal(c.strength, "must");
  assert.equal(normalizeConditionChange({ kind: "rent_change", strength: "relax" })!.strength, null);
  assert.equal(normalizeConditionChange({ kind: "zzz" }), null);
});
t("段: 5種に統一・内覧の調整中は proposing から viewing に寄せられる", () => {
  assert.equal(STAGE_KINDS.length, 5);
  assert.equal(normalizeStage("proposing", { viewingActive: true }), "viewing");
  assert.equal(normalizeStage("proposing"), "proposing");
  assert.equal(normalizeStage("greeting"), null);
});
t("対応表: lead（七つの欄）→ 重点・主題 → 優先が一覧の中", () => {
  for (const l of LEAD_TO) assert.ok(LEAD_TO_FOCUS_HINT[l], l);
  for (const fs of Object.values(LEAD_TO_FOCUS_HINT)) for (const f of fs) assert.ok((FOCUS_KINDS as readonly string[]).includes(f));
  for (const k of TOPIC_KEYS) for (const nd of TOPIC_TO_NEED_HINT[k]) assert.ok((NEED_KINDS as readonly string[]).includes(nd));
});
console.log(`${n} tests passed`);
