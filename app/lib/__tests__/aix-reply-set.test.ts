// 2026-09-12 竹内方針「AIX のセットはブレインが判断する」段1: resolveReplyAix はブレインの判断を読むだけ。
//   旧（2c86c209）の「場面表 S1〜S5 → AIX」の11ケースは aix-scene-evidence.test.ts へ期待値を変えずに移した（場面は証拠）。
//   旧「brain とずれたら場面を採る」「断言コードから AIX を選ぶ」は廃止（判断の持ち主をブレインに一本化したため期待値を変更）。
// 実行: npx tsx app/lib/__tests__/aix-reply-set.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { resolveReplyAix, resolveReplyAixDecision, confirmationBasisAction, resolveBodySafety, type ReplyAixInput, type BrainAixDecision } from "../aix-reply-set";
import { detectAixSceneEvidence } from "../aix-scene-evidence";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}
const base = (o: Partial<ReplyAixInput>): ReplyAixInput => ({ latestCustomerTurn: "", hasCustomerImage: false, conversationStatus: "proposing", ...o });
const r = (o: Partial<ReplyAixInput>) => resolveReplyAix(base(o));
const brain = (action: string, o: Partial<BrainAixDecision> = {}): BrainAixDecision =>
  ({ action, check_pattern: null, enforcement_level: "recommended", note: null, fresh: true, ...o });

describe("① fresh＋action → ブレインの判断を採る", () => {
  it("場面（S4 内覧）とずれていてもブレインの application_push", () => {
    const x = r({ latestCustomerTurn: "明日ってまだ空いてますか？", brainDecision: brain("application_push") });
    expect(x?.action).toBe("application_push"); expect(x?.source).toBe("brain");
  });
  it("場面と同じ AIX → 橋渡し文は場面の行（S1）", () => {
    const x = r({ latestCustomerTurn: "この物件まだ空いてますか？", brainDecision: brain("property_check_result") });
    expect(x?.action).toBe("property_check_result"); expect(x?.scene).toBe("S1_vacancy"); expect(x?.timing).toBe("after_confirm");
  });
  it("ブレインの enforcement_level をそのまま使う", () => {
    expect(r({ latestCustomerTurn: "ありがとうございます", brainDecision: brain("viewing_invite", { enforcement_level: "required" }) })?.enforcement).toBe("required");
    expect(r({ latestCustomerTurn: "ありがとうございます", brainDecision: brain("viewing_invite") })?.enforcement).toBe("recommended");
  });
  it("ブレインの note を表示に使う", () => {
    expect(r({ latestCustomerTurn: "ありがとうございます", brainDecision: brain("application_push", { note: "申込誘導" }) })?.note).toBe("申込誘導");
  });
  it("acknowledge_check は顧客向けにセットしない → property_check_result（表示の変換）", () => {
    expect(r({ latestCustomerTurn: "ありがとうございます", brainDecision: brain("acknowledge_check") })?.action).toBe("property_check_result");
  });
});

describe("② fresh＋action='' → 場面ヒットがあっても AIX なし", () => {
  it("S1 空室質問でもブレインが '' なら null", () => {
    expect(r({ latestCustomerTurn: "この物件まだ空いてますか？", brainDecision: brain("") })).toBe(null);
  });
  it("ブレインの判断なし（T3）＋S4 → null", () => {
    expect(r({ latestCustomerTurn: "メロディハイムの別の部屋も拝見したいです", brainDecision: null })).toBe(null);
  });
});

describe("③④ stale / cached → AIX なし・本文の安全は残る", () => {
  it("③ stale＋場面ヒット → AIX null、bodySafety.bridge あり", () => {
    const o = base({ latestCustomerTurn: "この物件の最短入居可能日はいつですか？", brainDecision: brain("property_check_result", { fresh: false }) });
    const d = resolveReplyAixDecision(o);
    expect(d.aix).toBe(null); expect(d.brainStale).toBe(true);
    const s = resolveBodySafety(detectAixSceneEvidence(o), o);
    expect(!!s?.bridge).toBe(true); expect(s?.forbidden.includes("MOVEIN_DATE_ASSERTION")).toBe(true);
    // 確認約束は本文の安全の根拠（S2）で認める＝AIX のセットとは別
    expect(confirmationBasisAction(s, d.aix)).toBe("property_check_result");
  });
  it("④ cached（呼び出し側で fresh=false）→ null", () => {
    expect(r({ latestCustomerTurn: "ありがとうございます", brainDecision: brain("viewing_invite", { fresh: false, enforcement_level: "optional" }) })).toBe(null);
  });
});

describe("⑤ ブレインの check_pattern を判定し直さない", () => {
  it("brain=property_check_result / mgmt_move_in → mgmt_move_in のまま（顧客発言が審査でも）", () => {
    const x = r({ latestCustomerTurn: "この物件って審査厳しいですか？", brainDecision: brain("property_check_result", { check_pattern: "mgmt_move_in" }) });
    expect(x?.check_pattern).toBe("mgmt_move_in"); expect(x?.label).toBe("確認した（条件・交渉）→入居可能日");
  });
  it("brain=property_check_result / mgmt_initial_cost → そのまま（場面の行は引かない）", () => {
    const x = r({ latestCustomerTurn: "ありがとうございます", brainDecision: brain("property_check_result", { check_pattern: "mgmt_initial_cost" }) });
    expect(x?.check_pattern).toBe("mgmt_initial_cost"); expect(x?.scene).toBe(null);
  });
});

describe("⑥ 生成後（unresolvedBlock）", () => {
  it("unresolvedBlock＋ブレインが '' → AIX null・stopAutoSend", () => {
    const d = resolveReplyAixDecision(base({ latestCustomerTurn: "了解です", brainDecision: brain(""), unresolvedBlock: "AIX_BOUNDARY_ESTIMATE" }));
    expect(d.aix).toBe(null); expect(d.stopAutoSend).toBe(true);
  });
  it("unresolvedBlock＋ブレインに action → そのまま required に上げる（AIX は選び直さない）", () => {
    const d = resolveReplyAixDecision(base({ latestCustomerTurn: "了解です", brainDecision: brain("viewing_invite"), unresolvedBlock: "AIX_BOUNDARY_ESTIMATE" }));
    expect(d.aix?.action).toBe("viewing_invite"); expect(d.aix?.enforcement).toBe("required"); expect(d.stopAutoSend).toBe(true);
  });
  it("assertionHits だけでは AIX を選ばない", () => {
    expect(r({ latestCustomerTurn: "ありがとうございます", brainDecision: brain(""), assertionHits: ["VACANCY_ASSERTION"] })).toBe(null);
  });
  it("場面表に行の無いコード（DISCLOSURE_ASSERTION）は自動送信を止めない", () => {
    expect(resolveReplyAixDecision(base({ latestCustomerTurn: "了解です", brainDecision: brain(""), unresolvedBlock: "DISCLOSURE_ASSERTION" })).stopAutoSend).toBe(false);
  });
});

describe("除外", () => {
  it("screening 段階（下書きを作らない）→ null", () => expect(r({ latestCustomerTurn: "この物件まだ空いてますか？", conversationStatus: "screening", brainDecision: brain("property_check_result") })).toBe(null));
  it("初回返信 → null", () => expect(r({ latestCustomerTurn: "この物件まだ空いてますか？", isFirstReply: true, brainDecision: brain("property_check_result") })).toBe(null));
  it("語彙外の action → null", () => expect(r({ latestCustomerTurn: "了解です", brainDecision: brain("unknown_action_xyz") })).toBe(null));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
