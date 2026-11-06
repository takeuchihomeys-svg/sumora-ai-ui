// 実行: npx tsx app/lib/__tests__/conductor-linkage.test.ts
import { CONDUCTOR_LINKS, ownersOfMarker, linkageLines } from "../conductor-linkage";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
const ids = (m: string) => ownersOfMarker(m).map((c) => c.id).join(",");

it("統括は10＋決まった計算の上書き・id は重ならない", () => { ok(CONDUCTOR_LINKS.length === 11); ok(new Set(CONDUCTOR_LINKS.map((c) => c.id)).size === 11); });
it("作業員8の印から持ち主を引く（前方一致・長い一致を先）", () => {
  ok(ids("decision:two_stage_promise(check)") === "two_stage", ids("decision:two_stage_promise(check)"));
  ok(ids("decision:answerable_direct") === "two_stage");
  ok(ids("two_stage:check") === "two_stage");
  ok(ids("scene_net:S4_viewing") === "scene_net");
  ok(ids("decision:closed_ack_wait") === "rules", ids("decision:closed_ack_wait"));
  ok(ids("demoted:answerable_direct") === "two_stage");
  ok(ids("writer").includes("writer")); ok(ids("final_check") === "final_check"); ok(ids("log:mgmt-night") === "final_check");
  ok(ids("") === "");
});
it("連携の1行: 重点を読む統括・決め直しの例（q136・q332・q055・q023）が出る", () => {
  const l = linkageLines();
  ok(l.some((x) => x.startsWith("intake → meta.conductor_focus: 読む") && x.includes("compose") && x.includes("two_msg")), "focus readers");
  for (const q of ["q136", "q332", "q055", "q023"]) ok(l.some((x) => x.includes(q)), q);
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
