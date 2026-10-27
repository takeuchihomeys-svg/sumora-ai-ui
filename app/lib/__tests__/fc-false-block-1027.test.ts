// 最終チェックの誤った要修正の直し（2026-10-27・自信が低い番 fc_block の番 8212・8237）。実物の本文そのまま（名前は伏せた）
// 実行: npx tsx app/lib/__tests__/fc-false-block-1027.test.ts
import { staffAssertsSchedule, fcFalseBlockFixEnabled, STAFF_ASSERT_SCHEDULE_RE } from "../reply-context";
import { keyBanAllowRe, CUSTOMER_CONTRACT_KEY_RE } from "../line-reply-prompts";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
const ON = { FC_FALSE_BLOCK_1027: "on" };

const DRAFT_8237 = "契約方法についてご案内させて頂きます！！\nお申込みはLINEで完結し、お申込み用フォーマットのご入力と本人確認書類（運転免許証またはマイナンバーカードの裏表の写真）をお送り頂く形となります！！";

console.log("切替（既定 off）");
it("既定 off・on で入る", () => { eq(fcFalseBlockFixEnabled({}), false); eq(fcFalseBlockFixEnabled(ON), true); });

console.log("内覧の日時の決め打ち（SCHEDULE_ASSERT_UNCONFIRMED）");
it("off は今まで通り（手続きの説明も決め打ちに数える）", () => { eq(staffAssertsSchedule(DRAFT_8237, {}), true); eq(STAFF_ASSERT_SCHEDULE_RE.test(DRAFT_8237), true); });
it("on: 「契約方法についてご案内させて頂きます」は決め打ちではない（番 8237）", () => eq(staffAssertsSchedule(DRAFT_8237, ON), false));
it("on: 内覧の決め打ちは今まで通り数える（実送信の行末の形）", () => {
  for (const t of ["ご都合よろしいお日にちにお部屋ご案内させて頂きます！！", "本日13時お部屋ご案内させて頂きます！！", "10/28（水）お部屋ご案内させて頂きます！！", "10/28 13:00に現地エントランスお待ち合わせで何卒よろしくお願い致します！！"]) eq(staffAssertsSchedule(t, ON), true, t);
});

console.log("鍵交換への言及の禁止（TIMING_VOCAB_MISMATCH・番 8212・8237）");
const CUST = "駐車場が機械式になるかと思いますが、私の車が入らないサイズだと思うので平置きの方にできますか？また鍵交換代はなくせますか？";
it("off: お客様の「鍵交換代はなくせますか」は許す条件に当たらない（今まで通り）", () => eq(keyBanAllowRe({}).test(CUST), false));
it("on: お客様が鍵交換の費用を聞いた時は許す", () => eq(keyBanAllowRe(ON).test(CUST), true));
it("on: 今まで許していた聞き方（鍵はいつ受け取れますか）もそのまま", () => { eq(keyBanAllowRe(ON).test("鍵はいつ受け取れますか"), true); eq(CUSTOMER_CONTRACT_KEY_RE.test("鍵はいつ受け取れますか"), true); });
it("on: 鍵の話が無いお客様の発言は許さない", () => eq(keyBanAllowRe(ON).test("駐車場ありますか？"), false));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
