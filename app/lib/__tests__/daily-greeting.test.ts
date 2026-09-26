// 「お世話になっております」は1日1回（2026-09-22 竹内「今日初めてのLINEだったらつける／今日初めてじゃないときは使わない」）
// 実行: npx tsx app/lib/__tests__/daily-greeting.test.ts（全 PASS で exit 0）
import { sentByStaffToday, applyDailyGreeting, staffTalkedToday, isMaterialOnlyText } from "../daily-greeting";
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


// ── テンプレート最適化（AIX→テンプレ）: 今日こちらが「会話文」を送ったか（資料文・画像は数えない）──
// 2026-09-26 竹内「AIX からテンプレートの場合は挨拶入れない等の関係性」。実物は template_selection_logs（名前は YUMA に置換）
const AIX_BODY = "YUMAさんお世話になっております！！\n西九条駅から徒歩圏内でご希望に合うお部屋ピックアップさせて頂きました😊！！";
const ROOM_URL = "（室内イメージ）\nhttps://www.homes.co.jp/chintai/room/xxxx/";
const CARD = "🌟レジュールアッシュ福島フィーノ 606号室\n新築・敷金礼金なし";
const EST = "【8月10日ご入居】の場合の\n初期費用御見積書となります";
it("資料文（画像・室内イメージ URL・🌟物件カード・【】見積の本体）は会話文に数えない", () => {
  for (const t of ["[画像]", "[動画]", ROOM_URL, CARD, EST, "", "  "]) expect(isMaterialOnlyText(t)).toBe(true);
  for (const t of [AIX_BODY, "こちらお申込に必要なご情報となります😊！！", "かしこまりました！！"]) expect(isMaterialOnlyText(t)).toBe(false);
});
it("反証レビュー: 複数物件の見積の本体（①【物件名】）・スタンプ・ファイル・通話リクエストも資料／番号付きの会話文は会話文のまま", () => {
  for (const t of ["①【ビーハイツ北野 202号室】\n\n初期費用さらに\n🌟27,500円割引させて頂きます", "[スタンプ]", "[ファイル]", "[通話リクエスト] 電話をかけるボタン"]) expect(isMaterialOnlyText(t)).toBe(true);
  for (const t of ["1部屋のみの募集となりますので、お部屋埋まってしまう前に", "①ご入居時期\n②ご希望家賃（管理費込み）", "10月末退去予定で1件オススメ出来るお部屋が募集に出ました😊！！"]) expect(isMaterialOnlyText(t)).toBe(false);
  // スタンプだけ送った日は「会話文なし」（出口で挨拶を消さない側に倒す）
  expect(staffTalkedToday([{ sender: "staff", text: "[スタンプ]", createdAt: "2026-09-22T00:13:00Z" }], NOW)).toBe(false);
});
it("今日送ったのが資料文だけ → 会話文なし（スタッフは次の文に挨拶を残す 37/38）", () => {
  const msgs = [
    { sender: "staff", text: "[画像]", createdAt: "2026-09-22T00:13:00Z" },
    { sender: "staff", text: ROOM_URL, createdAt: "2026-09-22T00:13:10Z" },
    { sender: "staff", text: CARD, createdAt: "2026-09-22T00:13:20Z" },
    { sender: "customer", text: "ありがとうございます", createdAt: "2026-09-22T00:20:00Z" },
  ];
  expect(staffTalkedToday(msgs, NOW)).toBe(false);
  expect(sentByStaffToday(msgs, NOW)).toBe(true); // 画面の判定（画像も数える）とはここで割れる＝テンプレ最適化では使わない
});
it("今日 AIX の本文（会話文）を送った後 → 会話文あり／昨日の会話文・時刻の無い通・お客様の発言は数えない", () => {
  expect(staffTalkedToday([{ sender: "staff", text: AIX_BODY, createdAt: "2026-09-22T00:46:00Z" }, { sender: "staff", text: CARD, createdAt: "2026-09-22T00:49:00Z" }], NOW)).toBe(true);
  expect(staffTalkedToday([{ sender: "staff", text: AIX_BODY, createdAt: "2026-09-21T14:59:00Z" }], NOW)).toBe(false); // 9/21 23:59 JST
  expect(staffTalkedToday([{ sender: "staff", text: AIX_BODY }], NOW)).toBe(false);
  expect(staffTalkedToday([{ sender: "customer", text: "よろしくお願いします", createdAt: "2026-09-22T01:00:00Z" }], NOW)).toBe(false);
});
it("出口: 会話文を送った後の最適化文の冒頭の挨拶を消し、名前の行と本文は残す（実物・スタッフは6件とも消した）", () => {
  const adapted = "YUMAさんお世話になっております！！\nお送りさせて頂きましたお部屋の中でも特にレジュールアッシュ福島フィーノ606号室が、西九条徒歩6分・角部屋で独立洗面台付き・家賃管理費込74,000円と、YUMAさんにかなりオススメ出来るお部屋となります😊！！";
  const r = applyDailyGreeting(adapted, { staffSentToday: true, greetingPhrase: "", name: "" });
  expect(r.action).toBe("removed");
  expect(r.text.startsWith("YUMAさん\nお送りさせて頂きましたお部屋の中でも特に")).toBe(true);
  const r2 = applyDailyGreeting("お世話になっております！！\n1件新着でかなりオススメ出来るお部屋が募集に出ました！！", { staffSentToday: true, greetingPhrase: "", name: "" });
  expect(r2.text).toBe("1件新着でかなりオススメ出来るお部屋が募集に出ました！！");
});
it("出口: 挨拶の無い最適化文・3行目以降の「お世話になっております」は触らない", () => {
  const t = "こちらお申込に必要なご情報となります😊！！\n上記フォーマットご入力いただき、ご本人確認書類として運転免許証またはマイナンバーカードの裏表の写真をお送りください！！";
  expect(applyDailyGreeting(t, { staffSentToday: true, greetingPhrase: "", name: "" }).action).toBe("none");
  const t2 = "かしこまりました！！\n管理会社に確認させて頂きます！！\n引き続きお世話になっております管理会社様にもお伝えいたします！！";
  expect(applyDailyGreeting(t2, { staffSentToday: true, greetingPhrase: "", name: "" }).action).toBe("none");
});
it("入口: 資料文だけの日はテンプレの挨拶を残す・会話文の後は消す（applyGreetingSwap に同じ値を渡す）", () => {
  const tmpl = "お世話になっております！！\nアカウント名にかなりオススメ出来るお部屋が募集に出ました！！";
  expect(applyGreetingSwap(tmpl, staffTalkedToday([{ sender: "staff", text: CARD, createdAt: "2026-09-22T00:13:20Z" }], NOW)).startsWith("お世話になっております！！")).toBe(true);
  expect(applyGreetingSwap(tmpl, staffTalkedToday([{ sender: "staff", text: AIX_BODY, createdAt: "2026-09-22T00:46:00Z" }], NOW)).includes("お世話")).toBe(false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
