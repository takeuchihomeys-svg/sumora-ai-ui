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
// 2026-09-12 竹内（find-brain-gaps G4）: 確認＋見積書の宣言 → 先に物件確認した（実績 71%）
it("URL＋初期費用の質問 →「募集状況確認させて頂きます！！確認出来次第、…お見積書お送り」→ AIX 物件確認した（見積書ではない）", () => {
  const t = "かしこまりました！！\nお送り頂きました物件の募集状況確認させて頂きます😊！！確認出来次第、最大限割引させていただいた初期費用のお見積書お送りさせて頂きます！！";
  const msgs = [C("ここは初期費用いくらですか？ 照ケ丘矢田１丁目賃貸戸建て https://suumo.jp/chintai/bc_100000000000/"), S(t)];
  expect(resolveStaffPromiseAix(facts(t), msgs, asked(msgs))).toBe({ action: "property_check_result", kind: "check" });
});
it("物件名指しの見積依頼 →「初期費用確認出来次第…お見積書お送り」（募集状況の確認なし）→ AIX 見積書送る のまま", () => {
  const t = "かしこまりました！！\nクレール元町203号室、初期費用確認出来次第、最大限割引させて頂いたお見積書お送りさせていただきます！！";
  const msgs = [C("クレール元町の見積りお願いしたいです。"), S(t)];
  expect(resolveStaffPromiseAix(facts(t), msgs, asked(msgs))?.action ?? null).toBe("estimate_sheet");
});
// 2026-09-12 竹内（あや事例）: 物件が届く前の「お送り頂き次第…御見積書作成しお送り」は届いてからの約束 → AIX なし
it("あや: 手元の物件の見積依頼（未送付）→「お送り頂き次第…最大限割引した初期費用の御見積書作成しお送りさせて頂きます」→ AIX なし", () => {
  const t = "かしこまりました😊！！\nお気に召されましたお部屋お送り頂き次第、最大限割引しました初期費用の御見積書作成しお送りさせて頂きます！！";
  const msgs = [C("他の不動産屋さんで内覧したお家があり、良さそうだなって思った物件がありまして、初期費用がどれくらいになるか教えていただきたいのですが、可能でしょうか？"), S(t)];
  expect(resolveStaffPromiseAix(facts(t), msgs, { ...asked(msgs), customerWillSend: true })).toBe(null);
});
it("初回挨拶「お部屋探しを担当させて頂きます鈴木と申します」だけ → ピックアップ宣言ではない（AIX なし）", () => {
  const t = "ryouさん、はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！";
  expect(classifyStaffTextForLedger(t, null)?.kind === "pickup_declared").toBe(false);
});
it("「ご希望条件に合ったお部屋ピックアップしてお送りさせて頂きます」→ 条件ヒアリングではなくピックアップ宣言", () => {
  const t = "谷9周辺全域からもアヤさんのご希望条件に合ったお部屋ピックアップしてお送りさせて頂きます😊！！";
  expect(classifyStaffTextForLedger(t, null)?.kind ?? null).toBe("pickup_declared");
});
it("フォーム記入の依頼（ご入力いただけましたら…ピックアップ）は条件ヒアリングのまま", () => {
  const t = "かしこまりました！！ 上記お部屋探しフォーマットご入力いただけましたら私の方でオススメできるお部屋ピックアップさせていただきます😊！！";
  expect(classifyStaffTextForLedger(t, null)?.kind ?? null).toBe("condition_asked");
});
// 2026-09-12 竹内（響夢事例）: 条件フォームの直後の「条件お送り頂きますと…ピックアップしお送り…ご入力ください」は条件のお願い
//   → ピックアップの約束ではない（条件が届いてからブレインが 物件ピックアップした をセットする）
const KYOMU = "こちらに見木さん最新のお部屋探しの条件お送り頂きますと、見木さんご希望のご条件に合ったお部屋を私の方でピックアップしお送りさせて頂きます😊！！\nよろしければお手隙の際にご入力ください😌✨";
it("響夢: 「条件お送り頂きますと…ピックアップしお送り…ご入力ください」→ 条件ヒアリング・AIX なし", () => {
  expect(classifyStaffTextForLedger(KYOMU, null)?.kind ?? null).toBe("condition_asked");
  expect(resolveStaffPromiseAix(facts(KYOMU), [C("ありがとうございます\n一旦検討してみます"), S("（ご希望のお部屋探しご条件）\n①【ご入居の時期】⇒"), S(KYOMU)])).toBe(null);
});
it("Aoi/みく型「こちらに〇〇さんご希望のご条件お送り頂きますと…ピックアップさせて頂きます」→ 条件ヒアリング", () => {
  expect(classifyStaffTextForLedger("こちらにAoiさんご希望のご条件お送り頂きますと、Aoiさんのお探しの地域全域からご条件に合ったお部屋ピックアップさせて頂きます！！\nお手隙の際にご入力ください😌！！", null)?.kind ?? null).toBe("condition_asked");
});
it("「上記お部屋探しフォーマットお送り頂けましたら…ピックアップ」→ 条件ヒアリング", () => {
  expect(classifyStaffTextForLedger("上記お部屋探しフォーマットお送り頂けましたら私の方でSawaさんにオススメできるお部屋ピックアップさせていただきます😊！！\n\nお手隙の際にご入力ください😌！！", null)?.kind ?? null).toBe("condition_asked");
});
it("条件が届いた後「ご条件お送り頂きありがとうございます…ピックアップしお送りさせて頂きます」→ ピックアップ宣言のまま", () => {
  const t = "ご条件お送り頂きありがとうございます😊！！\n西中島南方駅周辺全域から、ほのかさんご希望のご条件に合ったお部屋ピックアップしお送りさせて頂きます！！";
  expect(classifyStaffTextForLedger(t, null)?.kind ?? null).toBe("pickup_declared");
  expect(resolveStaffPromiseAix(facts(t), [C("①10月 ②8万 ③1K"), S(t)])?.action ?? null).toBe("property_send");
});
it("申込フォームの「ご入力ください」は条件ヒアリングにしない", () => {
  expect(classifyStaffTextForLedger("かしこまりました！！\nお申込み用のフォーマットお送りさせていただきますので、お手隙のタイミングでご入力ください😊！！", null)?.kind === "condition_asked").toBe(false);
});
// 2026-09-12 竹内（YUYA 事例）: 確認の宣言 → お客様「お願いします！」→ 物件確認した を保つ（実績 26/35＝74%・確認します 0件）
it("YUYA: 確認の宣言の後にお客様が「お願いします！」だけ → AIX 物件確認した のまま", () => {
  const t = "かしこまりました！！\nお送り頂きました物件の募集状況確認させて頂きます😊！！\n確認出来次第ご連絡させて頂きます！！";
  const before = [C("阪急神戸本線 十三 徒歩7分\n1R 4万円\nhttps://myhome.nifty.com/smp/rent/osaka/1/"), C("ここはどうでしょうか？"), S(t)];
  expect(resolveStaffPromiseAix(facts(t), [...before, C("お願いします！")], { ...asked(before), customerAckAfter: true })?.action ?? null).toBe("property_check_result");
});
// 2026-09-12 竹内（Sさん事例）: 確認の宣言 → お客様がスタンプだけ → 物件確認した（旧: スタンプで確認の依頼の判定が外れ 確認します）
it("Sさん: 確認の宣言の後にお客様がスタンプだけ → 宣言より前の依頼で判定し AIX 物件確認した", () => {
  const t = "かしこまりました！！\nお送り頂きました物件、募集状況確認させて頂きます😊！！\n確認出来次第ご連絡させて頂きます！！";
  const before = [C("追加でこちらも空いているか確認お願いしたいです"), C("[画像] スプランディッド本町グラン 1604"), S(t)];
  expect(resolveStaffPromiseAix(facts(t), [...before, C("[スタンプ]")], { ...asked(before), customerAckAfter: true })?.action ?? null).toBe("property_check_result");
  // スタンプを含めた全体で依頼を判定すると外れる（旧の不具合の再現）
  expect(asked([...before, C("[スタンプ]")]).customerRequestedCheck).toBe(false);
});
it("宣言の後にお客様が了承以外（質問・条件）を返した → この規則は使わない", () => {
  const t = "かしこまりました！！\nお送り頂きました物件の募集状況確認させて頂きます😊！！";
  const before = [C("ここ空いてますか？ https://suumo.jp/chintai/bc_1/"), S(t)];
  expect(resolveStaffPromiseAix(facts(t), [...before, C("あと初期費用も知りたいです")], { ...asked(before), customerAckAfter: false })).toBe(null);
});
it("確認結果を報告済み（履行済み）→ AIX なし", () => {
  const msgs = [C("こちら空いてますか？\nhttps://example.com/room/1"), S(S_CONFIRM)];
  expect(resolveStaffPromiseAix(facts(S_CONFIRM, { conf: false }), msgs, asked(msgs))).toBe(null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
