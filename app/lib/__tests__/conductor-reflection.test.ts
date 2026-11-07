// 実行: npx tsx app/lib/__tests__/conductor-reflection.test.ts
import { conductorReflectionOn, sceneStats, weakScenes, weekKey, weaknessRow, questionRow, replyQualityDelta, replyQualityWeaknessRow, type WatchRow } from "../conductor-reflection";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
const r = (scene: string, brainAix: boolean, staffAix: boolean): WatchRow => ({ scene_key: scene, brain_action: brainAix ? "property_send" : null, brain_reply_mode: brainAix ? "aix" : "reply", staff_aix: staffAix ? [{ at: "x" }] : [], staff_first_at: "2026-11-01T00:00:00Z" });
it("既定 on（11/07）・off で止める", () => { ok(conductorReflectionOn({})); ok(!conductorReflectionOn({ CONDUCTOR_REFLECTION: "off" })); });
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
  const q = questionRow("2026-W45", s); ok(q.dedupe_key === w.key && q.recommended === "はい、返信で良い" && q.options.length === 3 && q.status === "open", JSON.stringify(q));
  const q2 = questionRow("2026-W45", { ...s, scene: "AIX:application_push" }); ok(q2.question.startsWith("ブレインがAIX【") && !q2.question.includes("application_push"), q2.question);
});
it("返信の番の文の質: 終わった週と前の週を比べ・0.6未満が上がった時だけ弱い所に1行・少ない週は比べない", () => {
  const w = (week: string, n: number, avg: number, lowPct: number, lowWriter = 2) => ({ week, n, avg, lowPct, lowBrain: 1, lowWriter });
  const st = [w("2026-10-26", 40, 0.62, 30), w("2026-11-02", 42, 0.6, 35, 5), w("2026-11-09", 3, 0.1, 100)];
  const d = replyQualityDelta(st, "2026-11-09")!;
  ok(d.week === "2026-11-02" && d.prevWeek === "2026-10-26" && d.lowPctDiff === 5 && d.avgDiff === -0.02 && d.lowWriterDiff === 3 && d.rose, JSON.stringify(d));
  const row = replyQualityWeaknessRow("2026-W46", d)!; ok(row.key === "reflect:2026-W46:reply_quality" && row.area === "writer" && row.title.includes("+5"), JSON.stringify(row));
  const down = replyQualityDelta([w("2026-10-26", 40, 0.6, 35), w("2026-11-02", 42, 0.62, 30)], "2026-11-09")!;
  ok(!down.rose && replyQualityWeaknessRow("2026-W46", down) === null, "下がった週は足さない");
  const few = replyQualityDelta([w("2026-10-26", 3, 0.6, 0), w("2026-11-02", 42, 0.5, 60)], "2026-11-09")!;
  ok(few.lowPctDiff === null && !few.rose, "前の週が少ない時は比べない");
  ok(replyQualityDelta([w("2026-11-09", 5, 0.5, 50)], "2026-11-09") === null, "今週の途中だけなら無し");
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
