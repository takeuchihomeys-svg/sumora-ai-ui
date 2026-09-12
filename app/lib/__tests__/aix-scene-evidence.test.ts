// 2026-09-12 竹内方針「AIX のセットはブレインが判断する」段1: 決定論の場面の証拠（detectAixSceneEvidence）と
// 本文の安全（resolveBodySafety）・分析モード判定（decideAnalysisMode）の回帰テスト。
// S1〜S5 の検出11ケースは aix-reply-set.test.ts（2c86c209）から期待値を変えずに移した（場面の検出は判断ではなく証拠になった）。
// 実行: npx tsx app/lib/__tests__/aix-scene-evidence.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { detectAixSceneEvidence, type SceneEvidenceInput } from "../aix-scene-evidence";
import { resolveBodySafety } from "../aix-reply-set";
import { decideAnalysisMode, type AnalysisModeInput } from "../brain-analysis-mode";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}
const base = (o: Partial<SceneEvidenceInput>): SceneEvidenceInput => ({ latestCustomerTurn: "", hasCustomerImage: false, ...o });
const ev = (o: Partial<SceneEvidenceInput>) => detectAixSceneEvidence(base(o));
const safety = (o: Partial<SceneEvidenceInput>) => resolveBodySafety(ev(o), base(o));

describe("場面の証拠 S1〜S5（2c86c209 の期待値のまま）", () => {
  it("S1 11c492f7「どの部屋が今ところ空室ですか？」→ property_check_result（after_confirm）", () => {
    const x = ev({ latestCustomerTurn: "どの部屋が今ところ空室ですか？" });
    expect(x?.candidateAction).toBe("property_check_result"); expect(x?.timing).toBe("after_confirm"); expect(x?.scene).toBe("S1_vacancy");
  });
  it("S1 送付物件への指示語＋空き質問 → S1", () => {
    expect(ev({ latestCustomerTurn: "さっきのお部屋まだ空いてますか？", sentPropertyCount: 3 })?.scene).toBe("S1_vacancy");
  });
  it("S1 URL＋空室語（旧 P0）→ property_check_result", () => {
    expect(ev({ latestCustomerTurn: "https://suumo.jp/chintai/xx/ ここ空いてますか" })?.candidateAction).toBe("property_check_result");
  });
  it("S2「この物件の最短入居可能日はいつですか？」→ mgmt_move_in（本文の安全に MOVEIN_DATE_ASSERTION）", () => {
    const o = { latestCustomerTurn: "この物件の最短入居可能日はいつですか？" };
    expect(ev(o)?.checkPattern).toBe("mgmt_move_in"); expect(safety(o)?.forbidden.includes("MOVEIN_DATE_ASSERTION")).toBe(true);
  });
  it("S2 退去予定の物件 → vacate_date", () => {
    expect(ev({ latestCustomerTurn: "この物件いつから住めますか？", propertyStatus: "move_out_scheduled" })?.checkPattern).toBe("vacate_date");
  });
  it("S3 物件ありの審査質問 → mgmt_guarantor", () => {
    expect(ev({ latestCustomerTurn: "この物件って審査厳しいですか？" })?.checkPattern).toBe("mgmt_guarantor");
  });
  it("S3 物件が特定できない審査不安（096825c8 型の一般論）→ null", () => {
    expect(ev({ latestCustomerTurn: "現在大学4年生で内定があります。審査通りますか？" })).toBe(null);
  });
  it("S4 82e2d5cf「明日ってまだ空いてますか？彼氏がいけるみたい」→ viewing_invite", () => {
    expect(ev({ latestCustomerTurn: "明日ってまだ空いてますか？彼氏がいけるみたいで" })?.candidateAction).toBe("viewing_invite");
  });
  it("S4「拝見したいです」→ viewing_invite", () => expect(ev({ latestCustomerTurn: "メロディハイムの別の部屋も拝見したいです" })?.candidateAction).toBe("viewing_invite"));
  it("S5「9/9の15時からお願いします！」＋viewing_invite 履歴 → meeting_place（bridge=null）", () => {
    const o = { latestCustomerTurn: "9/9の15時からお願いします！", aixHistory: [{ aix_type: "viewing_invite" }] };
    expect(ev(o)?.candidateAction).toBe("meeting_place"); expect(safety(o)?.bridge).toBe(null); expect(ev(o)?.timing).toBe("now");
  });
  it("S5 viewing_invite 履歴なしの時刻指定 → meeting_place にしない", () => {
    expect(ev({ latestCustomerTurn: "9/9の15時からお願いします！" })?.candidateAction === "meeting_place").toBe(false);
  });
});

describe("本文の安全（resolveBodySafety）", () => {
  it("S1/S2/S3 は確認約束の根拠になる", () => {
    expect(safety({ latestCustomerTurn: "この物件まだ空いてますか？" })?.confirmationBasis).toBe("property_check_result");
    expect(safety({ latestCustomerTurn: "この物件って審査厳しいですか？" })?.confirmationBasis).toBe("property_check_result");
  });
  it("S4 内覧は確認約束の根拠にならない", () => {
    expect(safety({ latestCustomerTurn: "メロディハイムの別の部屋も拝見したいです" })?.confirmationBasis).toBe(null);
  });
  it("証拠なし → null", () => expect(safety({ latestCustomerTurn: "ありがとうございます" })).toBe(null));
});

const modeBase = (o: Partial<AnalysisModeInput>): AnalysisModeInput => ({
  hasCachedMeta: true, totalMsgCount: 40, isFullBypass: false, isIncrementalBypass: false,
  hoursSinceLastFull: 1, hoursSinceLastMsg: 1, msgsSinceDeep: 5, msgsSinceLastFull: 2,
  latestCustomerText: "ありがとうございます", latestCustomerMsgAt: "2026-09-12T10:00:00Z",
  prevAnalyzedMsgTs: "2026-09-12T09:00:00Z", prevAction: "", sentPropertyCount: 0, ...o,
});

describe("分析モード判定（decideAnalysisMode）", () => {
  it("新しい顧客発言に場面の証拠 → incremental に格上げ", () => {
    const x = decideAnalysisMode(modeBase({ latestCustomerText: "この物件まだ空いてますか？" }));
    expect(x.mode).toBe("incremental"); expect(x.upgradeReason).toBe("scene_evidence:S1_vacancy");
  });
  it("前回 action あり＋新しい顧客発言 → incremental（前の AIX 判断を見直す）", () => {
    const x = decideAnalysisMode(modeBase({ prevAction: "viewing_invite" }));
    expect(x.mode).toBe("incremental"); expect(x.upgradeReason).toBe("prev_action:viewing_invite");
  });
  it("証拠なし・前回 action なし → cached", () => expect(decideAnalysisMode(modeBase({})).mode).toBe("cached"));
  it("前回の分析が今回の顧客発言を見ている → 格上げしない", () => {
    expect(decideAnalysisMode(modeBase({ prevAction: "viewing_invite", prevAnalyzedMsgTs: "2026-09-12T10:00:00Z" })).mode).toBe("cached");
  });
  it("既存の full 条件（メッセージ数<11）はそのまま", () => expect(decideAnalysisMode(modeBase({ totalMsgCount: 5 })).mode).toBe("full"));
  it("既存の incremental 条件（10件以上）はそのまま（upgradeReason なし）", () => {
    const x = decideAnalysisMode(modeBase({ msgsSinceLastFull: 10 }));
    expect(x.mode).toBe("incremental"); expect(x.upgradeReason).toBe(null);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
