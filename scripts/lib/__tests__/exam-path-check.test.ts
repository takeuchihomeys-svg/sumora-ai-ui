// npx tsx scripts/lib/__tests__/exam-path-check.test.ts
import assert from "node:assert/strict";
import { pathCheck, composePlanMarkers } from "../exam-path-check";
import { CONDUCTOR_LINKS } from "../../../app/lib/conductor-linkage";

const brain = { turn_contract: { asks: [{ quote: "畳は変えて頂けるのですか", route: "promise", about: "property_equipment" }] } };
assert.deepEqual(composePlanMarkers(brain), ["compose_plan:promise"]);
assert.deepEqual(composePlanMarkers({ turn_contract: { asks: [{ quote: "初期費用は", route: "aix" }] } }), []); // AIX の番は主の行が出ない
assert.deepEqual(composePlanMarkers(null), []);
const pc = pathCheck({ changed: ["app/lib/compose-sentence-plan.ts"], links: CONDUCTOR_LINKS, markersById: { q1: ["decision:llm", ...composePlanMarkers(brain)], q2: ["decision:llm"] } });
assert.equal(pc.verdict, "ok");
if (pc.verdict === "ok") { assert.deepEqual(pc.passing, ["q1"]); assert.deepEqual(pc.notPassing, ["q2"]); assert.ok(pc.links.includes("compose_plan")); }
console.log("exam-path-check: 4 pass");
