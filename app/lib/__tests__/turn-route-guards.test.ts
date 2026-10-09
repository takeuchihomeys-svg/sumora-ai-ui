// app/lib/__tests__/turn-route-guards.test.ts — 今の番の中身に合わない AIX を返信に戻す歯止め（実行: npx tsx app/lib/__tests__/turn-route-guards.test.ts）
//   文はブレインの試験（scripts/brain-exam/problems.json・伏せた物）の実物
import { notPickupTurn, viewingInviteToReply, placeMentioned, textWithoutImages, turnRouteGuardsEnabled, onlineViewingAck, estimateToReply, guarantorAsCondition } from "../turn-route-guards";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${info !== undefined ? ` → ${JSON.stringify(info)}` : ""}`); } };
const np = (text: string, o: Partial<{ cct: string; hes: string; fact: boolean; ack: boolean }> = {}) =>
  notPickupTurn({ text, ackOnly: !!o.ack, conditionChangeType: o.cct ?? null, hesitancy: o.hes ?? null, companyFactAsked: !!o.fact });

// 返信の番（物件の AIX・ピックアップの約束にしない）
t("q022 検討します", np("確認していただきありがとうございます！\n検討します！").yes);
t("q023 内覧のキャンセル", np("すみません！\n4日内見予約させてもらっていたのですが、会社の移動先が変わるかもしれなくて一旦キャンセルさせてもらってもいいですか？").yes);
t("q065 最速の入居はいつ", np("ありがとうございます\n最速で入居できるとしていつくらいになりそうですか？").yes);
t("q067 会社の住所", np("住所教えてもらえませんか？", { fact: true }).yes);
// 探す番（今まで通り）
t("q061 選択肢が増えるか（探す側）", !np("1LDKにしたら2人入居は厳しいでしょうか？\nもし可能なら選択肢増えるかな？と思いまして。").yes);
t("q079 白基調の部屋はあんまりないですかね（探す側）", !np("白基調の部屋はあんまりないですかね？💦\n送って下さってる部屋は初期費用はいくらですか？").yes);
t("q062 京橋辺りもですか（地名＝探す側）", !np("なるほどですね。\n京橋辺りもですか？").yes);
t("条件の変更（ブレインの cct）は探す側", !np("もう少し安いところがいいです", { cct: "rent_change" }).yes);
t("お礼・了承だけは触らない", !np("ありがとうございます", { ack: true }).yes);

// 地名
t("神崎川（駅）", placeMentioned("神崎川はすんでましたが\n不便だったので汗") === "神崎川");
t("「大丈夫」等の普通の語は地名にしない", placeMentioned("家賃が安いと嬉しかったですね！") === null);
t("画像の書き起こしは外す", textWithoutImages(["[画像] 動物園前 徒歩3分", "もう少し見てみたいです"]) === "もう少し見てみたいです");

// 内覧調整
// 10/09 竹内さんの答え: 見積書の後の「どっちも気になります」は AIX の番（内覧の語が無いだけで返信に戻さない・VIEWING_GUARD_NO_WORD=on で旧）
t("q053 どっちも気になります → 内覧調整のまま", !viewingInviteToReply({ text: "どっちも気になります", viewingDecided: false }).yes);
t("q085 日程のやり取りの中の「26日の夕方18時頃なら空いてますでしょうか」→ 内覧調整のまま", !viewingInviteToReply({ text: "26日の夕方18時頃なら空いてますでしょうか？", viewingDecided: false }).yes);
t("q087 ここ見てみたいです → 内覧調整のまま", !viewingInviteToReply({ text: "ここ見てみたいです!", viewingDecided: false }).yes);
{ const prev = process.env.VIEWING_GUARD_NO_WORD; process.env.VIEWING_GUARD_NO_WORD = "on";
  t("VIEWING_GUARD_NO_WORD=on で旧（内覧の語が無い→返信）", viewingInviteToReply({ text: "どっちも気になります", viewingDecided: false }).yes);
  if (prev === undefined) delete process.env.VIEWING_GUARD_NO_WORD; else process.env.VIEWING_GUARD_NO_WORD = prev; }
t("q050 決まった内覧で全部見たい", viewingInviteToReply({ text: "全て見に行きたいです！", viewingDecided: true }).yes);
t("q049 18日の内覧のあと行けますか", viewingInviteToReply({ text: "18の南船場の内覧のあと行けますか？", viewingDecided: true }).yes);
t("q072 13日以降", viewingInviteToReply({ text: "内覧したいんですが都合つくのが9月13日以降の予定なんですが、今見てる物件埋まる可能性高いですかね", viewingDecided: false }).yes);
t("q045 内覧お願い＋日曜は空いていますか（内覧調整のまま）", !viewingInviteToReply({ text: "ここ内覧お願いいたします🙇‍♀️\n今週の日曜日等予定空いていますか？", viewingDecided: false }).yes);
t("q044 内覧お願い（内覧調整のまま）", !viewingInviteToReply({ text: "1度301号室の内覧お願いしたいです！", viewingDecided: false }).yes);
t("決まった内覧の日程変更は内覧調整のまま", !viewingInviteToReply({ text: "内覧の日程を変更したいです", viewingDecided: true }).yes);
t("q052 オンライン内覧の日時に「はい！大丈夫です！」→ 返信", onlineViewingAck({ lastStaffTexts: ["かしこまりました😊！！\nオンライン内覧させて頂き\n室内写真と室内動画も併せてお送りさせて頂きます！！","9/7（月）16:00より、YUMAさんご都合如何でしょうか😌！"], customerText: "はい！大丈夫です！", ackOnly: false }));
t("現地の内覧の了承は当てない", !onlineViewingAck({ lastStaffTexts: ["9/7（月）16:00より、ご都合如何でしょうか"], customerText: "はい！大丈夫です！", ackOnly: false }));
t("q055 費用を聞いていない「気になります」は見積の番でない", estimateToReply({ text: "ありがとうございます！\nアーバネックス気になります！", turnHasPropertyMedia: false }).yes);
t("q078 まだ送っていない物件の費用は見積の番でない", estimateToReply({ text: "他にも気になっている物件があるので\nそちらも初期費用教えていただきです", turnHasPropertyMedia: false }).yes);
t("物件の画像つきの費用の質問は見積の番", !estimateToReply({ text: "こちら初期費用いくらですか", turnHasPropertyMedia: true }).yes);
t("q036 保証会社はクレカ系は控えたい＝条件", guarantorAsCondition("わがままを言いますが、保証会社はクレカ系は控えたいです。"));
t("保証会社はどこですか＝条件でない", !guarantorAsCondition("保証会社はどこですか？"));
t("TURN_ROUTE_GUARDS=off", !turnRouteGuardsEnabled({ TURN_ROUTE_GUARDS: "off" }));

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exitCode = 1;
