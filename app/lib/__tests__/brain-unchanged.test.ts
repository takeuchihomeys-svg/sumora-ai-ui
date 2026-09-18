// 2026-09-14 API 漏れ調査: 前回の分析から会話に何も届いていなければブレインを動かさない（AIX 誘導中の会話を開くたびの再分析）
//   直近7日: 同じ発言への再分析41組のうち、間にメッセージが1通も無かったのが27組（6時間以内26組）
// 実行: npx tsx app/lib/__tests__/brain-unchanged.test.ts（自己完結ハーネス。全 PASS で exit 0）
import {
  nothingNewSinceLastAnalysis, UNCHANGED_REUSE_HOURS, type UnchangedInput,
  isDuplicateRun, DUPLICATE_RUN_WINDOW_MS, type DuplicateRunInput,
} from "../brain-analysis-mode";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

const now = Date.parse("2026-09-14T13:00:00Z");
// 名無しの権兵衛型: 12:00 に分析（メッセージ42件・最新のお客様発言を見た）→ AIX 誘導中のまま 12:40 にスタッフが会話を開いた
const base: UnchangedInput = {
  totalMsgCount: 42, lastAnalyzedMsgCount: 42, lastAnalyzedAt: "2026-09-14T12:00:00Z",
  hasSuggestedMeta: true, suggestedSawLatestCustomer: true, latestTurnHasImage: false, forced: false, nowMs: now,
};

it("何も届いていない・保存済みの判断が最新・6時間以内 → 分析しない", () => {
  expect(nothingNewSinceLastAnalysis(base)).toBe(true);
});
it("お客様・スタッフ・AIX のどれかが1通でも届いた（総数が変わった）→ 分析する", () => {
  expect(nothingNewSinceLastAnalysis({ ...base, totalMsgCount: 43 })).toBe(false);
});
it("スタッフの宣言直後・画像の読み取り完了（呼び出し側の分析し直し）→ 分析する", () => {
  expect(nothingNewSinceLastAnalysis({ ...base, forced: true })).toBe(false);
});
it("未返信の連投に画像（読み取りが後から入る）→ 分析する", () => {
  expect(nothingNewSinceLastAnalysis({ ...base, latestTurnHasImage: true })).toBe(false);
});
it("保存済みの判断が無い（brain-sweep の対象）・最新の発言を見ていない → 分析する", () => {
  expect(nothingNewSinceLastAnalysis({ ...base, hasSuggestedMeta: false })).toBe(false);
  expect(nothingNewSinceLastAnalysis({ ...base, suggestedSawLatestCustomer: false })).toBe(false);
});
it(`前回の分析から${UNCHANGED_REUSE_HOURS}時間以上（時間の経過で判断が変わりうる）→ 分析する`, () => {
  expect(nothingNewSinceLastAnalysis({ ...base, lastAnalyzedAt: "2026-09-14T06:59:00Z" })).toBe(false);
  expect(nothingNewSinceLastAnalysis({ ...base, lastAnalyzedAt: "2026-09-14T07:01:00Z" })).toBe(true);
});
it("前回の件数・時刻が無い（移行前の会話）→ 分析する", () => {
  expect(nothingNewSinceLastAnalysis({ ...base, lastAnalyzedMsgCount: null })).toBe(false);
  expect(nothingNewSinceLastAnalysis({ ...base, lastAnalyzedMsgCount: 0 })).toBe(false);
  expect(nothingNewSinceLastAnalysis({ ...base, lastAnalyzedAt: null })).toBe(false);
});

// ── 二重起動の合流（2026-09-18 竹内「重複だけ直す」）────────────────────────────
// 実測（brain_decision_logs・直近7日608回）: 同じ analyzed_msg_ts の再分析133回のうち
//   1分以内30回／5分以内44回。これは同じ出来事で複数の入口が同時に走った競合。
//   nothingNewSinceLastAnalysis は「前回が完了していれば」効くので、並走には効かない。
const dupBase: DuplicateRunInput = {
  brainAnalyzedAt: "2026-09-18T12:00:00Z", forced: false, hasSuggestedMeta: true,
  nowMs: Date.parse("2026-09-18T12:00:20Z"), // 20秒後
};

it("20秒後の再実行（同じ出来事の二重起動）→ 走らせない", () => {
  expect(isDuplicateRun(dupBase)).toBe(true);
});
it(`${DUPLICATE_RUN_WINDOW_MS / 1000}秒を超えたら走らせる（スタッフ送信後の再分析は仕様）`, () => {
  expect(isDuplicateRun({ ...dupBase, nowMs: Date.parse("2026-09-18T12:00:44Z") })).toBe(true);
  expect(isDuplicateRun({ ...dupBase, nowMs: Date.parse("2026-09-18T12:00:46Z") })).toBe(false);
  expect(isDuplicateRun({ ...dupBase, nowMs: Date.parse("2026-09-18T12:31:00Z") })).toBe(false);
});
it("スタッフの宣言直後（forced）は必ず走らせる", () => {
  expect(isDuplicateRun({ ...dupBase, forced: true })).toBe(false);
});
it("保存済みの判断が無い会話（初回・失敗直後）は必ず走らせる", () => {
  expect(isDuplicateRun({ ...dupBase, hasSuggestedMeta: false })).toBe(false);
});
it("打刻が無い・読めない時は走らせる（fail-open）", () => {
  expect(isDuplicateRun({ ...dupBase, brainAnalyzedAt: null })).toBe(false);
  expect(isDuplicateRun({ ...dupBase, brainAnalyzedAt: "こわれた日付" })).toBe(false);
});
it("打刻が未来（時計のずれ）でも走らせる", () => {
  expect(isDuplicateRun({ ...dupBase, nowMs: Date.parse("2026-09-18T11:59:50Z") })).toBe(false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
