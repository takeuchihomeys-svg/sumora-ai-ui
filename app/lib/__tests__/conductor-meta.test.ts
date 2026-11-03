// 実行: npx tsx app/lib/__tests__/conductor-meta.test.ts
import { conductorMetaMode, buildConductorMeta, withMaterials, storesFor, carryQueryLine, rerankByMeta, materialFor, conductorMetaDigest } from "../conductor-meta";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }

it("既定は shadow（記録だけ）・off で止まる", () => { ok(conductorMetaMode({}) === "shadow" && conductorMetaMode({ CONDUCTOR_META: "off" }) === "off" && conductorMetaMode({ CONDUCTOR_META: "on" }) === "on"); });
it("軽い番は判断の倉庫を引かない", () => { ok(storesFor("line", "ack").length === 0 && storesFor("line", "question").includes("judge_examples")); });
it("統括メタを作る・造語は捨てる・前の番の要点を持ち越す", () => {
  const m = buildConductorMeta({ scene: "question", stage: "proposing", turnAt: "2026-11-04T01:00:00Z", roles: { call: ["writer", "compose", "check"], skip: ["aix_desk"] }, need: ["sheet_detail", "made_up"], prevMeta: { main_point: "空室確認結果の報告" }, openPromises: ["募集状況の確認"] });
  ok(m.roles[0] === "line" && m.need.join() === "sheet_detail" && m.confidence === "low", JSON.stringify(m));
  ok(m.stores.compose?.includes("takeuchi_compose") && !m.stores.aix_desk);
  ok(carryQueryLine(m) === "前の番の要点: 空室確認結果の報告／まだのやる事: 募集状況の確認", carryQueryLine(m));
  ok(conductorMetaDigest(m) === "question|ln,wr,cp,ck|st4|l", conductorMetaDigest(m) ?? "");
});
it("並べ替えは場面・段階で上げる（問いには混ぜない）", () => {
  const m = buildConductorMeta({ scene: "cost", stage: "estimate_sent", turnAt: null, roles: { call: ["writer"], skip: [] } });
  const r = rerankByMeta([{ id: 1, scene: "question", score: 0.8 }, { id: 2, scene: "cost", stage: "estimate_sent", score: 0.6 }, { id: 3, scene: "cost", score: 0.5 }] as Array<{ id: number; scene: string; stage?: string; score: number }>, m, null, 2);
  ok(r.map((x) => x.id).join() === "2,1", r.map((x) => x.id).join());
});
it("統括メタに担当ごとの材料の数を足す（帳面が無ければ足さない）", () => {
  const m = buildConductorMeta({ scene: "question", stage: null, turnAt: null, roles: { call: ["writer"], skip: [] } });
  const w = withMaterials(m, [{ kind: "stage" }, { kind: "promise" }]);
  ok(w.materials?.line === 2 && w.materials?.aix_desk === 1 && w.materials?.writer === 1, JSON.stringify(w.materials));
  ok(withMaterials(m, []).materials === undefined);
});
it("材料の配り口は担当ごとの種類だけ", () => {
  const facts = [{ kind: "stage" }, { kind: "promise" }, { kind: "memo" }];
  ok(materialFor("aix_desk", facts).map((f) => f.kind).join() === "promise" && materialFor("line", facts).length === 3 && materialFor("deep", facts).length === 0);
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
