// 2026-09-11 竹内方針2: 復唱の場面判定（resolveCustomerDocScope）と物件名を生成に埋め込まない経路の回帰テスト。
//   物件送付・申込フォームは復唱しない（正解 0/18・0/4）／物件名・建物名・号室・所在階・住所・日付は復唱トークンにしない
// 実行: npx tsx app/lib/__tests__/echo-scope.test.ts（vitest 不要の自己完結ハーネス。全 PASS で exit 0）
import {
  resolveCustomerDocScope, extractEchoTokens, evalConditionEcho, analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse,
  resolveTurnPair, resolveHedgeAllowance, resolveCloser, deriveCloserSignals, buildStanceNote, fillPairPlaceholders, PAIR_MATRIX,
} from "../reply-context";
import { buildActionLedger, buildActionLedgerNote } from "../action-ledger";
import { runDeterministicChecks } from "../final-check";

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
    toContain(item: unknown) { if (!Array.isArray(actual) || !actual.includes(item)) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`); },
    not: { toContain(item: unknown) { if (Array.isArray(actual) && actual.includes(item)) throw new Error(`expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(item)}`); } },
  };
}
const PROP_SHARE = "西大橋 1DK 4階\nhttps://suumo.jp/chintai/bc_000000000000/\nby SUUMO\nこの物件取り扱いあれば初期費用見積もりお願いします！";
const APP_FORM = "【お申込者様記入欄】\n・入居希望日 最短\n・生年月日 2000/01/01\n・現住所 大阪市西区\n・勤続年数 3年\n・年収 300万円";
const COND_FORM = "①【ご入居の時期】⇒10月\n②【ご希望の家賃】⇒7万以内\n③【希望の広さ・間取り】⇒2ldk\n⑤【ご希望のエリア・駅名】⇒加美駅周辺\n⑥【ご希望の駅徒歩分数】⇒10分以内";

describe("場面の判定", () => {
  it("E1 物件送付（URL＋『1DK 4階』）→ property_share・tokens 空・ECHO が出ない", () => {
    const v = resolveCustomerDocScope(PROP_SHARE);
    expect(v.scope).toBe("property_share");
    expect(v.tokens).toEqual([]);
    const c = runDeterministicChecks("お部屋お送りいただきありがとうございます😊！！\n募集状況確認させて頂きます！！", { lastCustomerMessage: PROP_SHARE, customerName: "佐藤" });
    expect(c.some((i) => i.code === "CONDITION_ECHO_MISSING")).toBe(false);
  });
  it("E2 申込フォーム → application_form・tokens 空（個人情報を復唱させない）", () => {
    const v = resolveCustomerDocScope(APP_FORM);
    expect(v.scope).toBe("application_form");
    expect(v.tokens).toEqual([]);
  });
  it("E3 物件送付・申込フォームは analyzeSubstance の condition 種別を立てない", () => {
    expect(analyzeSubstance(PROP_SHARE).kinds.includes("condition")).toBe(false);
    expect(analyzeSubstance(APP_FORM).kinds.includes("condition")).toBe(false);
  });
});

describe("トークンのフィルタと評価", () => {
  it("T1 カタカナ建物名＋町（ビオラコート幸町）・所在階・日付・都道府県始まりの住所を抽出しない", () => {
    const t = extractEchoTokens("ビオラコート幸町あたりで、3階です。家賃7万以内、2階以上希望、9月10日入居、大阪府大阪市中央区");
    expect(t.some((x) => /ビオラコート/.test(x))).toBe(false);
    expect(t).not.toContain("3階");
    expect(t).toContain("2階");
    expect(t.some((x) => /月|日$/.test(x))).toBe(false);
    expect(t.some((x) => /^大阪府/.test(x))).toBe(false);
  });
  it("T2 「加美駅周辺エリア」で「平野区加美駅」を満たす（地名は部分一致）", () => {
    expect(evalConditionEcho("加美駅周辺エリアからオススメのお部屋ピックアップさせて頂きます", ["平野区加美駅"]).echoed.length).toBe(1);
  });
  it("T3 間取りは大文字化（2ldk→2LDK）して比較する", () => {
    const v = resolveCustomerDocScope(COND_FORM);
    expect(v.scope).toBe("condition_form");
    expect(v.tokens).toContain("2LDK");
    expect(evalConditionEcho("2LDKのお部屋ピックアップさせて頂きます", v.tokens).echoed).toContain("2LDK");
  });
  it("T4 条件フォームで復唱が無くても block しない（warning 表示のみ）", () => {
    const c = runDeterministicChecks("ご条件お送り頂きありがとうございます😊！！\nご希望のご条件に合ったお部屋ピックアップさせて頂きます！！", { lastCustomerMessage: COND_FORM, customerName: "佐藤" });
    expect(c.filter((i) => i.code === "CONDITION_ECHO_MISSING").every((i) => i.severity === "warning")).toBe(true);
  });
});

describe("生成に物件名を埋め込まない", () => {
  const staffText = "🌟テストハイツ 201号室\n家賃6.5万円\nお手隙の際にご査収ください😌！！";
  const cust = "テストハイツ気になります！";
  const L = buildActionLedger({
    recentAixRows: [{ aix_type: "property_send", created_at: "2026-09-10T10:00:00Z", sent_at: "2026-09-10T10:00:01Z", line_message_id: "x1", property_names: ["テストハイツ 201号室"] }],
    messages: [{ sender: "staff", text: staffText, createdAt: "2026-09-10T10:00:01Z", isAix: true }, { sender: "customer", text: cust, createdAt: "2026-09-10T11:00:00Z" }],
    lastCustomerAt: "2026-09-10T11:00:00Z",
  });
  it("N1 buildStanceNote は物件送付では復唱の指示を出さない", () => {
    const staff = classifyLastStaffTurn(staffText, { lastStaffAt: "2026-09-10T10:00:01Z", ledger: L });
    const sub = analyzeSubstance(PROP_SHARE);
    const customer = classifyCustomerResponse(sub, staff, { ledger: L });
    const pair = resolveTurnPair(staff, customer, sub, staffText, { ledger: L, customerName: "佐藤" });
    const hedge = resolveHedgeAllowance({ customerMessage: PROP_SHARE, substance: sub, staff, customer, lastStaffText: staffText, lastCustomerAt: "2026-09-10T11:00:00Z", ledger: L });
    const closer = resolveCloser(pair, deriveCloserSignals(""), { customerName: "佐藤" });
    const note = buildStanceNote(pair, hedge, closer, { customerName: "佐藤", customerText: PROP_SHARE });
    expect(/条件の復唱|一文字も変えずに/.test(note)).toBe(false);
  });
  it("N2 台帳の summary・note に物件名が出ない（照合用の事実は facts に残る）", () => {
    expect(L.summary.includes("テストハイツ")).toBe(false);
    expect(buildActionLedgerNote(L, { customerName: "佐藤" }).includes("テストハイツ")).toBe(false);
    expect(L.facts.propertiesSentNames).toContain("テストハイツ 201号室");
  });
  it("N3 PS_POSITIVE の fix・direction に物件名が入らない", () => {
    const staff = classifyLastStaffTurn(staffText, { lastStaffAt: "2026-09-10T10:00:01Z", ledger: L });
    const sub = analyzeSubstance(cust);
    const customer = classifyCustomerResponse(sub, staff, { ledger: L });
    const pair = resolveTurnPair(staff, customer, sub, staffText, { ledger: L, customerName: "佐藤" });
    const rule = PAIR_MATRIX.find((r) => r.id === "PS_POSITIVE")!;
    const rendered = [rule.direction, ...rule.mustInclude.map((m) => m.fix), ...rule.mustInclude.flatMap((m) => (m.preferWhenAvoid ?? []).map((p) => p.use))].map((s) => fillPairPlaceholders(s, pair)).join("\n");
    expect(rendered.includes("テストハイツ")).toBe(false);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
