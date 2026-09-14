// 2026-09-14 S 事例: LINE 絵文字の文字「(よろしく)」・顔文字は飾り。了承だけの返事には「かしこまりました」ではなく「はい😊！！」
// 実行: npx tsx app/lib/__tests__/line-emoji-ack.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse, normalizeCustomerText } from "../reply-context";
import { resolveOpener } from "../greeting";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}
const MEETING = "かしこまりました！！\n9/15（火）14:00〜ご案内させて頂きます！！\n\n9/15 14:00にスプランディッド本町グラン1\n現地エントランスお待ち合わせで何卒よろしくお願い致します！！";
const opener = (msg: string) => {
  const sub = analyzeSubstance(msg);
  const cust = classifyCustomerResponse(sub, classifyLastStaffTurn(MEETING, {}), {});
  return { cust: cust.kind, opener: resolveOpener({ greetingKind: "none", customerKind: cust.kind, customerSecondary: cust.secondary, substanceKinds: sub.kinds }) };
};

it("S: 待ち合わせ案内への「わかりました! よろしくお願いします(よろしく)」→ 了承だけ・開口語は「はい」（かしこまりましたは使わない）", () => {
  const r = opener("わかりました!\nよろしくお願いします(よろしく)");
  expect(r.cust).toBe("ack_only");
  expect(r.opener.opener).toBe("hai");
  expect(r.opener.openerAllowed.includes("kashikomari")).toBe(false);
});
it("絵文字の文字・顔文字を外す（(ぺこり)(emoji)(bow)(T ^ T)(_ _)(>_<)）", () => {
  expect(normalizeCustomerText("ありがとうございます(ぺこり)(emoji)(bow)")).toBe("ありがとうございます");
  expect(normalizeCustomerText("了解です(T ^ T)(_ _)(>_<)")).toBe("了解です");
});
it("意味のある補足は外さない（(無料)(株)(税込)(管理費 1万円)(今後飼育予定)(5t)）", () => {
  for (const t of ["相談(無料)", "(株)ホーム", "8万(税込)", "7万(管理費 1万円)", "猫(今後飼育予定)", "トラック(5t)"]) expect(normalizeCustomerText(t)).toBe(t);
});
it("「(?)」は疑問符として残す（質問のまま）", () => {
  expect(normalizeCustomerText("1LDKの物件ありませんかね(?)")).toBe("1LDKの物件ありませんかね？");
  expect(analyzeSubstance("1LDKの物件ありませんかね(?)").kinds.includes("question")).toBe(true);
});
it("絵文字の後ろに依頼があれば了承だけにしない（「よろしくお願いします(よろしく) 他の物件も見たいです」）", () =>
  expect(opener("よろしくお願いします(よろしく)\n他の物件も見たいです").cust === "ack_only").toBe(false));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
