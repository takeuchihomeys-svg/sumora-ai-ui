// npx tsx app/lib/__tests__/compose-brief-roles.test.ts
//   統括の指示書（meta.conductor_brief）の役目ごとの欄を設計図の行と書き手への注記に渡す（COMPOSE_BRIEF_ROLES・既定 off）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readTurnUnderstanding, readSevenFields, buildSentencePlan } from "../compose-sentence-plan";
import { asksFactsOf } from "../compose-asks-facts";
import { buildPlanRowsV2 } from "../compose-plan-rows-v2";
import { composeBriefRolesOn, briefRolesNote, briefLineForRole, nextStepOf } from "../compose-brief-roles";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
function rows(meta: Record<string, unknown>, scene: string, customerText: string) {
  const u = readTurnUnderstanding(meta), s7 = readSevenFields(meta);
  const plan = buildSentencePlan(u, s7, { scene });
  return buildPlanRowsV2({ plan, s7, meta, scene, customerText, facts: asksFactsOf(meta), closing: null, recentStaff: [] }).rows;
}
const brief = (steps: unknown[]) => ({
  main: { from: "turn_contract", items: [{ kind: "question", quote: "内覧できますか", topic: null }] },
  facts: [{ quote: "内覧できますか", value: "現在空室で内覧可能", from: "資料", certainty: "assertable" }],
  missing: "未", open: "未", type: "未", alloc: "未", combine: "未", next: "未",
  order: { first: "answer", why_tag: "ask_first", why_order: "asked_order", this_turn: "answer", answer_source: "material_value", deferred: 0, depth: "normal", avoid: 0, conflicts: [], row_id: "x" },
  next_concrete: { steps, from: "customer_wait", combo: null, comboRef: null, why: "" },
  aim: { purpose: "viewing", purposeFrom: "judge_basis", keyPoint: "未", mid: "内覧の日程" },
  decided: [], doubts: [], sure: { level: "mid", score: 0, cues: [], handoff: false }, notYet: [],
});
const base = { turn_contract: { asks: [{ quote: "内覧できますか", kind: "question", route: "reply", answer: "現在空室で内覧可能", basis: "material" }], lead_with: 0 }, seven_read: { lead: "viewing" } };

t("既定 off: 行も注記も変えない", () => {
  assert.equal(composeBriefRolesOn({}), false);
  const meta = { ...base, conductor_brief: brief([{ route: "reply", aix: null, what: "none", item: "内覧の候補日", when: { at: "customer", word: "週末", from: "customer" } }]) };
  const r = rows(meta, "viewing", "内覧できますか？");
  assert.ok(!r.some((x) => x.stand.some((s) => s.startsWith("next_concrete"))));
  assert.equal(briefRolesNote(r, meta, {}), "");
});
t("on: 次の一手の具体をつなぎ（何を）と締め（お客様の言った時期）の材料に", () => {
  process.env.COMPOSE_BRIEF_ROLES = "on";
  try {
    const meta = { ...base, conductor_brief: brief([{ route: "aix", aix: "viewing_adjust", what: "property", item: "内覧の候補日", when: { at: "customer", word: "週末", from: "customer" } }]) };
    assert.equal(nextStepOf(meta)?.item, "内覧の候補日");
    const r = rows(meta, "viewing", "内覧できますか？");
    const b = r.find((x) => x.role === "bridge"), c = r.find((x) => x.role === "close");
    assert.ok(b && b.uses.some((u) => u.field === "aim.next" && u.value === "内覧の候補日"), JSON.stringify(r.map((x) => [x.role, x.uses])));
    if (c) { assert.equal(c.sub, "their_timing"); assert.deepEqual(c.uses, [{ field: "latent.expect", value: "週末" }]); }
    // 書き手への注記: 役目ごとに要る欄だけ（press に事実・bridge に次の一手）
    const note = briefRolesNote(r, meta, { COMPOSE_BRIEF_ROLES: "on" });
    assert.match(note, /^- 統括の指示書/);
    assert.match(note, /press: .*事実: 現在空室で内覧可能/);
    assert.match(briefLineForRole(meta, "bridge") ?? "", /次の一手の具体: 内覧の候補日（週末）/);
  } finally { delete process.env.COMPOSE_BRIEF_ROLES; }
});
t("on: 指示書が無い・次の一手が未なら何も足さない（作らない）", () => {
  process.env.COMPOSE_BRIEF_ROLES = "on";
  try {
    const r0 = rows(base, "viewing", "内覧できますか？");
    assert.ok(!r0.some((x) => x.stand.some((s) => s.startsWith("next_concrete"))));
    assert.equal(briefRolesNote(r0, base, { COMPOSE_BRIEF_ROLES: "on" }), "");
    const m2 = { ...base, conductor_brief: { ...brief([]), next_concrete: "未" } };
    assert.equal(nextStepOf(m2), null);
    // お客様を待つ番（wait_contact）はつなぎに何をを足さない
    const m3 = { ...base, conductor_brief: brief([{ route: "reply", aix: null, what: "wait_contact", item: "ご連絡を待つ", when: { at: "next_day", word: null, from: "type_table" } }]) };
    const r3 = rows(m3, "viewing", "内覧できますか？");
    assert.ok(!r3.some((x) => x.uses.some((u) => u.field === "aim.next")));
  } finally { delete process.env.COMPOSE_BRIEF_ROLES; }
});
t("配線: route の書き手への注記に briefRolesNote が入る", () => {
  const route = readFileSync(join(__dirname, "..", "..", "api", "generate-reply", "route.ts"), "utf8");
  assert.match(route, /rowsV2 \? briefRolesNote\(rowsV2\.rows, brainMeta\) : ""/);
});
console.log(`compose-brief-roles: ${n} pass`);
