// 条件つきの交渉の説明を「交渉の約束」に数えない（further-discount.negotiationPromisePending・NEGOTIATION_PROMISE_SKIP_CONDITIONAL）— 実物・LLM なし
// 実行: npx tsx app/lib/__tests__/negotiation-conditional.test.ts
import { negotiationPromisePending } from "../further-discount";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

// 実物（10/26・お客様の名前なし）
const COND = "保証会社はアシストレントと言う保証会社となります！！\nこちらの保証会社審査仮に否決となった場合別の保証会社で審査行えるように貸主側に交渉させて頂きます！！\n\n預貯金は基本的に必要御座いません。";
const REAL = "かしこまりました！！\n管理会社に礼金の減額交渉させて頂きます！！\n確認出来次第ご連絡させて頂きます！！";
const ON = { NEGOTIATION_PROMISE_SKIP_CONDITIONAL: "on" };
console.log("negotiation-conditional");
it("off は今まで通り（条件つきでも約束）", () => eq(negotiationPromisePending({ lastStaffText: COND, customerAckOnly: true, reportedAfter: false, env: {} }), true));
it("on: 条件つきの説明は約束にしない", () => eq(negotiationPromisePending({ lastStaffText: COND, customerAckOnly: true, reportedAfter: false, env: ON }), false));
it("on: 本当の交渉の約束はそのまま", () => eq(negotiationPromisePending({ lastStaffText: REAL, customerAckOnly: true, reportedAfter: false, env: ON }), true));
it("on: 「もしよろしければ…申請させて頂きます」は条件ではない", () => eq(negotiationPromisePending({ lastStaffText: "もしよろしければ代表に申請させて頂きます！！", customerAckOnly: true, reportedAfter: false, env: ON }), true));
it("on: 「11/16日もしくは11/20日にご入居が可能か交渉させていただきます」（もしくは）は約束のまま（監査 10/28 で見つけた）", () =>
  eq(negotiationPromisePending({ lastStaffText: "かしこまりました！！\n管理会社に11/16日もしくは11/20日にご入居が可能か交渉させていただきます😊！！", customerAckOnly: true, reportedAfter: false, env: ON }), true));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
