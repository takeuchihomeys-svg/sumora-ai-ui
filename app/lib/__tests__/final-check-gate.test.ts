// app/lib/__tests__/final-check-gate.test.ts — 2026-10-02 最終チェックの要否（実行: npx tsx app/lib/__tests__/final-check-gate.test.ts）
// 下書き・お客様の発言は本番の記録（ai_reply_examples・2026-09）の実物をそのまま使う（名前だけ伏せた）。
import { needsFinalCheck, isAckOnlyCustomerText, isSafeBoilerplateSentence, unsafeDraftSentences, finalCheckGateEnforced } from "../final-check-gate";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };
const run = (draft: string, customerText: string, extra: Record<string, unknown> = {}) => needsFinalCheck({ draft, customerText, ...extra });

console.log("■ skip になる（決まり文句だけ × 了承・お礼だけ）— 実物");
t("はい／何卒（お礼）", run("はい😊！！\n何卒よろしくお願い致します！！", "ありがとうございます😖").run === "skip");
t("名前つきのお気軽に（確認してみます）", run("はい😊！！\n朱莉さん気になる点出てきましたら何時でもお気軽にご連絡ください！！😌", "ありがとうございます！確認してみます！", { customerName: "朱莉" }).run === "skip");
t("名前が分からなくても呼びかけを外して読む", run("はい😊！！\nかぁなさん気になる点等出てきましたらいつでもお気軽にご連絡ください！！", "ありがとうございます💦").run === "skip");
t("竹内さんの例（ごゆっくりご確認ください）", run("はい😊！！\nごゆっくりご確認ください！！", "ありがとうございます！").run === "skip");
t("お客様の言った「明日」の連絡待ちは決まり文句（文の単位）", isSafeBoilerplateSentence("明日のご連絡お待ちしております！！", "承知致しました。\n\n明日また連絡させて頂きます。"));
t("ただしお客様の「明日また連絡させて頂きます」は了承だけではない（迷ったら全部）", run("はい😊！！\n明日のご連絡お待ちしております！！", "承知致しました。\n\n明日また連絡させて頂きます。").run === "full");
t("肌の色つきの絵文字も了承の内", isAckOnlyCustomerText("ありがとうございます🙏🏻"));
t("LINE のスタンプの文字（よろしく）", isAckOnlyCustomerText("わかりました! \nよろしくお願いします(よろしく)"));

console.log("■ full になる（LLM が実際に指摘した下書き・お客様の発言）");
t("日時つきの案内（本日16時・SUBJECT_CONFUSION）", run("まりあさんお世話になっております！！\n本日16時お部屋ご案内させて頂きます！\n本日は何卒よろしくお願い致します！！", "わかりました！").run === "full");
t("決まっていない予定の宣言（DOUBLE_DECLARATION）", run("はい😊！！\n内覧の詳細についてはご連絡させて頂きます！！\n何卒よろしくお願い致します！！", "電車遅延していて少し遅れます。すいません。").run === "full");
t("頼まれていない申込の宣言（MISSED_QUESTION）", run("はい😊！！\nお送り頂いた内容でお申込み進めさせて頂きます！！\n何卒よろしくお願い致します！！", "わかりました！\n現在住んでるところの退去可能時期の確認をしてから日程送ってもいいですか？").run === "full");
t("ご査収（送った物が前提）は決まり文句に入れない", run("はい😊！！\nお手隙の際にご査収ください😌！！", "ありがとうございます").run === "full");
t("日付つきの楽しみに", run("かしこまりました！！\n9/15当日お会いできるの楽しみにしております！！", "わかりました!").run === "full");
t("お客様の言っていない「明日」", run("はい😊！！\n明日何卒よろしくお願い致します！！", "わかりました！").run === "full");
t("決まり文句でもお客様が予定の変更（インフル）", run("とんでもございません😊！！\n何卒よろしくお願い致します！！", "すみません今日病院いったらインフルと診断されて明日の内覧厳しくて💦\n改めて別日にお願いしたいです").run === "full");
t("決まり文句でもお客様が質問", run("はい😊！！\n何卒よろしくお願い致します！！", "いまいけますか？").run === "full");
t("決まり文句でもお客様が画像", run("はい😊！！\n何卒よろしくお願い致します！！", "[画像] ありがとうございます").run === "full");
t("お客様の発言が空（読めない）", run("はい😊！！", "").run === "full");

console.log("■ 必ず全部チェック（安全の決まり）");
const safeD = "はい😊！！\n何卒よろしくお願い致します！！", ack = "ありがとうございます";
t("自動に切り替えた会話", run(safeD, ack, { isAutoSendConversation: true }).reasons.includes("auto_send_conversation"));
t("センシティブ", run(safeD, ack, { isSensitive: true }).run === "full");
t("ブレインの enforcement_level=required", run(safeD, ack, { enforcementRequired: true }).run === "full");
t("初回の返信", run(safeD, ack, { isFirstContact: true }).run === "full");
t("決定論の block", run(safeD, ack, { detBlock: true }).run === "full");
t("申込以降", run(safeD, ack, { postApply: true }).run === "full");
t("会話の記録が読めない", run(safeD, ack, { stateUnknown: true }).run === "full");
t("空の下書き", run("", ack).run === "full");

console.log("■ 部品");
t("数字があれば決まり文句ではない", !isSafeBoilerplateSentence("13：30以降でしたらお電話可能です！！"));
t("宣言は決まり文句ではない", unsafeDraftSentences("かしこまりました！！\n確認出来次第ご連絡させて頂きます！！").length === 1);
t("「は入ります」等で了承と誤読しない（中身が残る）", !isAckOnlyCustomerText("家賃は共益費込みでの値段なのでお願いいたします"));
t("既定は影の運用", finalCheckGateEnforced({}) === false && finalCheckGateEnforced({ FINAL_CHECK_GATE: "on" }) === true && finalCheckGateEnforced({ FINAL_CHECK_GATE: "off" }) === false);

console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
