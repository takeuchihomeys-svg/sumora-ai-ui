// 2026-10-13 竹内さん（いしのまさや）: 約束は順序の先頭だけ・後は約束の続き・件数・題だけの物件・2通に分ける。お客様の文は実物（名前を伏せた）
// 実行: npx tsx app/lib/__tests__/promise-sequence.test.ts
import { buildPromiseQueue, nextPromiseAix, numberedPromiseLabels, type QueueMsg } from "../promise-queue";
import { resolveTwoStage, broughtTitleOnly, customerAreaKnown, twoStageOtherQuestions } from "../two-stage";
import { splitDraftBubbles } from "../draft-bubbles";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function has(s: string, sub: string) { if (!s.includes(sub)) throw new Error(`expected ${JSON.stringify(s.slice(0, 300))} to contain ${JSON.stringify(sub)}`); }

// 実物 61219753（10/08・伏せた）: TikTok の画面の画像2件＋お客様の文
const img1 = "[画像] 【物件の画面（SNS・広告）】\nSUMORA 初期費用最安値に 初期費用2,980円 +前家賃だけ!!!\n「北浜」駅徒歩2分 大阪市1LDK";
const img2 = "[画像] 【物件の画面（SNS・広告）】\n21:02 投稿 sumora___\n◎中央区の駅チカ物件 1LDK 43.97㎡";
const text = "お世話になります。\nこちらの物件が気になります。\n※初期費用を安く抑えたいのと、敷金礼金なし（初期費用に含まれる？）を希望します。\n良い物件ありますでしょうか？🙇‍♂️";

it("題だけの物件（SNS・TikTok の画面）を見分ける", () => {
  eq(broughtTitleOnly([img1, img2]), true);
  eq(broughtTitleOnly(["[画像] 【物件の資料】\nウェルスクエア〇〇 308号室"]), false);
  eq(broughtTitleOnly(["https://suumo.jp/chintai/bc_1/", img1]), false);
});
it("いしのまさや: 2件の確認＋御見積書だけ約束・探す依頼は後（条件ヒアリング）・題の駅名で呼ばない・問いを繰り返さない", () => {
  const v = resolveTwoStage({ finalAix: "property_check_result", decisionSource: "llm", pickupReady: false, postApply: false, customerText: text, asksCost: true, ackOnly: false, brought: { ask: "cost", count: 2, titleOnly: true } })!;
  eq(v.source, "rule:two_stage_promise(brought_both)");
  has(v.direction, "2件"); has(v.direction, "物件名・駅名・題の言葉で呼ばず"); has(v.direction, "この返信では約束しない");
  eq(v.extraPromises, undefined); eq(v.laterPromises, ["pickup_hearing"]);
  eq(twoStageOtherQuestions(text, "check"), []);
});
it("エリアが分かる（条件フォーム）＋確認 → 2通目「あわせまして」でピックアップ（b87d85 の形）", () => {
  const t = "①【ご入居の時期】⇒12月\n⑤【ご希望のエリア・駅名】⇒西区・西淀川区\nこちらの物件空いてますか？";
  eq(customerAreaKnown(t), true);
  eq(customerAreaKnown(text), false);
  const v = resolveTwoStage({ finalAix: "property_check_result", decisionSource: "llm", pickupReady: false, postApply: false, customerText: t, ackOnly: false, brought: { ask: "vacancy", count: 1 } })!;
  eq(v.extraPromises, ["pickup"]); has(v.direction, "2通目は「あわせまして」");
});
it("内覧の依頼は後ろ（この返信では約束しない）", () => {
  const v = resolveTwoStage({ finalAix: "property_check_result", decisionSource: "llm", pickupReady: false, postApply: false, customerText: "こちらまだ空いてますか？\n空いていたら内覧したいです", ackOnly: false })!;
  eq(v.laterPromises, ["viewing"]); eq(v.extraPromises, undefined);
});
it("戻す TWO_STAGE_PROMISE_SEQUENCE=off で 10/09 の形（あわせて足す）", () => {
  process.env.TWO_STAGE_PROMISE_SEQUENCE = "off";
  try {
    const v = resolveTwoStage({ finalAix: "property_check_result", decisionSource: "llm", pickupReady: false, postApply: false, customerText: "こちらまだ空いてますか？\n空いていたら内覧したいです\n他にも似たような物件ありますか？", ackOnly: false })!;
    eq(v.extraPromises, ["viewing", "pickup"]); eq(v.laterPromises, undefined);
  } finally { delete process.env.TWO_STAGE_PROMISE_SEQUENCE; }
});
it("約束の続き: 確認を約束した番の探す依頼は後ろ（条件ヒアリング）・番号 1→2・確認を送った後に次になる", () => {
  const m: QueueMsg[] = [
    { sender: "customer", text: img1, createdAt: "2026-10-08T11:59:52.000Z" },
    { sender: "customer", text, createdAt: "2026-10-08T12:00:28.000Z" },
    { sender: "customer", text: img2, createdAt: "2026-10-08T12:02:23.000Z" },
    { sender: "staff", text: "〇〇さん、はじめまして😊！！\nお送り頂きました2件の物件の募集状況確認させて頂きます！！\n確認出来次第、最大限割引させて頂いた初期費用の御見積書とあわせてご連絡させて頂きます！！", createdAt: "2026-10-09T05:51:47.000Z" },
  ];
  const t1 = Date.parse("2026-10-09T05:52:00.000Z");
  const nx = nextPromiseAix(buildPromiseQueue(m, [], t1), { nowMs: t1, need: { noPropertiesSent: true, sentNotFit: false, customerAskedMore: true } })!;
  eq(nx.next.action, "property_check_result"); eq(nx.rest.map((s) => s.action), ["estimate_sheet", "condition_hearing"].filter((a) => nx.rest.some((s) => s.action === a)));
  eq(nx.rest[nx.rest.length - 1].action, "condition_hearing");
  const labels = numberedPromiseLabels(nx.next, nx.rest);
  has(labels[0], "1. 募集状況の確認"); has(labels[labels.length - 1], "ご条件のヒアリング→ピックアップ");
  // 物件確認した（御見積書同封）を送った後 → 次は 条件ヒアリング
  const t2 = Date.parse("2026-10-09T07:46:00.000Z");
  const nx2 = nextPromiseAix(buildPromiseQueue(m, [{ aixType: "property_check_result", sentAt: "2026-10-09T07:45:44.000Z", estimateSent: true, text: "募集中…御見積書同封" }], t2), { nowMs: t2 })!;
  eq(nx2.next.action, "condition_hearing"); eq(nx2.rest.length, 0);
  // 条件ヒアリングを送ったら済み
  const t3 = Date.parse("2026-10-09T09:00:00.000Z");
  eq(nextPromiseAix(buildPromiseQueue(m, [{ aixType: "property_check_result", sentAt: "2026-10-09T07:45:44.000Z", estimateSent: true }, { aixType: "condition_hearing", sentAt: "2026-10-09T08:00:00.000Z" }], t3), { nowMs: t3 }), null);
});
it("2通に分ける: 確認の約束＋「あわせまして…ピックアップ」（b87d85 の実送信をつないだ文）", () => {
  const d = "りおなさん、はじめまして😊！！お送り頂きました物件につきまして、募集状況確認させて頂き、確認出来次第ご連絡させて頂きます！！\n\nあわせまして西区・西淀川区・淀川区周辺全域から、りおなさんご希望のご条件に合ったお部屋もピックアップしてお送りさせて頂きます！！";
  const s2 = splitDraftBubbles(d)!;
  has(s2[0], "募集状況確認"); has(s2[1], "あわせまして"); eq(s2[0].includes("あわせまして"), false);
});
it("分けない: 行の途中の「あわせて」・前に約束が無い", () => {
  eq(splitDraftBubbles("お送り頂きました物件の募集状況確認させて頂きます！！確認出来次第、御見積書とあわせてご連絡させて頂きます！！"), null);
  eq(splitDraftBubbles("ありがとうございます！！\nあわせてお部屋もピックアップしてお送りさせて頂きます！！"), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log("  - " + f); process.exit(1); }
