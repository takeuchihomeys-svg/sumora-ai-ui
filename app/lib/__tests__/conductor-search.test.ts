// 実行: npx tsx app/lib/__tests__/conductor-search.test.ts
import { conductorSearchMode, searchPlan, pickHits, storeDiff } from "../conductor-search";
import { buildConductorMeta } from "../conductor-meta";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }

const meta = buildConductorMeta({ scene: "question", stage: "proposing", turnAt: null, roles: { call: ["compose", "writer"], skip: [] }, prevMeta: { main_point: "空室確認結果の報告" } });
it("既定は shadow", () => { ok(conductorSearchMode({}) === "shadow" && conductorSearchMode({ CONDUCTOR_SEARCH: "off" }) === "off"); });
it("引き方の計画: 担当の倉庫・件数・前の番の1行", () => {
  const p = searchPlan(meta, "compose");
  ok(p.stores.join() === "takeuchi_compose" && p.topK === 3 && p.querySuffix.includes("前の番の要点"), JSON.stringify(p));
});
it("竹内さん本人を先に・足りない時だけ他で補う・倉庫の外は捨てる", () => {
  const p = searchPlan(meta, "compose");
  const r = pickHits([
    { id: "a1", store: "takeuchi_compose", writer: "takeuchi", scene: "question", score: 0.5 },
    { id: "b1", store: "takeuchi_compose", writer: "employee", scene: "question", score: 0.9 },
    { id: "c1", store: "knowledge", writer: "takeuchi", score: 0.99 },
    { id: "a2", store: "takeuchi_compose", writer: "takeuchi", scene: "cost", score: 0.6 },
  ], meta, p);
  ok(r.hits.map((h) => h.id).join() === "a1,a2,b1" && r.takeuchiN === 2 && r.filledByOthers === 1, JSON.stringify(r));
  ok(r.digest.startsWith("compose|takeuchi_compose|tk2+o1|"), r.digest);
});
it("倉庫のずれ", () => { const d = storeDiff(["judge_examples"], ["judge_examples", "knowledge"]); ok(d.extra.join() === "knowledge" && d.missing.length === 0); });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
