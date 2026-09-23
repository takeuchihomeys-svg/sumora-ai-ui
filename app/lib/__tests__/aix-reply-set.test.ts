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

// 2026-09-23 竹内「室内の写真が欲しいといわれたら AIX の物件確認したの室内写真確認したのピッカーから送る形」
describe("①' 室内写真（S11・interior_photo）の行", () => {
  it("ブレインが property_check_result + interior_photo → timing now・ラベル「物件確認した→室内写真を確認した」・受付の一文の橋渡し", () => {
    const x = r({ latestCustomerTurn: "これ室内写真欲しいです", sentPropertyCount: 3, brainDecision: brain("property_check_result", { check_pattern: "interior_photo" }) });
    expect(x?.action).toBe("property_check_result"); expect(x?.check_pattern).toBe("interior_photo");
    expect(x?.timing).toBe("now"); expect(x?.scene).toBe("S11_other_room");
    expect(x?.label).toBe("物件確認した→室内写真を確認した");
    expect(x?.bridge).toBe("かしこまりました😊！！室内のお写真お送りさせて頂きます！！");
    expect(/ご用意出来ていない/.test(x?.forbiddenText ?? "")).toBe(true);
    expect(/確認出来次第ご連絡/.test(x?.forbiddenText ?? "")).toBe(true);
    expect(/私の方で撮影し/.test(x?.forbiddenText ?? "")).toBe(true);
  });
  it("証拠が無い時（ブレインだけが interior_photo）でも同じ行（旧 genericRow は after_confirm で矛盾文が出ていた）", () => {
    const x = r({ latestCustomerTurn: "ありがとうございます", brainDecision: brain("property_check_result", { check_pattern: "interior_photo" }) });
    expect(x?.timing).toBe("now"); expect(x?.scene).toBe("S11_other_room");
  });
  it("本文の安全（ブレインが AIX なし）でも S11 の禁止が効く", () => {
    const o = base({ latestCustomerTurn: "室内の写真ありますか？", sentPropertyCount: 2 });
    const s = resolveBodySafety(detectAixSceneEvidence(o), o);
    expect(s?.scene).toBe("S11_other_room"); expect(s?.confirmationBasis).toBe(null);
    expect(/ご用意出来ていない/.test(s?.forbiddenText ?? "")).toBe(true);
  });
  it("従来の入居日（mgmt_move_in）は after_confirm のまま", () => {
    expect(r({ latestCustomerTurn: "ありがとうございます", brainDecision: brain("property_check_result", { check_pattern: "mgmt_move_in" }) })?.timing).toBe("after_confirm");
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
