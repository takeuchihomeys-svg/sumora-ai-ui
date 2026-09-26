// 2026-09-26 竹内「ここの部分改善する根本的に」（穴1: 約束の言い直し）— YUMA の前後比較（scripts/yuma-done-state-test.ts S2）で見つけた残りの出所
//   done-state の3か所（promiseEchoNote・gratitudeActionHint・場面ラベル）を直した後も、往復文脈のセル CP_ACK が
//   「直前約束の復唱WE DO」を必須にしていて、20分前の「駐車場の空き状況…確認出来次第ご連絡」の後の「ありがとうございます😊よろしくお願いします！」に
//   「募集状況確認出来次第ご連絡させて頂きます！！」を 2/3 で書かせた（対象も化けた）→ 待ちの形の時だけ受けだけの CP_ACK_WAIT を選ぶ
// 実行: npx tsx app/lib/__tests__/wait-form-ack-cell.test.ts
import { analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse, resolveTurnPair, mustIncludeSatisfied } from "../reply-context";
import { findWaitFormPromises } from "../done-state";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (a !== b) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

const pairOf = (staffText: string, cust: string) => {
  const staff = classifyLastStaffTurn(staffText, { recentAixRows: [], lastStaffAt: "2026-09-26T06:00:00Z" });
  const sub = analyzeSubstance(cust, undefined, { staffAskedQuestion: staff.kind === "question_to_customer" });
  const customer = classifyCustomerResponse(sub, staff, {});
  const waitFormPromised = findWaitFormPromises(staffText).some((w) => w.kind !== "見積");
  return { staff, customer, pair: resolveTurnPair(staff, customer, sub, staffText, { customerName: "YUMA", waitFormPromised }) };
};

// YUMA の場面 S2（実物の形・物件名は架空）
const S2_STAFF = "かしこまりました😊！！\nテストハイツ梅田の駐車場の空き状況管理会社に確認出来次第ご連絡させて頂きます！！";
const S2_CUST = "ありがとうございます😊よろしくお願いします！";

it("待ちの形の確認の約束 → 了承だけ ＝ CP_ACK_WAIT（受けだけ）", () => {
  const { staff, customer, pair } = pairOf(S2_STAFF, S2_CUST);
  eq(staff.kind, "confirmation_promise"); eq(customer.kind, "ack_only");
  eq(pair.ruleId, "CP_ACK_WAIT");
});
it("CP_ACK_WAIT の必須は受けの締めだけ（YUMA 後の下書き「はい😊！！何卒よろしくお願い致します😌！！」を満たす・復唱は求めない）", () => {
  const { pair } = pairOf(S2_STAFF, S2_CUST);
  const els = pair.rule?.mustInclude ?? [];
  eq(els.length, 1);
  eq(mustIncludeSatisfied(els[0], "はい😊！！\n何卒よろしくお願い致します😌！！", pair), true);
  eq(/確認出来次第/.test(pair.rule?.example ?? ""), false);
});
it("宣言だけ（次第なし）の確認の約束への了承は CP_ACK_WAIT にしない（スタッフも 5/8 で言い直す＝線の外）", () => {
  const { pair } = pairOf("かしこまりました😊！！\nテストハイツ梅田の駐車場の空き状況管理会社に確認させて頂きます！！", S2_CUST);
  eq(pair.ruleId === "CP_ACK_WAIT", false);
});
it("待ちの形の約束を渡さない経路（check-reply 等・opts 省略）は従来どおり CP_ACK", () => {
  const staff = classifyLastStaffTurn(S2_STAFF, { recentAixRows: [], lastStaffAt: "2026-09-26T06:00:00Z" });
  const sub = analyzeSubstance(S2_CUST, undefined, {});
  const customer = classifyCustomerResponse(sub, staff, {});
  eq(resolveTurnPair(staff, customer, sub, S2_STAFF, {}).ruleId, "CP_ACK");
});
it("初回の挨拶文の中の待ちの形は当てない（スタッフも 2/2 で言い直す）→ CP_ACK_WAIT にしない", () => {
  const { pair } = pairOf("はじめまして！！スモラの竹内と申します！！\nお送り頂きました物件の募集状況確認出来次第ご連絡させて頂きます！！", "ありがとうございます！");
  eq(pair.ruleId === "CP_ACK_WAIT", false);
});
it("了承ではない（質問）時は CP_ACK_WAIT にしない", () => {
  const { pair } = pairOf(S2_STAFF, "駐車場の料金も分かりますか？");
  eq(pair.ruleId === "CP_ACK_WAIT", false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
