// 2026-09-12 竹内方針: AIX 送信 → 完了にするやること（物件出しは物件ピックアップした／物件オススメだけ）と、
// スタッフの未履行の宣言 → それを履行する AIX（見積書送る宣言 → AIX 見積書送る）
// 実行: npx tsx app/lib/__tests__/aix-task-link.test.ts
import { taskTypesCompletedByAix, resolveStaffPromiseAix } from "../aix-task-link";
import { classifyStaffTextForLedger } from "../action-ledger";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}
const S = (text: string) => ({ sender: "staff", text });
const C = (text: string) => ({ sender: "customer", text });
const facts = (text: string, o: { est?: boolean; pick?: boolean } = {}) => {
  const e = classifyStaffTextForLedger(text, null);
  return { lastStaffEntry: e, estimatePromisedUnfulfilled: o.est ?? e?.kind === "estimate_declared", pickupPromisedUnfulfilled: o.pick ?? e?.kind === "pickup_declared" };
};

it("物件出しは 物件ピックアップした で完了", () => expect(taskTypesCompletedByAix("property_send")).toBe(["property_send"]));
it("物件出しは 物件オススメ でも完了", () => expect(taskTypesCompletedByAix("property_recommendation")).toBe(["property_send"]));
it("名無しの権兵衛事例: 内覧へ！ では何も完了しない", () => expect(taskTypesCompletedByAix("viewing_invite")).toBe([]));
it("物件確認は 物件確認した で完了（確認します＝管理会社への依頼では完了しない）", () => {
  expect(taskTypesCompletedByAix("property_check_result")).toBe(["property_check"]);
  expect(taskTypesCompletedByAix("acknowledge_check")).toBe([]);
});

it("カイナ事例: 「こちら2件の見積書を作成しお送りさせて頂きます」→ AIX 見積書送る", () => {
  const t = "こちら2件の見積書を作成しお送りさせて頂きます😌！！";
  expect(resolveStaffPromiseAix(facts(t), [C("こちら2つの見積書も作成して頂きたいです"), S(t)])).toBe({ action: "estimate_sheet", kind: "estimate" });
});
it("今ピックアップする宣言 → AIX 物件ピックアップした", () => {
  const t = "かしこまりました！！梅田周辺全域からオススメできるお部屋ピックアップしお送りさせて頂きます！！";
  expect(resolveStaffPromiseAix(facts(t), [C("梅田で探してほしいです"), S(t)])?.action ?? null).toBe("property_send");
});
it("「新着でオススメ出来るお部屋出次第お送り」（条件付き）→ AIX なし", () => {
  const t = "新着でオススメ出来るお部屋で次第お送りさせていただきます！！";
  expect(resolveStaffPromiseAix(facts(t), [C("ありがとうございます"), S(t)])).toBe(null);
});
it("宣言の後にお客様が返信した（最後が顧客）→ この規則は使わない（ブレインが顧客発言で判断）", () => {
  const t = "見積書を作成しお送りさせて頂きます！！";
  expect(resolveStaffPromiseAix(facts(t), [S(t), C("ありがとうございます")])).toBe(null);
});
it("じゅにあ事例の受け口「お送り頂き次第…御見積書とあわせてご連絡」→ AIX なし", () => {
  const t = "はい😊！！\n気になるお部屋ございましたらいつでもお送りください！！\nお送り頂きました物件の募集状況確認させて頂き、最大限割引しました初期費用の御見積書とあわせてご連絡させて頂きます！！";
  const r = resolveStaffPromiseAix(facts(t), [C("何件か気になる物件送ってもいいですか？"), S(t)]);
  expect(r?.action === "estimate_sheet").toBe(false);
});
it("見積書を既に送った（履行済み）→ AIX なし", () => {
  const t = "見積書を作成しお送りさせて頂きます！！";
  expect(resolveStaffPromiseAix(facts(t, { est: false }), [C("見積お願いします"), S(t)])).toBe(null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
