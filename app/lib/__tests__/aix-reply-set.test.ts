// 2026-09-12 竹内方針A: 「AIX で送る場面」の判定（resolveReplyAix）の回帰テスト。
// 実行: npx tsx app/lib/__tests__/aix-reply-set.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { resolveReplyAix, type ReplyAixInput } from "../aix-reply-set";

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

describe("場面表 S1〜S5", () => {
  it("S1 11c492f7「どの部屋が今ところ空室ですか？」→ property_check_result（after_confirm）", () => {
    const x = r({ latestCustomerTurn: "どの部屋が今ところ空室ですか？" });
    expect(x?.action).toBe("property_check_result"); expect(x?.timing).toBe("after_confirm"); expect(x?.scene).toBe("S1_vacancy");
  });
  it("S1 送付物件への指示語＋空き質問 → property_check_result", () => {
    expect(r({ latestCustomerTurn: "さっきのお部屋まだ空いてますか？", sentPropertyCount: 3 })?.scene).toBe("S1_vacancy");
  });
  it("S1 URL＋空室語（旧 P0）→ property_check_result", () => {
    expect(r({ latestCustomerTurn: "https://suumo.jp/chintai/xx/ ここ空いてますか" })?.action).toBe("property_check_result");
  });
  it("S2「この物件の最短入居可能日はいつですか？」→ mgmt_move_in", () => {
    const x = r({ latestCustomerTurn: "この物件の最短入居可能日はいつですか？" });
    expect(x?.check_pattern).toBe("mgmt_move_in"); expect(x?.forbidden.includes("MOVEIN_DATE_ASSERTION")).toBe(true);
  });
  it("S2 退去予定の物件 → vacate_date", () => {
    expect(r({ latestCustomerTurn: "この物件いつから住めますか？", propertyStatus: "move_out_scheduled" })?.check_pattern).toBe("vacate_date");
  });
  it("S3 物件ありの審査質問 → mgmt_guarantor", () => {
    expect(r({ latestCustomerTurn: "この物件って審査厳しいですか？" })?.check_pattern).toBe("mgmt_guarantor");
  });
  it("S3 物件が特定できない審査不安（096825c8 型の一般論）→ null", () => {
    expect(r({ latestCustomerTurn: "現在大学4年生で内定があります。審査通りますか？" })).toBe(null);
  });
  it("S4 82e2d5cf「明日ってまだ空いてますか？彼氏がいけるみたい」→ viewing_invite", () => {
    expect(r({ latestCustomerTurn: "明日ってまだ空いてますか？彼氏がいけるみたいで" })?.action).toBe("viewing_invite");
  });
  it("S4「拝見したいです」→ viewing_invite", () => expect(r({ latestCustomerTurn: "メロディハイムの別の部屋も拝見したいです" })?.action).toBe("viewing_invite"));
  it("S5「9/9の15時からお願いします！」＋viewing_invite 履歴 → meeting_place（bridge=null）", () => {
    const x = r({ latestCustomerTurn: "9/9の15時からお願いします！", aixHistory: [{ aix_type: "viewing_invite" }] });
    expect(x?.action).toBe("meeting_place"); expect(x?.bridge).toBe(null); expect(x?.timing).toBe("now");
  });
  it("S5 viewing_invite 履歴なしの時刻指定 → meeting_place にしない", () => {
    expect(r({ latestCustomerTurn: "9/9の15時からお願いします！" })?.action === "meeting_place").toBe(false);
  });
});

describe("除外・優先", () => {
  it("screening 段階（下書きを作らない）→ null", () => expect(r({ latestCustomerTurn: "この物件まだ空いてますか？", conversationStatus: "screening" })).toBe(null));
  it("初回返信 → null", () => expect(r({ latestCustomerTurn: "この物件まだ空いてますか？", isFirstReply: true })).toBe(null));
  it("brain とずれた時は場面の判定を採る", () => {
    const x = r({ latestCustomerTurn: "明日ってまだ空いてますか？", brainCandidate: { action: "application_push" } });
    expect(x?.action).toBe("viewing_invite"); expect(x?.source).toBe("scene");
  });
  it("場面なし＋brain → brain を recommended で", () => {
    const x = r({ latestCustomerTurn: "ありがとうございます", brainCandidate: { action: "application_push" } });
    expect(x?.source).toBe("brain"); expect(x?.enforcement).toBe("recommended");
  });
  it("brain の acknowledge_check は顧客向けにセットしない → property_check_result", () => {
    expect(r({ latestCustomerTurn: "ありがとうございます", brainCandidate: { action: "acknowledge_check" } })?.action).toBe("property_check_result");
  });
});

describe("生成後（assertionHits / unresolvedBlock）", () => {
  it("assertionHits=VACANCY_ASSERTION だけ → S1（橋渡しは後処理の置換文と同じ）", () => {
    const x = r({ latestCustomerTurn: "ありがとうございます", assertionHits: ["VACANCY_ASSERTION"] });
    expect(x?.action).toBe("property_check_result"); expect(x?.source).toBe("assertion"); expect(x?.bridge).toBe("最新の空き状況を確認しご連絡させて頂きます😊！！");
  });
  it("assertionHits=MOVEIN_DATE_ASSERTION → S2", () => expect(r({ latestCustomerTurn: "了解です", assertionHits: ["MOVEIN_DATE_ASSERTION"] })?.check_pattern).toBe("mgmt_move_in"));
  it("assertionHits=SCREENING_ASSURANCE → S3", () => expect(r({ latestCustomerTurn: "了解です", assertionHits: ["SCREENING_ASSURANCE"] })?.check_pattern).toBe("mgmt_guarantor"));
  it("DISCLOSURE_ASSERTION は専用 AIX が無い → null", () => expect(r({ latestCustomerTurn: "了解です", assertionHits: ["DISCLOSURE_ASSERTION"] })).toBe(null));
  it("unresolvedBlock（AIX_BOUNDARY_ESTIMATE）→ required", () => {
    const x = r({ latestCustomerTurn: "了解です", unresolvedBlock: "AIX_BOUNDARY_ESTIMATE" });
    expect(x?.action).toBe("estimate_sheet"); expect(x?.enforcement).toBe("required");
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
