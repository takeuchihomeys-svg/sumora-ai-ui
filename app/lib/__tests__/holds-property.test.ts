// 2026-09-12 竹内（あや事例）: 「他社で内覧した・気に入った物件があって初期費用を知りたい（まだ送っていない）」＝持込予告と同じ流れ。
//   返信は「お気に召されましたお部屋お送り頂きますと最大限割引しました初期費用御見積させて頂きます」（届いた前提で書かない）
// 実行: npx tsx app/lib/__tests__/holds-property.test.ts
import {
  CUST_WILL_SEND_SELF_PRED, analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse, resolveTurnPair,
} from "../reply-context";
import { detectAixSceneEvidence, customerRequestedPropertyCheck } from "../aix-scene-evidence";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

const AYA = "沢山ありがとうございます🙇🏻‍♀️\n昨日今日と他の不動産屋さんで\n内覧したお家があり、良さそうだなって\n思った物件がありまして、初期費用が\nどれくらいになるか教えていただきたい\nのですが、可能でしょうか？";
const SANA = "お世話になっております。\n1つ初期費用など諸々を調べて頂きたい物件があるのですが、可能でしょうか？";
const DIOS = "DIOS GALAXY 特にあやさんご希望こ好条件にあったお部屋となります！！\nお部屋ご内覧できますので、お気に召されましたら一度お部屋ご案内させて頂きます😌！！";

it("あや: 他社で内覧した物件＋初期費用 → 持込予告（手元の物件）", () => expect(CUST_WILL_SEND_SELF_PRED(AYA).yes).toBe(true));
it("Sana: 調べて頂きたい物件がある＋初期費用 → 持込予告", () => expect(CUST_WILL_SEND_SELF_PRED(SANA).yes).toBe(true));
it("URL が同じ連投にある（もう届いた）→ 予告ではない", () => expect(CUST_WILL_SEND_SELF_PRED(`${SANA}\nhttps://suumo.jp/chintai/bc_1/`).yes).toBe(false));
it("「気になる物件がありましたらお送りください」（仮定・我々に送って）→ 予告ではない", () => expect(CUST_WILL_SEND_SELF_PRED("気になる物件がありましたら初期費用も教えてください").yes).toBe(false));
it("「空き物件があるか調べていただきたい」（あるかどうかの質問）→ 予告ではない", () => expect(CUST_WILL_SEND_SELF_PRED("セレニテ阿波座ミラクの2階以外にも空き物件があるか調べていただきたいです😭").yes).toBe(false));
it("条件フォームの「いい物件があり次第」→ 予告ではない", () => expect(CUST_WILL_SEND_SELF_PRED("①ご入居の時期 いい物件があり次第\n②希望の家賃 25万\n③希望の地域 松屋町\n⑥初期費用 30万").yes).toBe(false));
it("「条件に合う物件がありません」（否定）→ 予告ではない", () => expect(CUST_WILL_SEND_SELF_PRED("他社では初期費用が安い物件がありませんでした").yes).toBe(false));

it("あや: 場面の証拠に「内覧希望」を出さない（「内覧した」は他社での過去の内覧）", () =>
  expect(detectAixSceneEvidence({ latestCustomerTurn: AYA, hasCustomerImage: false, sentPropertyCount: 3 })).toBe(null));
it("あや: 物件確認の依頼ではない（物件はまだ届いていない）", () =>
  expect(customerRequestedPropertyCheck({ recentMessages: [{ sender: "staff", text: DIOS }, { sender: "customer", text: AYA }], sentPropertyCount: 3 })).toBe(false));

const classify = (cust: string, staffText: string) => {
  const staff = classifyLastStaffTurn(staffText);
  const sub = analyzeSubstance(cust, [cust]);
  const customer = classifyCustomerResponse(sub, staff, {});
  const pair = resolveTurnPair(staff, customer, sub, staffText, { customerName: "あや" });
  return { kind: customer.kind, rule: pair.rule?.id ?? null };
};
it("あや: 質問ではなく持込予告に分類され、持込予告の型が選ばれる", () => {
  const r = classify(AYA, DIOS);
  expect([r.kind, !!r.rule && /WILL_SEND/.test(r.rule)]).toBe(["will_send_later", true]);
});
it("別の質問が並んでいる時（？が2つ）は質問を残す", () => {
  const r = classify(`${SANA}\nあと、今月中に入居できる物件はありますか？`, DIOS);
  expect(r.kind).toBe("question");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(" - " + f); process.exit(1); }
