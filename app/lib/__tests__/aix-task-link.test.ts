// 2026-09-12 竹内方針: AIX 送信 → 完了にするやること（物件出しは物件ピックアップした／物件オススメだけ）と、
// スタッフの未履行の宣言 → それを履行する AIX（見積書送る宣言 → AIX 見積書送る）
// 実行: npx tsx app/lib/__tests__/aix-task-link.test.ts
import { taskTypesCompletedByAix, resolveStaffPromiseAix } from "../aix-task-link";
import { classifyStaffTextForLedger } from "../action-ledger";
import { customerRequestedPropertyCheck } from "../aix-scene-evidence";

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
const facts = (text: string, o: { est?: boolean; pick?: boolean; conf?: boolean } = {}) => {
  const e = classifyStaffTextForLedger(text, null);
  return { lastStaffEntry: e, estimatePromisedUnfulfilled: o.est ?? e?.kind === "estimate_declared", pickupPromisedUnfulfilled: o.pick ?? e?.kind === "pickup_declared",
    confirmationPromisedUnfulfilled: o.conf ?? e?.kind === "confirmation_promised" };
};
/** brain-core と同じ: スタッフの宣言より前の顧客の連投に物件確認の依頼があるか */
const asked = (msgs: Array<{ sender: string; text: string }>) => ({ customerRequestedCheck: customerRequestedPropertyCheck({ recentMessages: msgs, sentPropertyCount: 1 }) });

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

// 2026-09-12 竹内（Sさん事例）: 物件の画像＋「空いているか確認お願いしたいです」→ スタッフの確認の宣言 → AIX【物件確認した】
const S_CONFIRM = "かしこまりました！！\nお送り頂きました物件、募集状況確認させて頂きます😊！！\n確認出来次第ご連絡させて頂きます！！";
it("Sさん: 画像＋空室確認の依頼 → 「募集状況確認させて頂きます」→ AIX 物件確認した", () => {
  const msgs = [C("わかりました！\n\n追加でこちらも空いているか確認お願いしたいです(お願いします)"), C("[画像] スプランディッド本町グラン 1604 17.5万円"), C("[画像] ラクラス本町東 1001"), S(S_CONFIRM)];
  expect(resolveStaffPromiseAix(facts(S_CONFIRM), msgs, asked(msgs))).toBe({ action: "property_check_result", kind: "check" });
});
it("お客様が物件の画像だけ送った → 確認の宣言 → AIX 物件確認した（画像で物件が特定されている）", () => {
  const msgs = [C("[画像] ラクラス本町東 1001"), S(S_CONFIRM)];
  expect(resolveStaffPromiseAix(facts(S_CONFIRM), msgs, asked(msgs))?.action ?? null).toBe("property_check_result");
});
it("お客様の依頼が無いのにスタッフが自分から確認を宣言 → AIX なし（物件確認はお客様の依頼があった時だけ）", () => {
  const t = "フジパレス戸建につきましては、管理会社土日休業の為月曜日中型犬飼育可能かご確認させて頂きます！！";
  const msgs = [C("ありがとうございます"), S(t)];
  expect(resolveStaffPromiseAix(facts(t), msgs, asked(msgs))).toBe(null);
});
it("じゅにあ事例（お客様が送る予告への受け口）→ 物件確認した にならない（物件はまだ届いていない）", () => {
  const t = "はい😊！！\n気になるお部屋ございましたらいつでもお送りください！！\nお送り頂きました物件の募集状況確認させて頂き、最大限割引しました初期費用の御見積書とあわせてご連絡させて頂きます！！";
  const msgs = [C("何件か気になる物件送ってもいいですか？"), S(t)];
  expect(resolveStaffPromiseAix(facts(t), msgs, asked(msgs))?.action === "property_check_result").toBe(false);
});
it("確認結果を報告済み（履行済み）→ AIX なし", () => {
  const msgs = [C("こちら空いてますか？\nhttps://example.com/room/1"), S(S_CONFIRM)];
  expect(resolveStaffPromiseAix(facts(S_CONFIRM, { conf: false }), msgs, asked(msgs))).toBe(null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
