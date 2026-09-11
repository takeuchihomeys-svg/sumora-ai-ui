// 2026-09-11 統合設計 §5: 条件フォームの懸念誤検出（analyzeSubstance）と CONFIRM_NO_OBJECT（確認対象の照合）の回帰テスト。
//   名前・物件名は匿名化（実データの型だけを残す）
// 実行: npx tsx app/lib/__tests__/concern-confirm.test.ts（vitest 不要の自己完結ハーネス。全 PASS で exit 0）
import { analyzeSubstance } from "../reply-context";
import { resolveConfirmationContext } from "../confirmation-context";
import { runDeterministicChecks, type FinalCheckContext } from "../final-check";

// ── ミニハーネス ──
let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toEqual(exp: unknown) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
  };
}
const ctxOf = (cust: string, history: Array<{ sender: string; text: string }> = []): FinalCheckContext => ({
  lastCustomerMessage: cust, customerName: "佐藤",
  recentMessages: [...history, { sender: "customer", text: cust }].map((m, i) => ({ ...m, createdAt: `2026-09-10T0${i}:00:00Z` })),
});
const confirmBlock = (text: string, ctx: FinalCheckContext) =>
  runDeterministicChecks(text, ctx).some((i) => i.code === "CONFIRM_NO_OBJECT" && i.severity === "block");

describe("§5.1 条件フォームの懸念誤検出", () => {
  it("C1 テンプレートの貼り返し（※審査に不安な事がある方〜）とフォームラベルから懸念を立てない", () => {
    const form = "【お部屋お探し中！】\n（ご希望のお部屋探しご条件）\n①【ご入居の時期】⇒10月\n②【ご希望の家賃】⇒7万以内\n③【希望の広さ・間取り】⇒1K\n④【希望築年数】⇒特になし\n⑤【ご希望のエリア・駅名】⇒難波周辺\n※審査に不安な事がある方お気軽にお伝えください😊 審査面柔軟にサポートさせて頂きます！";
    expect(analyzeSubstance(form).concerns.length).toBe(0);
  });
  it("C2 「築年数は古くても大丈夫」は築年の懸念にしない（譲歩形）", () => {
    expect(analyzeSubstance("築年数は古くても大丈夫です。駅近がいいです").concerns.some((c) => c.key === "old")).toBe(false);
  });
  it("C3 同じ行の話題語＋ヘッジ語は懸念のまま（2階と階段が不安）", () => {
    expect(analyzeSubstance("2階だと新生児と階段が不安です").concerns.some((c) => c.key === "floor")).toBe(true);
  });
});

describe("§5.2 CONFIRM_NO_OBJECT（対象が会話に実在すれば block しない）", () => {
  it("K1 「敷金礼金なしのお部屋の募集状況確認させて頂きます＋確認出来次第」（対象語が顧客文に実在）", () => {
    const ctx = ctxOf("敷金礼金なしのお部屋で探しています");
    expect(confirmBlock("敷金礼金なしのお部屋の募集状況確認させて頂きます！！\n確認出来次第ご連絡させて頂きます！！", ctx)).toBe(false);
  });
  it("K2 番号の並び（86、87、88番）は物件の指名", () => {
    const v = resolveConfirmationContext({ customerMessage: "86、87、88番の空室状況も知りたいです" });
    expect(v.allowed).toBe(true);
    expect(confirmBlock("86、87、88番の空室状況も確認させて頂きます！！\n確認出来次第ご連絡させて頂きます！！", ctxOf("86、87、88番の空室状況も知りたいです"))).toBe(false);
  });
  it("K3 日付付きの内覧希望（8月7日に内見）は ご内覧可否 の確認が正しい", () => {
    const v = resolveConfirmationContext({ customerMessage: "8月7日に内見したいです" });
    expect(v.allowed).toBe(true);
    expect(v.source).toBe("customer_viewing_request");
  });
  it("K4 見積・初期費用の依頼は 募集状況・初期費用 の確認が正しい", () => {
    const v = resolveConfirmationContext({ customerMessage: "こちらの見積もりお願いします" });
    expect(v.allowed).toBe(true);
  });
  it("K5 送付済み物件の名指し（台帳の物件名と一致）は customer_named_known_property", () => {
    const v = resolveConfirmationContext({ customerMessage: "サンプルコート気になります", conversationObjects: { propertyNames: ["サンプルコート 203号室"] } });
    expect(v.allowed).toBe(true);
    expect(v.source).toBe("customer_named_known_property");
  });
  it("K6 物件を探す約束（お部屋確認でき次第ご連絡）は確認約束として扱わない", () => {
    expect(confirmBlock("引き続き条件に合ったお部屋確認でき次第ご連絡させて頂きます！！", ctxOf("よろしくお願いします"))).toBe(false);
  });
  it("K7 直前スタッフの「確認させて頂き、」（読点で続く形）も確認約束として一致する", () => {
    const v = resolveConfirmationContext({ customerMessage: "よろしくお願いします", lastStaffMessage: "募集状況を確認させて頂き、空室があるものはお送りさせて頂きます！！" });
    expect(v.source).toBe("staff_confirm_promise");
  });
  it("K8 対象が会話に無い確認約束（「よろしくお願いします」への確認出来次第ご連絡）は従来どおり block", () => {
    expect(confirmBlock("確認出来次第ご連絡させて頂きます！！", ctxOf("よろしくお願いします"))).toBe(true);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
