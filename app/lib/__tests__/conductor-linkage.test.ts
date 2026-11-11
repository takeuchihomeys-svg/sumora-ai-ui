// 実行: npx tsx app/lib/__tests__/conductor-linkage.test.ts
import { CONDUCTOR_LINKS, ownersOfMarker, linkageLines } from "../conductor-linkage";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
const ids = (m: string) => ownersOfMarker(m).map((c) => c.id).join(",");

// 2026-11-12 作業員10: 文の統括の設計図（compose_plan）の行を足して 12
it("統括は10＋決まった計算の上書き＋設計図・id は重ならない", () => { ok(CONDUCTOR_LINKS.length === 12); ok(new Set(CONDUCTOR_LINKS.map((c) => c.id)).size === 12); ok(ids("compose_plan:promise") === "compose_plan"); });
it("作業員8の印から持ち主を引く（前方一致・長い一致を先）", () => {
  ok(ids("decision:two_stage_promise(check)") === "two_stage", ids("decision:two_stage_promise(check)"));
  ok(ids("decision:answerable_direct") === "two_stage");
  ok(ids("two_stage:check") === "two_stage");
  ok(ids("scene_net:S4_viewing") === "scene_net");
  ok(ids("decision:closed_ack_wait") === "rules", ids("decision:closed_ack_wait"));
  ok(ids("demoted:answerable_direct") === "two_stage");
  ok(ids("writer").includes("writer")); ok(ids("final_check") === "final_check"); ok(ids("log:mgmt-night") === "final_check");
  ok(ids("decision:llm") === "brain", ids("decision:llm")); // 作業員8: ブレインの2層目の印
  ok(ids("log:answerable-direct(check)") === "two_stage"); ok(ids("text:direction_tail") === "two_stage"); ok(ids("text:turn_contract") === "compose"); ok(ids("log:sent-reaction") === "rules"); ok(ids("log:screening") === "two_stage"); ok(ids("log:other-tag") === "brain");
  ok(ids("") === "");
});
it("連携の1行: 重点を読む統括・決め直しの例（q136・q332・q055・q023）が出る", () => {
  const l = linkageLines();
  ok(l.some((x) => x.startsWith("intake → meta.conductor_focus: 読む") && x.includes("compose") && x.includes("two_msg")), "focus readers");
  for (const q of ["q136", "q332", "q055", "q023", "q174", "closing2-q136", "夜の明日", "q010"]) ok(l.some((x) => x.includes(q)), q);
  ok(l.some((x) => x.startsWith("brain → meta.reply_direction: 読む writer")), "reply_direction");
});
it("持ち主は全部決まっている（11/06 統括役の決め）", () => {
  for (const c of CONDUCTOR_LINKS) ok(!/未定/.test(c.owner), c.id);
  ok(ownersOfMarker("two_stage:check")[0]?.owner.startsWith("作業員7")); ok(ownersOfMarker("scene_net:S4")[0]?.owner.startsWith("作業員1"));
  ok(ownersOfMarker("decision:closed_ack_wait")[0]?.owner.startsWith("作業員1")); ok(ownersOfMarker("final_check")[0]?.owner.startsWith("作業員9")); ok(ownersOfMarker("writer").some((c) => c.owner.startsWith("作業員9")));
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
