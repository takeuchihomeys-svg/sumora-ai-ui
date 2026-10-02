// 電話のボタンを送った直後か（app/lib/phone-button-sent.ts）
// 実行: npx tsx app/lib/__tests__/phone-button-sent.test.ts（材料は本番の実物・名前は伏せた）
import { phoneButtonJustSent, callJustFinished } from "../phone-button-sent";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
const t = (min: number) => new Date(Date.parse("2026-09-29T04:00:00Z") + min * 60_000).toISOString();
it("ボタンの直後の時刻の相談（58ae93f3 9/29）→ true", () => {
  eq(phoneButtonJustSent([
    { sender: "customer", text: "両親に頼れない場合は安いところじゃないと厳しいですかね😭", createdAt: t(0) },
    { sender: "staff", text: "[通話リクエスト] 電話をかけるボタン", createdAt: t(5) },
    { sender: "staff", text: "かしこまりました！！\n審査に関して5分程でお打ち合わせさせて頂ければ幸いです！！\nお手隙の際にこちらの電話をかけるボタンよりお電話お願い致します😊！！", createdAt: t(5) },
    { sender: "customer", text: "14:30-15:00くらいに掛けても大丈夫でしょうか？", createdAt: t(20) },
  ]), true);
});
it("ボタンを送っていない電話の依頼（ad97cd40「1度電話可能ですか？」）→ false", () => {
  eq(phoneButtonJustSent([
    { sender: "staff", text: "こちらのお部屋スモ割が適用出来ないお部屋となっており…", createdAt: t(0) },
    { sender: "customer", text: "1度電話可能ですか？", createdAt: t(10) },
  ]), false);
});
it("ボタンが前の日の束（6時間より前）なら false", () => {
  eq(phoneButtonJustSent([
    { sender: "staff", text: "[通話リクエスト] 電話をかけるボタン", createdAt: t(0) },
    { sender: "staff", text: "物件お送りさせて頂きました！！", createdAt: t(600) },
    { sender: "customer", text: "電話できますか？", createdAt: t(700) },
  ]), false);
});
it("最後がこちらの発言なら false", () => {
  eq(phoneButtonJustSent([{ sender: "staff", text: "電話をかけるボタン", createdAt: t(0) }]), false);
});
// 2026-10-02 ⑫ 20巡（thanks_08 の実物）: 電話が終わった後の返事
it("電話のお礼の後・電話に触れない返事 → 電話が終わった", () => {
  eq(callJustFinished([
    { sender: "customer", text: "お忙しい中 お電話ありがとうございました！ 引き続きよろしくお願いします", createdAt: t(0) },
    { sender: "staff", text: "こちらこそお電話ありがとうございました😊！！", createdAt: t(5) },
    { sender: "staff", text: "YUMAさん お世話になっております！！ 改めて探させていただきました", createdAt: t(600) },
    { sender: "customer", text: "こんばんわ！ おせわになってます！ 探していただき ありがとうございます😭", createdAt: t(700) },
  ]), true);
});
it("電話のお礼の後でも、今回また電話を頼んだ → 対象外", () => {
  eq(callJustFinished([
    { sender: "staff", text: "お電話ありがとうございました😊！！", createdAt: t(0) },
    { sender: "customer", text: "もう一度お電話いけますか？", createdAt: t(60) },
  ]), false);
});
it("電話のお礼が3日前 → 対象外", () => {
  eq(callJustFinished([
    { sender: "staff", text: "お電話ありがとうございました😊！！", createdAt: t(0) },
    { sender: "customer", text: "ありがとうございます", createdAt: t(60 * 72) },
  ]), false);
});
console.log(`\n${passed} passed, ${failed} failed`); if (failed) process.exit(1);
