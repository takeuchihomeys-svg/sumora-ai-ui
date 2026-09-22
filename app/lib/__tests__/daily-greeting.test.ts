// 「お世話になっております」は1日1回（2026-09-22 竹内「今日初めてのLINEだったらつける／今日初めてじゃないときは使わない」）
// 実行: npx tsx app/lib/__tests__/daily-greeting.test.ts（全 PASS で exit 0）
import { sentByStaffToday, applyDailyGreeting } from "../daily-greeting";
import { selectGreeting, applyGreetingSwap } from "../template-preprocess";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}
// 2026-09-22 12:00 JST = 03:00Z
const NOW = Date.parse("2026-09-22T03:00:00Z");

// ── 今日こちらが送ったか（日本時間の暦）──
it("今日（JST）こちらが送っていれば true・昨日の23:59（JST）だけなら false", () => {
  expect(sentByStaffToday([{ sender: "staff", rawCreatedAt: "2026-09-21T23:30:00Z" }], NOW)).toBe(true);   // 9/22 08:30 JST
  expect(sentByStaffToday([{ sender: "staff", rawCreatedAt: "2026-09-21T14:59:00Z" }], NOW)).toBe(false);  // 9/21 23:59 JST
});
it("AIX の送信も画像も数える（旧: 画面の判定が AIX を数えず、今日のやり取りが AIX だけだと毎回付いた）", () => {
  expect(sentByStaffToday([{ sender: "staff", createdAt: "2026-09-22T01:00:00Z" }], NOW)).toBe(true);
});
it("お客様の発言だけ・時刻の無いこちらの通は数えない", () => {
  expect(sentByStaffToday([{ sender: "customer", rawCreatedAt: "2026-09-22T01:00:00Z" }, { sender: "staff" }], NOW)).toBe(false);
});

// ── 今日すでに送った → 消す（実物: 08:35 手打ち → 08:36 AIX）──
it("実物「〇〇さんお世話になっております！！／お送り頂きました物件3件につきまして…」→ 名前の行を残して挨拶だけ消す", () => {
  const r = applyDailyGreeting("YUMAさんお世話になっております！！\nお送り頂きました物件3件につきまして募集状況確認させて頂きましたところ", { staffSentToday: true, greetingPhrase: "お世話になっております！！", name: "YUMAさん" });
  expect(r.action).toBe("removed");
  expect(r.text).toBe("YUMAさん\nお送り頂きました物件3件につきまして募集状況確認させて頂きましたところ");
});
it("名前だけの行の次の行にある挨拶も消す（「〇〇さん／お世話になっております！！」）", () => {
  const r = applyDailyGreeting("YUMAさん\nお世話になっております！！\n新着でオススメできるお部屋が2件募集に出ました😊！！", { staffSentToday: true, greetingPhrase: "", name: "YUMAさん" });
  expect(r.text).toBe("YUMAさん\n新着でオススメできるお部屋が2件募集に出ました😊！！");
});
it("夜分遅くに失礼致します も今日2通目以降は消す", () => {
  const r = applyDailyGreeting("YUMAさん夜分遅くに失礼致します！！\n御見積書同封させて頂きました！！", { staffSentToday: true, greetingPhrase: "", name: "YUMAさん" });
  expect(r.text).toBe("YUMAさん\n御見積書同封させて頂きました！！");
});
it("本文の途中の「お世話になっております」（3行目以降）は触らない", () => {
  const t = "YUMAさん\n本日はありがとうございました！！\n管理会社様にはお世話になっております旨お伝えしました";
  expect(applyDailyGreeting(t, { staffSentToday: true, greetingPhrase: "", name: "YUMAさん" }).text).toBe(t);
});

it("挨拶の直後にまた名前が続く1行（全件監査の実物）→ 名前を重ねない", () => {
  const r = applyDailyGreeting("YUMAさんお世話になっております！！YUMAさんにオススメ出来る物件が募集にでましたのでご連絡させていただきました😊！！", { staffSentToday: true, greetingPhrase: "", name: "YUMAさん" });
  expect(r.text).toBe("YUMAさんにオススメ出来る物件が募集にでましたのでご連絡させていただきました😊！！");
});
// ── 今日はじめて → 付ける ──
it("1行目が名前だけ → その行に挨拶をつなぐ", () => {
  const r = applyDailyGreeting("YUMAさん\n新着で天王寺周辺からピックアップさせて頂きました！！\nお手隙の際にご査収ください😌！！", { staffSentToday: false, greetingPhrase: "お世話になっております！！", name: "YUMAさん" });
  expect(r.action).toBe("added");
  expect(r.text).toBe("YUMAさんお世話になっております！！\n新着で天王寺周辺からピックアップさせて頂きました！！\nお手隙の際にご査収ください😌！！");
});
it("本題から始まっている → 先頭に「〇〇さんお世話になっております！！」", () => {
  const r = applyDailyGreeting("新着で天王寺周辺からピックアップさせて頂きました！！", { staffSentToday: false, greetingPhrase: "お世話になっております！！", name: "YUMAさん" });
  expect(r.text).toBe("YUMAさんお世話になっております！！\n新着で天王寺周辺からピックアップさせて頂きました！！");
});
it("名前の直後が助詞の本文（「YUMAさんにオススメ」）は崩さず、挨拶の行を前に足す／「YUMAさん、新着で」は名前の後ろに挨拶を挟む", () => {
  const r = applyDailyGreeting("YUMAさんにオススメできるお部屋ピックアップさせて頂きました！！", { staffSentToday: false, greetingPhrase: "お世話になっております！！", name: "YUMAさん" });
  expect(r.text).toBe("YUMAさんお世話になっております！！\nYUMAさんにオススメできるお部屋ピックアップさせて頂きました！！");
  const s = applyDailyGreeting("YUMAさん、新着で2件募集に出ました😊！！", { staffSentToday: false, greetingPhrase: "お世話になっております！！", name: "YUMAさん" });
  expect(s.text).toBe("YUMAさんお世話になっております！！\n新着で2件募集に出ました😊！！");
});
it("既に挨拶・お待たせ致しました・夜分がある時は足さない（どちらか一方＝以前の方針）", () => {
  for (const t of ["YUMAさんお世話になっております！！\n本文です！！", "YUMAさんお待たせ致しました！！\n本文です！！", "YUMAさん夜分遅くに失礼致します！！\n本文です！！", "YUMAさん、はじめまして😊！！"]) {
    expect(applyDailyGreeting(t, { staffSentToday: false, greetingPhrase: "お世話になっております！！", name: "YUMAさん" }).action).toBe("none");
  }
});
it("物件カード・御見積書の金額の通（【】・🌟）には付けない", () => {
  for (const t of ["【ハイツ秋桜 8号室】\n初期費用さらに\n🌟30,000円割引", "🌟グランパシフィック桜川南 902 新着でかなり条件のいいお部屋となります！！"]) {
    expect(applyDailyGreeting(t, { staffSentToday: false, greetingPhrase: "お世話になっております！！", name: "YUMAさん" }).action).toBe("none");
  }
});
it("付けない場面（greetingPhrase が空）では何もしない", () => {
  expect(applyDailyGreeting("代理契約可能となります😊！！", { staffSentToday: false, greetingPhrase: "", name: "YUMAさん" }).action).toBe("none");
});

// ── テンプレートの挨拶 ──
it("テンプレート: 2通目以降は夜でも挨拶なし（旧: 21時以降は夜分遅くにを付けていた）", () => {
  expect(selectGreeting(true, 22)).toBe("");
  expect(selectGreeting(false, 22)).toBe("お世話になっております！！");
  expect(applyGreetingSwap("お世話になっております！！\n本文", true).includes("お世話")).toBe(false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
