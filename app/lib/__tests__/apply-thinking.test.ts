// 2026-09-15 竹内（みく事例）: 申込誘導の後の「検討します」は「かしこまりました」で気持ちを受け止め、ふんわりさせずに扉1文で締める
// 実行: npx tsx app/lib/__tests__/apply-thinking.test.ts（自己完結ハーネス。全 PASS で exit 0）
import {
  analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse, resolveTurnPair, resolveCloser, predictCloserSignals, isApplyGuideThinking,
} from "../reply-context";
import { resolveGreeting, enforceOpening } from "../greeting";
import { runDeterministicChecks } from "../final-check";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(s: string) { if (typeof actual !== "string" || !actual.includes(s)) throw new Error(`expected to contain ${JSON.stringify(s)} but got ${JSON.stringify(actual)}`); },
    notToContain(s: string) { if (typeof actual === "string" && actual.includes(s)) throw new Error(`expected not to contain ${JSON.stringify(s)} but got ${JSON.stringify(actual)}`); },
  };
}

const MIKU_STAFF = "こちら3階部分のお部屋募集しております！！\n初期費用の御見積書同封させて頂きました！！\nこちらの間取りのお部屋（29.62㎡）は現在\n301号室と101号室のみとなりますので\nお気に召されましたらお申込しお部屋抑えさせて頂きます！！\nお手隙の際にご査収ください😌！！";
const MIKU_CUST = "ありがとうございます。\n長居の方と悩んでいるので検討させていただきます。";
const MIKU_SENT = "かしこまりました😊！！\nみくさん気になる点出てきましたら何時でもお気軽にご連絡ください😌！！";
const MIKU_DRAFT = "はい😊！！\nごゆっくりご検討頂けますと幸いです！！\nみくさん気になる点出てきましたら何時でもお気軽にご連絡ください😌！！";
const PLAIN_STAFF = "🌟メゾン難波 302号室\n家賃6.5万円\nお手隙の際にご査収ください😌！！";

const ctx = (cust: string, staffText: string) => {
  const staff = classifyLastStaffTurn(staffText, { recentAixRows: [], lastStaffAt: "2026-09-15T06:25:00Z" });
  const sub = analyzeSubstance(cust, undefined, { staffAskedQuestion: staff.kind === "question_to_customer" });
  const customer = classifyCustomerResponse(sub, staff, {});
  const pair = resolveTurnPair(staff, customer, sub, staffText, { customerName: "みく" });
  const closer = resolveCloser(pair, predictCloserSignals({}), { customerName: "みく" });
  const greeting = resolveGreeting({
    customerName: "みく", isFirstEverReply: false, alreadyGreetedToday: true, jstHour: 17,
    recentMessages: [
      { sender: "staff", text: "[画像]", createdAt: "2026-09-15T06:24:59Z" },
      { sender: "staff", text: staffText, createdAt: "2026-09-15T06:25:00Z" },
      { sender: "customer", text: cust, createdAt: "2026-09-15T08:17:07Z" },
    ],
    isSubstantive: (t) => analyzeSubstance(t).has, customerKind: customer.kind,
  });
  return { customer, pair, closer, greeting };
};

it("みく: お客様は検討中（thinking）で、申込誘導の後と判定", () => {
  const c = ctx(MIKU_CUST, MIKU_STAFF);
  expect(c.customer.kind).toBe("thinking");
  expect(isApplyGuideThinking(c.customer.kind, MIKU_STAFF)).toBe(true);
});
it("みく: 場面は APPLY_THINKING・開口語は かしこまりました だけ", () => {
  const c = ctx(MIKU_CUST, MIKU_STAFF);
  expect(c.pair.ruleId).toBe("APPLY_THINKING");
  expect(c.greeting.opener).toBe("kashikomari");
  expect(c.greeting.openerAllowed.join(",")).toBe("kashikomari");
});
it("みく: 締めは扉1文（ごゆっくり なし・名前入り）", () => {
  const c = ctx(MIKU_CUST, MIKU_STAFF);
  expect(c.closer.closer).toBe("open_door");
  expect(c.closer.text).toBe("みくさん気になる点出てきましたら何時でもお気軽にご連絡ください😌！！");
  expect(c.closer.text).notToContain("ごゆっくり");
});
it("みく: 下書きの「はい😊！！」は決定論で「かしこまりました😊！！」に直る", () => {
  const c = ctx(MIKU_CUST, MIKU_STAFF);
  expect(enforceOpening(MIKU_DRAFT, c.greeting).cleaned.split("\n")[0]).toBe("かしこまりました😊！！");
});
it("みく: スタッフの実送信は最終チェックで block なし", () => {
  const codes = runDeterministicChecks(MIKU_SENT, {
    lastCustomerMessage: MIKU_CUST, customerName: "みく",
    recentMessages: [{ sender: "staff", text: MIKU_STAFF, createdAt: "2026-09-15T06:25:00Z" }, { sender: "customer", text: MIKU_CUST, createdAt: "2026-09-15T08:17:07Z" }],
  }).filter((i) => i.severity === "block").map((i) => i.code);
  expect(codes.join(",")).toBe("");
});
it("申込誘導が無い物件送付の後の検討は従来どおり（ごゆっくり・はい）", () => {
  const c = ctx("ありがとうございます！検討させて頂きます！", PLAIN_STAFF);
  expect(c.pair.ruleId === "APPLY_THINKING").toBe(false);
  expect(c.closer.closer).toBe("wait_softly");
  expect(c.greeting.opener).toBe("hai");
});
it("申込誘導の後でも質問なら対象外", () => {
  const c = ctx("ありがとうございます。3階の日当たりはどうですか？", MIKU_STAFF);
  expect(c.pair.ruleId === "APPLY_THINKING").toBe(false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
