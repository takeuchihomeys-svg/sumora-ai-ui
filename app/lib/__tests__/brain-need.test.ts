// 実行: npx tsx app/lib/__tests__/brain-need.test.ts
import { deepStrictEqual } from "node:assert";
let passed = 0, failed = 0;
const describe = (_n: string, fn: () => void) => fn();
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const expect = (v: unknown) => ({
  toBe: (w: unknown) => { if (v !== w) throw new Error(`${JSON.stringify(v)} !== ${JSON.stringify(w)}`); },
  toEqual: (w: unknown) => deepStrictEqual(v, w),
  toBeNull: () => { if (v !== null) throw new Error(`${JSON.stringify(v)} is not null`); },
  toContain: (w: string) => { if (!String(v).includes(w)) throw new Error(`${JSON.stringify(v)} does not contain ${w}`); },
  toHaveLength: (n: number) => { if ((v as unknown[] | undefined)?.length !== n) throw new Error(`length ${(v as unknown[] | undefined)?.length} !== ${n}`); },
});
import { needReportMode, normalizeNeed, normalizePlanAhead, prevPlanAheadLine, needDigest, planAheadDigest, detectMaterialConflicts, conflictDigest, needReportOn, planAheadOn, materialProvenanceOn } from "../brain-need";

describe("brain-need", () => {
  it("スイッチは既定 off", () => {
    expect(needReportOn({})).toBe(false); expect(planAheadOn({})).toBe(false); expect(materialProvenanceOn({})).toBe(false);
    expect(needReportOn({ BRAIN_NEED_REPORT: "on" })).toBe(true);
    expect(needReportMode({ BRAIN_NEED_REPORT: "after" })).toBe("after"); expect(needReportOn({ BRAIN_NEED_REPORT: "after" })).toBe(true); expect(needReportMode({})).toBe("off");
  });
  it("need を整える（知らない道具は落とす）", () => {
    const n = normalizeNeed({ difficulty: "high", confidence: "low", missing: ["sheet_detail", "foo", "sheet_detail", "estimate"], why: "設備の質問" });
    expect(n).toEqual({ difficulty: "high", confidence: "low", missing: ["sheet_detail", "estimate"], why: "設備の質問" });
    expect(needDigest(n)).toBe("hl:sheet_detail,estimate");
    expect(normalizeNeed(null)).toBeNull();
    expect(normalizeNeed({ difficulty: "x" })?.difficulty).toBe("mid");
  });
  it("plan_ahead を整える", () => {
    const p = normalizePlanAhead({ goal: "今週中に内覧", steps: ["物件オススメ", "見積書", "内覧調整", "申込"], why: "刺さっている", changed_because: "null" });
    expect(p?.steps).toHaveLength(3); expect(p?.changedBecause).toBeNull();
    expect(planAheadDigest(p)).toBe("今週中に内覧|物件オススメ");
    expect(normalizePlanAhead({ goal: "", steps: [] })).toBeNull();
    expect(planAheadDigest(normalizePlanAhead({ goal: "申込", steps: ["審査"], changed_because: "審査だけ先にと言った" }))).toBe("申込|審査|変");
  });
  it("前の計画の1行", () => {
    const now = Date.parse("2026-11-03T12:00:00+09:00");
    const realNow = Date.now; Date.now = () => now;
    try {
      expect(prevPlanAheadLine({ goal: "今週中に内覧", steps: ["見積書", "内覧調整"], why: "", changedBecause: null }, "2026-11-03T09:00:00+09:00")).toBe("【前の計画（3時間前の判断）】目指す事: 今週中に内覧／次の手: 見積書→内覧調整");
    } finally { Date.now = realNow; }
    expect(prevPlanAheadLine(null, null)).toBe("");
  });
  it("食い違い: 段階と送った件数", () => {
    const now = Date.parse("2026-11-03T12:00:00+09:00");
    const c = detectMaterialConflicts({
      strategyStage: "proposing", strategyAt: "2026-11-02T12:00:00+09:00", strategyNextStep: "Step1: 条件で物件をピックアップして送る",
      stateStage: "viewing_scheduled", stateStageLabel: "内覧予定",
      rooms: [{ sentByUs: true, firstAt: "2026-11-03T10:00:00+09:00", name: "A" }, { sentByUs: false, firstAt: "2026-11-03T10:00:00+09:00", name: "B" }, { sentByUs: true, firstAt: "2026-11-01T10:00:00+09:00", name: "C" }],
      nowMs: now,
    });
    expect(c.kinds).toEqual(["stage", "sent"]); expect(c.strategyAgeH).toBe(24);
    expect(c.line).toContain("段階（まとめ=提案中・記録=内覧予定）");
    expect(c.line).toContain("1件送った記録");
    expect(conflictDigest(c)).toBe("stage,sent");
  });
  it("食い違いが無ければ時刻だけ", () => {
    const c = detectMaterialConflicts({ strategyStage: "viewing", strategyAt: "2026-11-03T11:00:00+09:00", stateStage: "viewed", nowMs: Date.parse("2026-11-03T12:00:00+09:00") });
    expect(c.kinds).toEqual([]); expect(c.line).toBe("【材料の時刻】全体の分析: 1時間前に作った物"); expect(conflictDigest(c)).toBeNull();
    expect(detectMaterialConflicts({}).line).toBe("");
  });
});

console.log(`
${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
