// app/lib/__tests__/ack-topic-scope.test.ts — 2026-10-07 竹内（uran. 10/05）「どこを読み取る必要があるのか」の実物
//   実行: npx tsx app/lib/__tests__/ack-topic-scope.test.ts
import { resolveAckTopicScope, outOfTopicActs, buildAckTopicNote, isAckOnlyTurn, type ScopeMsg } from "../ack-topic-scope";
import { judgeTurn, JUDGE_VERSION } from "../line-watch-judge";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

// uran. の実物（名前は伏せず実物のまま・個人の値なし）
const uran: ScopeMsg[] = [
  { sender: "staff", created_at: "2026-08-18T08:52:35.589+00:00", text: "かしこまりました！！\n玉造周辺全域でuranさんのご条件に合うお部屋、追加で探させて頂きます😊！！\n\n23日にまとめてご案内出来るよう、ピックアップ出来次第お送りさせて頂きます！！何卒よろしくお願い致します😌！！" },
  { sender: "customer", created_at: "2026-08-23T04:30:32.09+00:00", text: "暑い中ありがとうございました🙇🏼‍♀️" },
  { sender: "staff", created_at: "2026-08-23T04:35:18.326+00:00", text: "こちらこそ本日はお暑い中ご同行頂きありがとうございました😊！！\n\nお友達の方にこちらのLINE追加いただくようご連絡頂けますと幸いです😌！！" },
  { sender: "customer", created_at: "2026-10-05T04:06:33.875+00:00", text: "こんにちは！\n\nあと一人紹介してるので連絡くるかもしれないです🙇🏼‍♀️" },
  { sender: "staff", created_at: "2026-10-05T04:09:35.407+00:00", text: "uran さん\nお世話になっております😊！！\nお友達のご紹介ありがとうございます！！\nご連絡いただけましたら私の方で迅速に対応させて頂きます😌！！" },
  { sender: "customer", created_at: "2026-10-05T04:10:03.424+00:00", text: "よろしくお願いいたします🙇🏼‍♀️" },
];
const draft = "はい😊！！\n引き続きuranさんにオススメできるお部屋を玉造エリア全域からピックアップしてお送りさせて頂きます！！";

const s = resolveAckTopicScope(uran);
t("uran: お礼だけ（ZWJ の絵文字 🙇🏼‍♀️ つき）と読む", isAckOnlyTurn("よろしくお願いいたします🙇🏼‍♀️"));
t("uran: 範囲が決まる", s.applies);
t("uran: 範囲＝こちらの直前の返事（友達の紹介のお礼）", s.staffText.includes("お友達のご紹介ありがとうございます"));
t("uran: 範囲＝その返事が答えたお客様の発言（紹介の連絡）", s.topicText.includes("あと一人紹介してる"));
t("uran: 範囲の前は43日空いている", s.gapDaysBefore !== null && s.gapDaysBefore >= 42 && s.gapDaysBefore <= 43);
t("uran: 範囲は閉じていて物件の話でもない", s.closedNonPropertyTopic && !s.topicOpen && !s.propertyTopic && !s.searchTopic);
t("uran: 下書きの「お部屋を探す宣言」は範囲の外", outOfTopicActs(draft, s).includes("pickup_promise"));
t("uran: 受けだけの下書きは範囲の中", outOfTopicActs("はい😊！！\n何卒よろしくお願い致します！！", s).length === 0);
t("uran: 生成の材料に範囲の1行が出る（本文は引用しない）", (() => { const n = buildAckTopicNote(s); return n.includes("読むべき範囲") && n.includes("43日前") && !n.includes("お友達のご紹介ありがとうございます"); })());

// 範囲がお部屋探しの話なら口を出さない（実送信: 送付の後のお礼に「引き続き新着で」を足すのはスタッフの形）
const search: ScopeMsg[] = [
  { sender: "customer", created_at: "2026-08-30T01:00:00Z", text: "ありがとうございます" },
  { sender: "staff", created_at: "2026-08-30T01:05:00Z", text: "はい😊！！\nあんしん+住道矢田08のお部屋、気になる点等出てきましたらいつでもお気軽にご連絡ください！！" },
  { sender: "customer", created_at: "2026-08-30T01:10:00Z", text: "ありがとうございます" },
];
const s2 = resolveAckTopicScope(search);
t("お部屋の話の範囲（物件名つきの締め）→ 外の行為を数えない", s2.applies && !s2.closedNonPropertyTopic && outOfTopicActs("はい😊！！\n引き続き新着で募集に出次第お送りさせて頂きます！！", s2).length === 0);
t("お部屋の話の範囲 → 生成の材料は出さない", buildAckTopicNote(s2) === "");

// 約束が残る範囲（撮影出来次第お送り）は約束の受けの番＝この関数は口を出さない
const open: ScopeMsg[] = [
  { sender: "customer", created_at: "2026-07-22T01:00:00Z", text: "お手数お掛けしますがよろしくお願いいたします" },
  { sender: "staff", created_at: "2026-07-22T01:05:00Z", text: "はい！！\n撮影出来次第すぐにお送りさせて頂きますので何卒よろしくお願い致します😊！！" },
  { sender: "customer", created_at: "2026-07-22T01:06:00Z", text: "よろしくお願いいたします🙇‍♀️" },
];
t("約束が残る（撮影出来次第お送り）→ 閉じた範囲ではない", !resolveAckTopicScope(open).closedNonPropertyTopic);

// お客様に中身がある・最後がこちら → 範囲を決めない
t("お客様が質問 → 当てない", !resolveAckTopicScope([...uran.slice(0, 5), { sender: "customer", created_at: "2026-10-05T04:10:03Z", text: "ちなみに新着ありますか？" }]).applies);
t("最後がこちら → 当てない", !resolveAckTopicScope(uran.slice(0, 5)).applies);
t("こちらの返事が72時間より前 → 当てない", !resolveAckTopicScope([uran[4], { sender: "customer", created_at: "2026-10-09T04:10:03Z", text: "よろしくお願いいたします" }]).applies);
t("お礼の語: 了解です🙏🏻・承知致しました。は読む／『よろしくお願いします、内覧いつですか』は読まない",
  isAckOnlyTurn("了解です🙏🏻") && isAckOnlyTurn("承知致しました。") && !isAckOnlyTurn("よろしくお願いします、内覧いつですか"));

// 見張り: スタッフが返さなかった番で AI が範囲の外の行為を書いた → different（旧は na で数えなかった）
const closedWindow = { closed: true, texts: [], presses: [], aixMessages: 0, aixMessagesBurst: 0 };
const j1 = judgeTurn({ draft: "__SHOWN__", brainReplyMode: "auto_reply", convStatus: "property_recommendation", hasBrain: true, window: closedWindow, outOfTopicActs: ["pickup_promise"] });
t(`見張り(${JUDGE_VERSION}): uran の番は different・no_staff_out_of_topic`, j1.verdict === "different" && j1.detail.reason === "no_staff_out_of_topic" && (j1.detail.out_of_topic_acts ?? []).includes("pickup_promise"));
const j2 = judgeTurn({ draft: "はい😊！！", brainReplyMode: "auto_reply", convStatus: "property_recommendation", hasBrain: true, window: closedWindow, outOfTopicActs: [] });
t("見張り: 範囲の外が無ければ従来どおり na・no_staff", j2.verdict === "na" && j2.detail.reason === "no_staff");

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
