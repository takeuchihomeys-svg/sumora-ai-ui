// やり取りのスクショの話し手（2026-11-21 作業員G・台帳 #468）。実物は名前・番号を伏せて写した
// 実行: npx tsx app/lib/__tests__/chat-screenshot-speaker.test.ts
import { imageUnitLabel, isChatScreenshotUnit, questionsInScreenshot, readScreenshotSpeaker, screenshotSpeakerNoteOn, screenshotSpeakerTag } from "../chat-screenshot-speaker";
import { IMAGE_TEXT_LABEL, isImageTextUnit } from "../reply-context";

let failed = 0;
function ok(name: string, cond: boolean) { if (!cond) { failed++; console.log("  ✗", name); } else console.log("  ✓", name); }

const H = "[画像] 【物件以外：やり取りのスクショ】\n";
// a8dd6ec6 11/20（番 16493）: 申込先の他社からの返信。中の問いは他社→お客様
const CANCEL = H + "お世話になっております。\n\nキャンセルの件かしこまりました。\n入居時期も含めて遅らせる形になりますでしょうか？\n\nその他で懸念点がございましたらご協力できる範囲で\nお力になれればと思いますので何でもおっしゃってください！";
// 今の住まいの管理会社 → お客様（解約）
const KAIYAKU = H + "〇〇様\nお世話になっております。\nご返信ありがとうございます。\n解約月が月割ではなく月割の契約となっておりますので、「12月末解約」となり、12月分の賃料等が全額必要となりますが宜しいでしょうか。";
// 管理会社のお知らせ（入居後）
const NOTICE = H + "【ポストダイアルのお知らせ】\n日時：10/8(木)\n送信者：〇〇管理\nご入居ありがとうございます。\n使用規則をお送りさせていただきますのでご一読ください。";
// お客様と家族のやり取り（名前付き）
const FAMILY = H + "【LINE会話スクリーンショット】\nユーザー名：〇〇\n〇〇：\n11/23日振り込み期日の請求書となる！\n契約書いつ届く？\nなんで高なってるん\n元々聞いてた値段しか用意してない";
// 勤務先とのやり取り（customer-property-inquiry.test の型）: 手がかりが足りない
const WORK = H + "お疲れ様です。物件の契約は法人契約でなければならないのか確認したいです。";

ok("やり取りのスクショの通を見分ける", isChatScreenshotUnit(CANCEL) && !isChatScreenshotUnit("[画像] 【物件の資料】\n…") && !isChatScreenshotUnit("キャンセルできたとおもいます"));
ok("キャンセルの返信 → 他社→お客様", readScreenshotSpeaker(CANCEL).speaker === "other_to_customer");
ok("解約の返信 → 他社→お客様", readScreenshotSpeaker(KAIYAKU).speaker === "other_to_customer");
ok("管理会社のお知らせ → 他社→お客様（送信者：は名前に数えない）", readScreenshotSpeaker(NOTICE).speaker === "other_to_customer");
ok("家族とのやり取り → people_chat", readScreenshotSpeaker(FAMILY).speaker === "people_chat");
ok("勤務先の1文 → 分からない（作らない）", readScreenshotSpeaker(WORK).speaker === "unknown");
ok("中の問いを拾う", questionsInScreenshot(CANCEL).length === 1 && /遅らせる形/.test(questionsInScreenshot(CANCEL)[0]));

ok("既定 off", screenshotSpeakerNoteOn({}) === false);
ok("off の時は今の見出しのまま", imageUnitLabel(CANCEL, IMAGE_TEXT_LABEL, {}) === IMAGE_TEXT_LABEL);
const ON = { SCREENSHOT_SPEAKER_NOTE: "on" };
const lab = imageUnitLabel(CANCEL, IMAGE_TEXT_LABEL, ON);
ok("on: 他社→お客様の見出し（こちらへの質問ではない）", /他社/.test(lab) && /こちらへの質問ではない/.test(lab));
ok("on: 見出しの後も画像の通と分かる（isImageTextUnit）", isImageTextUnit(lab + "お世話になっております。"));
ok("on: 家族のやり取りの見出し", /家族・知人/.test(imageUnitLabel(FAMILY, IMAGE_TEXT_LABEL, ON)));
ok("on: 分からない時は今の見出し", imageUnitLabel(WORK, IMAGE_TEXT_LABEL, ON) === IMAGE_TEXT_LABEL);
ok("on: 物件の画像は今の見出し", imageUnitLabel("[画像] 【物件の資料】\n賃料 6万円", IMAGE_TEXT_LABEL, ON) === IMAGE_TEXT_LABEL);

// ブレインの会話の行の札（BRAIN_SCREENSHOT_SPEAKER・既定 off）
const BON = { BRAIN_SCREENSHOT_SPEAKER: "on" };
ok("ブレインの札: 既定 off は空", screenshotSpeakerTag("customer", CANCEL, {}) === "");
ok("ブレインの札: on・他社→お客様", /他社／管理会社→お客様/.test(screenshotSpeakerTag("customer", CANCEL, BON)));
ok("ブレインの札: スタッフの行には付けない", screenshotSpeakerTag("staff", CANCEL, BON) === "");
ok("ブレインの札: 分からない時は空", screenshotSpeakerTag("customer", WORK, BON) === "");

if (failed) { console.log(`FAIL ${failed}`); process.exit(1); } else console.log("全 PASS");
