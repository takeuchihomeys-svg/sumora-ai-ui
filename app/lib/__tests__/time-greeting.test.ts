// 時刻の挨拶を返信に書かない・下書きの挨拶を送る今に合わせる（2026-10-08 竹内さん・り 8f705d16）
// 実行: npx tsx app/lib/__tests__/time-greeting.test.ts（全 PASS で exit 0）
import { findHeadTimeGreeting, stripHeadTimeGreeting, replaceHeadTimeGreeting, refreshDraftGreetingForNow } from "../time-greeting";
import { resolveGreeting, enforceOpening, buildGreetingNote } from "../greeting";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(sub: string) { if (!String(actual).includes(sub)) throw new Error(`expected to contain ${JSON.stringify(sub)} in ${JSON.stringify(actual)}`); },
    notToContain(sub: string) { if (String(actual).includes(sub)) throw new Error(`expected NOT to contain ${JSON.stringify(sub)} in ${JSON.stringify(actual)}`); },
  };
}

// 実物（10/08 12:29 にそのまま送られた下書き＝10/08 11:07 JST に作り直した物）
const REAL_DRAFT = "こんばんは！\n\nサンライト阿倍野8の202号室、お子様不可か確認させて頂きます！！確認出来次第ご連絡させて頂きます！！";
const REAL_DRAFT_FIRST = "こんばんは！\nサンライト阿倍野8の202号室の子ども入居可否について確認させて頂きます！！\n確認出来次第ご連絡させて頂きます😊！！";
const CUSTOMER_MSG = "こんばんは！\n\nサンライト阿倍野8\nの202は\n子ども不可ですか？";
// 会話（10/06 21:48 竹内さんの送信 → 10/07 20:40 お客様）
const HISTORY = [
  { sender: "staff", text: "[画像]", createdAt: "2026-10-06T12:48:39Z", rawCreatedAt: "2026-10-06T12:48:39Z" },
  { sender: "staff", text: "🟢気になるお部屋の初期費用がスモ割最大適用【2,980円＋前家賃】だけに✨", createdAt: "2026-10-06T12:48:40Z", rawCreatedAt: "2026-10-06T12:48:40Z" },
  { sender: "customer", text: CUSTOMER_MSG, createdAt: "2026-10-07T11:40:58Z", rawCreatedAt: "2026-10-07T11:40:58Z" },
];
const NOW_1107 = Date.parse("2026-10-08T02:07:53Z"); // 10/08 11:07 JST

it("先頭の時刻の挨拶を見つける（呼びかけの前後・絵文字・空行）", () => {
  expect(findHeadTimeGreeting(REAL_DRAFT)?.rest).toBe("");
  expect(findHeadTimeGreeting("こんにちは😊！！\nお友達のご紹介ありがとうございます！！")?.rest).toBe("");
  expect(findHeadTimeGreeting("ゆうきさん、こんにちは😊\n\nオーナー審査の進捗")?.call).toBe("ゆうきさん");
  expect(findHeadTimeGreeting("おはようございます、ちあきさん！\nこちらこそ")?.call).toBe("ちあきさん");
  expect(findHeadTimeGreeting("きむらさんおはようございます！！\nご連絡ありがとうございます😊！！")?.call).toBe("きむらさん");
});

it("挨拶でない書き出しは拾わない（文の一部・本文の途中）", () => {
  expect(findHeadTimeGreeting("今晩はご都合いかがでしょうか？")).toBe(null);
  expect(findHeadTimeGreeting("おはようの時間帯でも大丈夫です！！")).toBe(null);
  expect(findHeadTimeGreeting("りさんお世話になっております！！\nこんばんは")).toBe(null);
  expect(findHeadTimeGreeting("かしこまりました！！\n本日こんにちは")).toBe(null);
});

it("剥がす: 実物は本文だけが残る", () => {
  expect(stripHeadTimeGreeting(REAL_DRAFT).text).toBe("サンライト阿倍野8の202号室、お子様不可か確認させて頂きます！！確認出来次第ご連絡させて頂きます！！");
  expect(stripHeadTimeGreeting("こんばんは、サンライト阿倍野8の202号室確認させて頂きます！！").text).toBe("サンライト阿倍野8の202号室確認させて頂きます！！");
});

it("置き換える: 竹内さんの形「〇〇さんお世話になっております！！」（呼びかけは元の物・無ければ name）", () => {
  expect(replaceHeadTimeGreeting(REAL_DRAFT, "りさん").text).toBe("りさんお世話になっております！！\nサンライト阿倍野8の202号室、お子様不可か確認させて頂きます！！確認出来次第ご連絡させて頂きます！！");
  expect(replaceHeadTimeGreeting("きむらさんおはようございます！！\nご連絡ありがとうございます😊！！").text).toBe("きむらさんお世話になっております！！\nご連絡ありがとうございます😊！！");
  expect(replaceHeadTimeGreeting("お世話になっております！！\n本文").replaced).toBe(false);
  // 次の行に既にお世話になっております → 重ねない（2026-05-21 の下書きの実物）
  expect(replaceHeadTimeGreeting("おはようございます、ちあきさん！\nこちらこそ、いつもお世話になっております😊\n\n本日は21日11時でのご内覧ですね✨").text)
    .toBe("こちらこそ、いつもお世話になっております😊\n\n本日は21日11時でのご内覧ですね✨");
});

it("生成の出口: 今日まだ送っていない（standard）→ こんばんは が「〇〇さんお世話になっております！！」に差し替わる", () => {
  const prev = process.env.TIME_GREETING_R11; delete process.env.TIME_GREETING_R11;
  // 「り」（1字）は呼び名の検査（canonOf）で名前にしない＝実物は「お世話になっております！！」（竹内さんのこの会話の 9/11 の送信も名前なし）
  const gdRi = resolveGreeting({ customerName: "り", isFirstEverReply: false, alreadyGreetedToday: false, recentMessages: HISTORY, jstHour: 11, now: NOW_1107,
    isSubstantive: () => true, customerKind: "question", substanceKinds: [] });
  expect(enforceOpening(REAL_DRAFT, gdRi).cleaned).toBe("お世話になっております！！\nサンライト阿倍野8の202号室、お子様不可か確認させて頂きます！！確認出来次第ご連絡させて頂きます！！");
  const gd = resolveGreeting({ customerName: "りさ", isFirstEverReply: false, alreadyGreetedToday: false, recentMessages: HISTORY, jstHour: 11, now: NOW_1107,
    isSubstantive: () => true, customerKind: "question", substanceKinds: [] });
  expect(gd.kind).toBe("standard");
  for (const d of [REAL_DRAFT, REAL_DRAFT_FIRST]) {
    const out = enforceOpening(d, gd).cleaned;
    expect(out.split("\n")[0]).toBe("りささんお世話になっております！！");
    expect(out).notToContain("こんばんは");
  }
  process.env.TIME_GREETING_R11 = prev;
});

it("生成の出口: 今日すでに送った（none）→ 時刻の挨拶を外して本題から", () => {
  const gd = resolveGreeting({ customerName: "り", isFirstEverReply: false, alreadyGreetedToday: true, recentMessages: HISTORY, jstHour: 11, now: NOW_1107,
    isSubstantive: () => true, customerKind: "question", substanceKinds: [] });
  const out = enforceOpening(REAL_DRAFT, gd).cleaned;
  expect(out.startsWith("サンライト阿倍野8の202号室")).toBe(true);
});

it("生成の出口: TIME_GREETING_R11=off なら旧（触らない）", () => {
  process.env.TIME_GREETING_R11 = "off";
  const gd = resolveGreeting({ customerName: "り", isFirstEverReply: false, alreadyGreetedToday: false, recentMessages: HISTORY, jstHour: 11, now: NOW_1107,
    isSubstantive: () => true, customerKind: "question", substanceKinds: [] });
  expect(enforceOpening(REAL_DRAFT, gd).cleaned).toBe(REAL_DRAFT);
  delete process.env.TIME_GREETING_R11;
});

it("生成の入口: 注記に時刻の挨拶を書かない線がある", () => {
  const gd = resolveGreeting({ customerName: "り", isFirstEverReply: false, alreadyGreetedToday: false, recentMessages: HISTORY, jstHour: 11, now: NOW_1107,
    isSubstantive: () => true, customerKind: "question", substanceKinds: [] });
  expect(buildGreetingNote(gd, 11)).toContain("「こんばんは」「こんにちは」「おはようございます」の時刻の挨拶は書かない");
});

it("画面: 翌日に開いた下書き（今日まだ送っていない）→ こんばんは を お世話になっております に", () => {
  const r = refreshDraftGreetingForNow(REAL_DRAFT, { messages: HISTORY, name: "りさん", now: Date.parse("2026-10-08T03:29:00Z") });
  expect(r.text.split("\n")[0]).toBe("りさんお世話になっております！！");
});

it("画面: 今日すでに会話文を送った後に開いた下書き → 時刻の挨拶は外す・お世話になっておりますは触らない（監査で誤削除 32/122）", () => {
  const today = [...HISTORY, { sender: "staff", text: "かしこまりました！！確認させて頂きます！！", createdAt: "2026-10-08T01:00:00Z", rawCreatedAt: "2026-10-08T01:00:00Z" }];
  const now = Date.parse("2026-10-08T03:29:00Z");
  expect(refreshDraftGreetingForNow(REAL_DRAFT, { messages: today, name: "りさん", now }).text.startsWith("サンライト阿倍野8")).toBe(true);
  const osewa = "りさんお世話になっております！！\nサンライト阿倍野8の202号室確認させて頂きます！！";
  expect(refreshDraftGreetingForNow(osewa, { messages: today, name: "りさん", now }).text).toBe(osewa);
});

it("画面: 今日送ったのが資料文（🌟カード・画像）だけなら挨拶は残す・挨拶の無い下書きに足さない", () => {
  const mat = [...HISTORY, { sender: "staff", text: "🌟サンライト阿倍野8 202号室", createdAt: "2026-10-08T01:00:00Z", rawCreatedAt: "2026-10-08T01:00:00Z" }];
  const now = Date.parse("2026-10-08T03:29:00Z");
  const osewa = "りさんお世話になっております！！\n本文です！！";
  expect(refreshDraftGreetingForNow(osewa, { messages: mat, name: "りさん", now }).text).toBe(osewa);
  expect(refreshDraftGreetingForNow("本文です！！", { messages: HISTORY, name: "りさん", now }).text).toBe("本文です！！");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
