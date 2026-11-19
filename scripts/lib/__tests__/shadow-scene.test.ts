// 影の自動返信の場面選び（scripts/lib/shadow-scene.ts）のテスト（LLM も DB も使わない）
// 実行: npx tsx scripts/lib/__tests__/shadow-scene.test.ts
import { sceneTable, NEAR_APPLY_RE, type ShadowTurn } from "../shadow-scene";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = "") => { if (c) pass++; else { fail++; console.log(`✗ ${n} ${d}`); } };
const now = Date.parse("2026-11-12T13:00:00Z");
const T = (scene: string, daysAgo: number, hit: boolean, o: Partial<ShadowTurn> = {}): ShadowTurn => ({ scene, at: now - daysAgo * 86_400_000, writer: "takeuchi", nowHit: hit, staffReply: true, brainReply: true, ...o });
const rep = (n: number, f: (i: number) => ShadowTurn) => Array.from({ length: n }, (_, i) => f(i));

{
  const rows = sceneTable([...rep(80, (i) => T("短い了承・お礼", i % 13, true))], now);
  const r = rows.find((x) => x.scene === "短い了承・お礼" && x.writer === "takeuchi")!;
  ok("14日で 80番全部当たり → 候補", r.verdict === "候補" && r.n14 === 80 && r.lo14 >= 0.95, JSON.stringify(r));
}
{
  const rows = sceneTable([...rep(10, (i) => T("A", i, true))], now);
  ok("数が少ない → 数が足りない", rows.find((x) => x.scene === "A" && x.writer === "takeuchi")!.verdict === "数が足りない");
}
{
  const rows = sceneTable([...rep(40, (i) => T("B", i % 13, i % 5 !== 0))], now);
  ok("当たり 80% → 当たりが足りない", rows.find((x) => x.scene === "B" && x.writer === "takeuchi")!.verdict === "当たりが足りない");
}
{
  const rows = sceneTable([...rep(40, (i) => T("C", i % 13, true, { staffReply: i % 3 !== 0 }))], now);
  ok("スタッフが AIX を出す番が多い → AIX の場面", rows.find((x) => x.scene === "C" && x.writer === "takeuchi")!.verdict === "AIX の場面");
}
{
  const rows = sceneTable([...rep(40, (i) => T("S3_screening", i % 13, true))], now);
  ok("申込に近い場面は除く", rows.find((x) => x.scene === "S3_screening")!.verdict === "申込に近い" && NEAR_APPLY_RE.test("申込の書類"));
}
{
  const rows = sceneTable([...rep(30, (i) => T("D", 20 + (i % 7), true))], now);
  const r = rows.find((x) => x.scene === "D" && x.writer === "takeuchi")!;
  ok("28日だけの番は14日に入れない", r.n14 === 0 && r.n28 === 30, JSON.stringify(r));
}
{
  const rows = sceneTable([...rep(25, (i) => T("E", i % 13, true)), ...rep(25, (i) => T("E", i % 13, true, { writer: "staff" }))], now);
  ok("竹内さん・スタッフ・全体の3行", rows.filter((x) => x.scene === "E").length === 3 && rows.find((x) => x.scene === "E" && x.writer === "all")!.n14 === 50);
}
console.log(`shadow-scene: ${pass} passed, ${fail} failed`); if (fail) process.exit(1);
