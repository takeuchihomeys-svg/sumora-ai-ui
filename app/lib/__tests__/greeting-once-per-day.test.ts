// 2026-10-13 竹内さん（ゆーた 969f0162・10/09）「挨拶はお客さん1人につき1日一度で、2度目からは挨拶抜きで LINE を入れること」
//   実物: 12:31 こちら「お世話になっております！！⏎1件新着で…」→ 13:48 お客様「ありがとうございます。拝見させていただきます！」→
//   サーバーの下書き「はい😊！！⏎お手隙の際に…」（挨拶なし・正しい）に、画面が開いた直後の一覧（空）で「ゆーたさんお世話になっております！！」を足していた。
// 実行: npx tsx app/lib/__tests__/greeting-once-per-day.test.ts（全 PASS で exit 0）
import { staffTalkedToday, hasGreetingPhrase, countsAsTalkOrGreeting } from "../daily-greeting";
import { computeAlreadyGreetedToday } from "../greeting";
import { refreshDraftGreetingForNow } from "../time-greeting";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const eq = <T,>(a: T, b: T, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };

// 実物（messages・2026-10-09 UTC）
const YUTA = [
  { sender: "staff", text: "[画像]", rawCreatedAt: "2026-10-09T03:27:35.510Z" },
  { sender: "staff", text: "（室内イメージ）\nhttps://www.homes.co.jp/chintai/room/xxx", rawCreatedAt: "2026-10-09T03:27:35.877Z" },
  { sender: "staff", text: "🌟カシータ神戸元町JP 502号室\n\n以前お申し込みした管理会社、保証会社とは別会社にてカシータ神戸元町JP 502号室が募集に出ました！！", rawCreatedAt: "2026-10-09T03:27:37.919Z" },
  { sender: "staff", text: "🌟アスヴェル神戸元町II 1404\n\n1件新着でゆーたさんにかなりオススメ出来るお部屋が募集に出ました！！", rawCreatedAt: "2026-10-09T03:29:36.418Z" },
  { sender: "staff", text: "お世話になっております！！\n1件新着でゆーたさんにオススメ出来るお部屋が募集に出ました！！\n\n花隈駅徒歩3分・洋8帖の1Kで敷金礼金なし、インターネット使用料不要・独立洗面台も完備しており、ゆーたさんにかなりオススメ出来るお部屋となります！！\nお手隙の際にご査収ください😊！！", rawCreatedAt: "2026-10-09T03:31:13.003Z" },
  { sender: "customer", text: "ありがとうございます。拝見させていただきます！", rawCreatedAt: "2026-10-09T04:48:04.895Z" },
];
const SERVER_DRAFT = "はい😊！！\nお手隙の際にごゆっくりご確認頂けますと幸いです！！\n気になる点出てきましたら、いつでもお気軽にご連絡ください😌！！";
const SHOWN_AT = Date.parse("2026-10-09T09:03:26.428Z"); // JST 18:03

it("ゆーた: DB の今日の送信（12:31 の挨拶）があれば挨拶済み・下書きはそのまま", () => {
  eq(staffTalkedToday(YUTA, SHOWN_AT), true);
  eq(computeAlreadyGreetedToday(YUTA.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.rawCreatedAt })) as never, SHOWN_AT), true);
  eq(refreshDraftGreetingForNow(SERVER_DRAFT, { messages: YUTA, name: "ゆーたさん", now: SHOWN_AT, ensureDaily: true }).text, SERVER_DRAFT);
});
it("ゆーた: 開いた直後の一覧が空でも、足す向きを止めれば（allowAdd=false）挨拶を足さない＝今回の不具合の再現と直り", () => {
  // 旧（allowAdd 既定 true）は空の一覧で足していた＝不具合の再現
  eq(refreshDraftGreetingForNow(SERVER_DRAFT, { messages: [], name: "ゆーたさん", now: SHOWN_AT, ensureDaily: true }).text, `ゆーたさんお世話になっております！！\n${SERVER_DRAFT}`);
  // 画面は手元の一覧では足さない
  eq(refreshDraftGreetingForNow(SERVER_DRAFT, { messages: [], name: "ゆーたさん", now: SHOWN_AT, ensureDaily: true, allowAdd: false }).text, SERVER_DRAFT);
});
it("2回目の挨拶が付いた下書きは今日の送信があれば外す（名前は残す）", () => {
  eq(refreshDraftGreetingForNow(`ゆーたさんお世話になっております！！\n${SERVER_DRAFT}`, { messages: YUTA, name: "ゆーたさん", now: SHOWN_AT, ensureDaily: true, allowAdd: false }).text,
    `ゆーたさんはい😊！！\nお手隙の際にごゆっくりご確認頂けますと幸いです！！\n気になる点出てきましたら、いつでもお気軽にご連絡ください😌！！`);
});
it("その日最初（前日の送信だけ）なら DB 判定で足す（誤って外さない）", () => {
  const nextDay = Date.parse("2026-10-10T03:00:00Z");
  eq(staffTalkedToday(YUTA, nextDay), false);
  eq(refreshDraftGreetingForNow(SERVER_DRAFT, { messages: YUTA, name: "ゆーたさん", now: nextDay, ensureDaily: true, allowAdd: true }).text, `ゆーたさんお世話になっております！！\n${SERVER_DRAFT}`);
});
it("資料文の形（🌟・【）でも挨拶の語を含む通は挨拶済みに数える／挨拶の無いカードは数えない（従来どおり）", () => {
  eq(countsAsTalkOrGreeting("🌟サンライト 202号室\nお世話になっております！！"), true);
  eq(countsAsTalkOrGreeting("🌟サンライト 202号室\n家賃5万円"), false);
  eq(countsAsTalkOrGreeting("【御見積書】\nはじめまして！！"), true);
  process.env.GREETING_ONCE_PER_DAY = "off";
  try { eq(countsAsTalkOrGreeting("🌟サンライト 202号室\nお世話になっております！！"), false); } finally { delete process.env.GREETING_ONCE_PER_DAY; }
});
it("挨拶の語は先頭3行だけ（結びの「今後ともお世話になります」の様な末尾は拾わない）", () => {
  eq(hasGreetingPhrase("ゆーたさんお世話になっております！！\n確認します"), true);
  eq(hasGreetingPhrase("夜分遅くに失礼致します！！\n確認します"), true);
  eq(hasGreetingPhrase("【御見積書】\n①\n②\n③\n今後ともお世話になります"), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(" - " + f); process.exit(1); }
