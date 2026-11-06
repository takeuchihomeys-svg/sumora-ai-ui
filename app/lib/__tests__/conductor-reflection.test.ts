// 実行: npx tsx app/lib/__tests__/conductor-reflection.test.ts
import { conductorReflectionOn, sceneStats, weakScenes, weekKey, weaknessRow, questionRow, type WatchRow } from "../conductor-reflection";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
const r = (scene: string, brainAix: boolean, staffAix: boolean): WatchRow => ({ scene_key: scene, brain_action: brainAix ? "property_send" : null, brain_reply_mode: brainAix ? "aix" : "reply", staff_aix: staffAix ? [{ at: "x" }] : [], staff_first_at: "2026-11-01T00:00:00Z" });
it("既定 off", () => { ok(!conductorReflectionOn({})); ok(conductorReflectionOn({ CONDUCTOR_REFLECTION: "on" })); });
it("場面ごとの当たりと外れの向き・スタッフが返していない番は数えない", () => {
  const rows = [r("対象外:申込以降", true, false), r("ack", true, false), r("ack", true, false), r("ack", false, false), r("ack", true, false), r("ack", true, false), r("ack", false, false), { ...r("ack", true, true), staff_first_at: null }, r("cost", true, true)];
  const s = sceneStats(rows); const ack = s.find((x) => x.scene === "ack")!;
  ok(ack.n === 6 && ack.hit === 2 && ack.brainAixStaffReply === 4, JSON.stringify(ack));
  const w = weakScenes(s); ok(w.length === 1 && w[0].scene === "ack"); ok(!s.some((x) => x.scene.startsWith("対象外")), "対象外は数えない");
  ok(weakScenes(s, { minN: 7 }).length === 0, "件数が少ない場面は上げない");
});
it("週の印・台帳の行・確認事項の行（推奨付き・重ならない鍵）", () => {
  ok(weekKey(new Date("2026-11-07T00:00:00Z")) === "2026-W45", weekKey(new Date("2026-11-07T00:00:00Z")));
  const s = { scene: "ack", n: 6, hit: 2, brainAixStaffReply: 4, brainReplyStaffAix: 0 };
  const w = weaknessRow("2026-W45", s); ok(w.key === "reflect:2026-W45:ack" && w.occurrences === 4 && w.title.includes("33%"));
  const q = questionRow("2026-W45", s); ok(q.dedupe_key === w.key && q.recommended.startsWith("返信") && q.options.length === 3 && q.status === "open");
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
