// app/lib/__tests__/second-message-materials.test.ts
// 実行: npx tsx app/lib/__tests__/second-message-materials.test.ts（自己完結ハーネス・LLM なし。全 PASS で exit 0）
import {
  secondMsgMaterialsOn, splitTurn, sentThisTurn, outstandingAsks, openPromises, confirmAnswersOf, askedCostKind, lastCustomerBundle,
  buildSecondMaterialsNote, fixReceiptWhenNotSent, fixImageTypeWording, fixEstimateNames, costKindMismatch, applySecondFinalChecks,
  hasViewingOrApplyPush, secondMaterialsRoute, buildBrainBundleNote, buildPropertyJudgeNote, type SmMsg,
} from "../second-message-materials";
import { customerReasonSplit } from "../property-brain";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (v: unknown, m = "expected truthy") => { if (!v) throw new Error(m); };

const NOW = Date.parse("2026-10-20T06:00:00Z");
const at = (min: number) => new Date(NOW - min * 60_000).toISOString();
const CARD_A = "🌟メゾンシュシュ 101号室\n【メゾンシュシュ 101号室】\n初期費用：250,000円\n割引させて頂き 50,000円節約出来ます";
const CARD_B = "🌟Belle Court大美野 201号室\n【Belle Court大美野 201号室】\n初期費用：198,000円\n割引させて頂き 40,000円節約出来ます";

console.log("second-message-materials");

it("既定 on（10/22）・off で止まる", () => {
  eq(secondMsgMaterialsOn({}), true);
  eq(secondMsgMaterialsOn({ SECOND_MSG_MATERIALS: "on" }), true);
  eq(secondMsgMaterialsOn({ SECOND_MSG_MATERIALS: "off" }), false);
});

it("この番＝最後のお客様の発言より後・1通目が履歴に無ければ足す", () => {
  const msgs: SmMsg[] = [{ sender: "customer", text: "見積お願いします", rawCreatedAt: at(20) }, { sender: "staff", text: CARD_A, isAix: true, rawCreatedAt: at(5) }];
  const t = splitTurn(msgs, CARD_B);
  eq(t.turnStaff.length, 2);
  eq(t.before.length, 1);
  eq(splitTurn(msgs, CARD_A).turnStaff.length, 1);
});

it("見積書を2回の AIX で送った → 2件・種類は見積書・送った", () => {
  const s = sentThisTurn({ actionType: "estimate_sheet", turnStaff: [CARD_A, CARD_B] });
  eq(s.estimates, ["メゾンシュシュ 101号室", "Belle Court大美野 201号室"]);
  eq(s.kind, "estimate");
  eq(s.anySent, true);
});

it("物件ピックアップ → 物件の資料・確認します（約束だけ）→ 何も送っていない", () => {
  eq(sentThisTurn({ actionType: "property_send", turnStaff: ["物件ピックアップさせて頂きました", "[画像]"] }).kind, "property_images");
  const n = sentThisTurn({ actionType: "acknowledge_check", turnStaff: ["確認させて頂きます！！"] });
  eq(n.kind, "none");
  eq(n.anySent, false);
});

it("q186: 費用と角部屋の空き → 見積書を送っても角部屋（空き）は残る", () => {
  const msgs: SmMsg[] = [
    { sender: "staff", text: "お部屋のご紹介させて頂きました！！", rawCreatedAt: at(120) },
    { sender: "customer", text: "初期費用はいくらになりますか？\n角部屋はもう空いてないですか？", rawCreatedAt: at(30) },
  ];
  const asks = outstandingAsks(msgs, [CARD_B], NOW);
  eq(asks.map((x) => x.topic), ["vacancy"]);
  ok(/角部屋/.test(asks[0].quote));
});

it("q182: 空き状況の確認の約束の後に見積書 → 約束は開いたまま", () => {
  const msgs: SmMsg[] = [
    { sender: "customer", text: "ララプレイス難波シエールの空き状況知りたいです", rawCreatedAt: at(60) },
    { sender: "staff", text: "ララプレイス難波シエールの空き状況確認させて頂きます！！", rawCreatedAt: at(50) },
    { sender: "customer", text: "初期費用等も出していただけるとありがたいです", rawCreatedAt: at(40) },
  ];
  const ps = openPromises(msgs, [CARD_A], NOW);
  eq(ps.map((p) => p.kind), ["確認"]);
});

it("確認の結果の文を取り出す（72時間より前は使わない）", () => {
  const rows = [
    { generated_text: "お送り頂きましたララプレイス難波シエール確認させて頂きました！！\n現在305号室のみ募集中となります！！", created_at: at(10) },
    { generated_text: "現在302号室のみ募集中となります！！", created_at: new Date(NOW - 100 * 3600_000).toISOString() },
  ];
  const a = confirmAnswersOf(rows, { nowMs: NOW });
  eq(a.length, 1);
  ok(/305/.test(a[0]));
});

it("費用の種類（初期費用／月額）", () => {
  eq(askedCostKind(["初期費用はいくらですか"]), "initial");
  eq(askedCostKind(["月々いくらになりますか"]), "monthly");
  eq(askedCostKind(["よろしくお願いします"]), null);
  eq(lastCustomerBundle([{ sender: "staff", text: "a" }, { sender: "customer", text: "b" }, { sender: "customer", text: "c" }]), ["b", "c"]);
});

it("材料の1ブロック: 2件の見積書・質問・約束・確認の結果・NG", () => {
  const msgs: SmMsg[] = [{ sender: "customer", text: "角部屋はもう空いてないですか？", rawCreatedAt: at(30) }];
  const note = buildSecondMaterialsNote({
    sent: sentThisTurn({ actionType: "estimate_sheet", turnStaff: [CARD_A, CARD_B] }),
    asks: outstandingAsks(msgs, [CARD_A], NOW),
    promises: [{ kind: "確認", sentence: "空き状況確認させて頂きます", at: at(50), elapsedH: 1, hasDeadline: false, status: "期限内" }],
    answers: ["現在305号室のみ募集中となります！！"],
    ngPoints: "1階",
    costKind: "initial",
  });
  ok(/御見積書 2件（メゾンシュシュ 101号室・Belle Court大美野 201号室）/.test(note), note);
  ok(/角部屋/.test(note));
  ok(/空き状況確認させて頂きます/.test(note));
  ok(/305号室のみ/.test(note));
  ok(/NG 条件.*1階/.test(note));
  ok(/初期費用/.test(note));
  eq(buildSecondMaterialsNote({ sent: { estimates: [], estimateCards: 0, images: 0, kind: "images", anySent: true }, asks: [], promises: [], answers: [] }), "");
});

it("ご査収は送った時だけ（見てくれたお礼は残す）", () => {
  const t = "確認させて頂きます！！\nお手隙の際にご査収ください😌！！";
  const r = fixReceiptWhenNotSent(t, { anySent: false });
  eq(r.text, "確認させて頂きます！！");
  eq(fixReceiptWhenNotSent(t, { anySent: true }).text, t);
  const thanks = "ご査収頂きありがとうございます😊！！";
  eq(fixReceiptWhenNotSent(thanks, { anySent: false }).text, thanks);
});

it("送った物の種類: 見積書なのに物件資料 → 御見積書／物件の資料なのに御見積書 → 当たりだけ", () => {
  const r = fixImageTypeWording("物件資料・間取り図をお送りさせて頂きました！！", { kind: "estimate", images: 2 });
  eq(r.text, "御見積書をお送りさせて頂きました！！");
  const f = fixImageTypeWording("こちら御見積書となります！！", { kind: "property_images", images: 3 });
  eq(f.text, "こちら御見積書となります！！");
  eq(f.flagged.length, 1);
});

it("レビュー 10/20: お客様が送った物件資料の話は御見積書に直さない・直しは1回きり（2回目は何もしない）", () => {
  const t = "お送り頂きました物件資料確認させて頂きました！！\nこちら御見積書となります！！";
  eq(fixImageTypeWording(t, { kind: "estimate", images: 0 }).text, t);
  eq(fixImageTypeWording("物件資料拝見させて頂きました！！", { kind: "estimate", images: 0 }).applied.length, 0);
  eq(fixImageTypeWording("物件資料をお送りさせて頂きました！！", { kind: "estimate", images: 0 }).text, "御見積書をお送りさせて頂きました！！");
  const sent = sentThisTurn({ actionType: "estimate_sheet", turnStaff: [CARD_A, CARD_B] });
  const once = applySecondFinalChecks("メゾンシュシュ 101号室最大限割引しました物件資料となります！！", { sent, asks: [] });
  eq(applySecondFinalChecks(once.text, { sent, asks: [] }).applied.length, 0);
  // 「部屋のの」だけ詰める（他の「のの」は触らない）
  eq(fixEstimateNames("ののちゃんB荘 202の最大限割引しました", ["A荘 101", "B荘 202", "C荘 303"]).text, "ののちゃん3部屋の最大限割引しました");
});

it("見積書2件 → 1件の名前だけなら2件の名前に（12adf1bd の実物）", () => {
  const t = "TaroさんBelle Court大美野 201号室最大限割引しました初期費用の御見積書となります！！";
  const r = fixEstimateNames(t, ["メゾンシュシュ 101号室", "Belle Court大美野 201号室"]);
  eq(r.text, "Taroさんメゾンシュシュ 101号室・Belle Court大美野 201号室最大限割引しました初期費用の御見積書となります！！");
  // 「2部屋の」「それぞれ」なら触らない／名前なし → 最大限割引の前に足す
  eq(fixEstimateNames("2部屋の最大限割引しました御見積書となります！！", ["A荘 101", "B荘 202"]).applied.length, 0);
  eq(fixEstimateNames("最大限割引しました御見積書となります！！", ["A荘 101", "B荘 202"]).text, "A荘 101・B荘 202の最大限割引しました御見積書となります！！");
  eq(fixEstimateNames("A荘 101最大限割引", ["A荘 101"]).applied.length, 0);
  // 空白の違い（「メゾン シュシュ」と「メゾンシュシュ」）は同じ名前（実送信 10/16 615499ba）
  eq(fixEstimateNames("メゾンシュシュ201号室　Belle Court大美野 201号室最大限割引しました", ["メゾン シュシュ 201号室", "Belle Court大美野 201号室"]).applied.length, 0);
  // 3件以上は「N部屋の」
  eq(fixEstimateNames("Hanakoさんブエナビスタ難波タワー 704号室最大限割引しました初期費用の御見積書となります！！", ["Alivis 602号室", "大阪難波Noah 1006号室", "ブエナビスタ難波タワー 704号室"]).text,
    "Hanakoさん3部屋の最大限割引しました初期費用の御見積書となります！！");
});

it("費用の種類の取り違え・訴求の有無", () => {
  eq(costKindMismatch("月額は65,000円となります！！", "initial"), "初期費用を聞かれたのに月額");
  eq(costKindMismatch("初期費用の御見積書となります！！", "initial"), null);
  eq(hasViewingOrApplyPush("お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！").viewing, true);
  eq(hasViewingOrApplyPush("お気に召されましたらお申込みしお部屋抑えさせて頂きます！！").apply, true);
});

it("出口の確かめをまとめて（ご査収・名前・触れていない質問）", () => {
  const sent = sentThisTurn({ actionType: "estimate_sheet", turnStaff: [CARD_A, CARD_B] });
  const msgs: SmMsg[] = [{ sender: "customer", text: "角部屋はもう空いてないですか？", rawCreatedAt: at(30) }];
  const asks = outstandingAsks(msgs, [CARD_A, CARD_B], NOW);
  const r = applySecondFinalChecks("Belle Court大美野 201号室最大限割引しました初期費用の御見積書となります！！\nお手隙の際にご査収ください😌！！", { sent, asks, firstMessage: CARD_B, costKind: "initial" });
  ok(/メゾンシュシュ 101号室・Belle Court大美野 201号室/.test(r.text));
  ok(/ご査収/.test(r.text));
  ok(r.warnings.some((w) => /角部屋/.test(w)), JSON.stringify(r.warnings));
  const r2 = applySecondFinalChecks("角部屋につきまして201号室現在も募集中となります！！", { sent, asks, firstMessage: CARD_B });
  eq(r2.warnings.filter((w) => /角部屋/.test(w)).length, 0);
});

it("個人情報の線: 申込以降・審査の事情・申込の線・読めない → Claude に固定", () => {
  eq(secondMaterialsRoute({ postApply: true, cutoffAll: true, sensitive: false, goesAlt: true }), "pin");
  eq(secondMaterialsRoute({ postApply: false, cutoffAll: true, sensitive: true, goesAlt: true }), "pin");
  eq(secondMaterialsRoute({ postApply: false, cutoffAll: false, sensitive: false, goesAlt: true }), "pin");
  eq(secondMaterialsRoute({ postApply: false, cutoffAll: true, sensitive: false, readFailed: true, goesAlt: false }), "pin");
  eq(secondMaterialsRoute({ postApply: false, cutoffAll: true, sensitive: false, goesAlt: true }), "alt");
  eq(secondMaterialsRoute({ postApply: false, cutoffAll: true, sensitive: false, goesAlt: false }), "claude");
});

it("質問11: 画面の画像の通（text 空＋imageUrl）も送った物・物件確認した で画像が見えない時はご査収を外さない", () => {
  const msgs: SmMsg[] = [
    { sender: "customer", text: "ここ空いてますか？", rawCreatedAt: at(30) },
    { sender: "staff", text: "現在募集に出ていないお部屋となっております！！", isAix: true, rawCreatedAt: at(3) },
    { sender: "staff", text: "", imageUrl: "https://example.invalid/a.jpg", isAix: true, rawCreatedAt: at(2) },
  ];
  const t = splitTurn(msgs, null);
  eq(t.turnStaff.length, 2);
  const s = sentThisTurn({ actionType: "property_check_result", turnStaff: t.turnStaff });
  eq(s.anySent, true);
  eq(s.kind, "images");
  const none = sentThisTurn({ actionType: "property_check_result", turnStaff: ["現在募集に出ていないお部屋となっております！！"] });
  eq(none.anySent, false);
  eq(none.uncertain, true);
  const txt = "別のお部屋お送りさせて頂きます！！\nお手隙の際にご査収ください！！";
  eq(fixReceiptWhenNotSent(txt, none).text, txt);
  ok(!/何も送っていない番/.test(buildSecondMaterialsNote({ sent: none, asks: [], promises: [], answers: [] })));
});

it("質問11: 室内イメージの URL だけの1通目 → 送った物（ご査収を残す）", () => {
  const s = sentThisTurn({ actionType: "property_check_result", turnStaff: ["（室内イメージ）\nhttps://suumo.jp/chintai/bc_1/"] });
  eq(s.anySent, true);
  const t = "こちら室内イメージとなります😊！！\nお手隙の際にご査収ください！！";
  eq(fixReceiptWhenNotSent(t, s).text, t);
});

it("統括の判断の束: 新しい判断・同じ AIX だけ一手となぜ・この AIX で受ける依頼", () => {
  const msgs = [{ sender: "customer", rawCreatedAt: at(30) }];
  const meta = {
    action: "estimate_sheet", reason: "初期費用を気にしている", after_aix_template: "【申込誘導】", analyzed_msg_ts: at(29),
    turn_contract: { asks: [
      { quote: "見積もりお願いします", route: "aix", aix: "estimate_sheet", answer: "最大限割引した御見積書" },
      { quote: "角部屋は空いてますか", route: "promise", answer: "空き状況を確認" },
      { quote: "駐車場ありますか", route: "aix", aix: "property_check_result/mgmt_parking" },
    ] },
  };
  const n = buildBrainBundleNote(meta, { actionType: "estimate_sheet", messages: msgs, labelOf: (k) => `【${k}】` });
  ok(/統括が選んだ一手: 【estimate_sheet】/.test(n), n);
  ok(/なぜ（統括）: 初期費用/.test(n));
  ok(/見積もりお願いします/.test(n));
  ok(!/角部屋/.test(n), "空きの約束は見積の AIX では受けない（promiseFulfilledBy・物件確認した で受ける）");
  ok(!/駐車場/.test(n));
  ok(/【申込誘導】/.test(n));
  // 古い判断は渡さない
  eq(buildBrainBundleNote({ ...meta, analyzed_msg_ts: at(60) }, { actionType: "estimate_sheet", messages: msgs }), "");
  // 違う AIX を押した番は一手・なぜを渡さない
  const other = buildBrainBundleNote(meta, { actionType: "property_check_result", checkPattern: "mgmt_parking", messages: msgs });
  ok(!/なぜ/.test(other) && /駐車場/.test(other), other);
});

it("物件の判断の中身: 推す理由・合わない所・反応（AD・割引の理由は入れない）", () => {
  const n = buildPropertyJudgeNote({ label: "メゾンシュシュ 101号室", recommended: true, goodJa: ["敷金礼金0", "AD 2ヶ月以上", "駅徒歩5分以内"], badJa: ["家賃が上限の110%超"], reaction: { good: true, attrsJa: [] }, bundleNegativesJa: ["狭い"] });
  ok(/👑/.test(n) && /敷金礼金0/.test(n) && /駅徒歩5分/.test(n) && /110%/.test(n) && /良い反応/.test(n) && /狭い/.test(n), n);
  ok(!/AD/.test(n));
  eq(buildPropertyJudgeNote({ label: "x 1号室", goodJa: [], badJa: [] }), "");
  ok(/見送り/.test(buildPropertyJudgeNote({ label: "x 1号室", goodJa: [], badJa: [], reaction: { declined: true } })));
});

it("判定の理由の分け方（customerReasonSplit）: AD の札は外す", () => {
  const sp = customerReasonSplit(["ZERO_ZERO_MATCH", "AD_HIGH", "RENT_OVER_110", "EQUIP_AUTOLOCK_OK", "ALREADY_SENT_SAME_ROOM"]);
  eq(sp.goodJa.length, 2);
  eq(sp.badJa.length, 1);
  ok(!sp.goodJa.some((x) => /AD|広告/.test(x)));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(" - " + f); process.exit(1); }
