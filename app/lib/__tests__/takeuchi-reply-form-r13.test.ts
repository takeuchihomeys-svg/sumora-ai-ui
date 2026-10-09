// app/lib/__tests__/takeuchi-reply-form-r13.test.ts — 竹内さんの手打ちの返信の型（実行: npx tsx app/lib/__tests__/takeuchi-reply-form-r13.test.ts）
//   文は竹内さんの手打ちの実送信（名前は伏せた）
import { isAckOnlyAgree, nanisotsuNote, normalizeItsudemo, fixSanTachi, consideringCloseEnabled, CONSIDERING_CLOSE_DIRECTION, LIFE_EVENT_NOTE, consideringDirectionFor } from "../takeuchi-reply-form-r13";
import { buildSituationNote } from "../customer-situation-r11";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${info !== undefined ? ` → ${JSON.stringify(info)}` : ""}`); } };

// ② 了承だけ
t("「了解です！」は了承だけ", isAckOnlyAgree("了解です！"));
t("「わかりました。ありがとうございます😊」は了承だけ", isAckOnlyAgree("わかりました。ありがとうございます😊"));
t("「承知しました、よろしくお願いします」は了承だけ", isAckOnlyAgree("承知しました、よろしくお願いします"));
t("「ありがとうございます」だけは了承だけにしない（お礼だけ）", !isAckOnlyAgree("ありがとうございます"));
t("質問が付けば了承だけにしない", !isAckOnlyAgree("了解です！ちなみに駐車場ありますか？"));

// ① 何卒
t("初回は付ける側", nanisotsuNote({ scene: "conditions", isFirstContact: true, ackOnly: false }, {}).includes("付ける側"));
t("質問は付けない側", nanisotsuNote({ scene: "question", isFirstContact: false, ackOnly: false }, {}).includes("付けない側"));
t("TAKEUCHI_FORM_R13=off", nanisotsuNote({ scene: "question", isFirstContact: false, ackOnly: false }, { TAKEUCHI_FORM_R13: "off" }) === "");

// ③ 検討中は誘わず閉じる
t("検討中を閉じる（既定 on）", consideringCloseEnabled({}) && !consideringCloseEnabled({ CONSIDERING_CLOSE: "off" }));
t("検討中の方向に扉の1文を書かない", CONSIDERING_CLOSE_DIRECTION.includes("ごゆっくりご検討頂けますと幸いです") && CONSIDERING_CLOSE_DIRECTION.includes("書かない"));

// ④ 何時でも／いつでも
const DRAFT = "はい😊！！\n気になる点出てきましたら何時でもお気軽にご連絡ください！！";
t("当日でない番 → いつでも", normalizeItsudemo(DRAFT, { customerText: "了解です", scene: "ack" }, {}).text.includes("いつでもお気軽に"));
t("当日の話 → 何時でも", normalizeItsudemo("いつでもお気軽にご連絡ください！！", { customerText: "今日の内覧ですが少し遅れます", scene: "viewing" }, {}).text === "何時でもお気軽にご連絡ください！！");
t("申込の番 → 何時でも", normalizeItsudemo("いつでもお気軽にご連絡ください！！", { customerText: "申込したいです", scene: "apply" }, {}).text.startsWith("何時でも"));
t("時間の範囲の後の「何時でも」は変えない", normalizeItsudemo("19時までですと何時でもお電話可能です😊！！", { customerText: "電話できますか", scene: "question" }, {}).text === "19時までですと何時でもお電話可能です😊！！");
t("ITSUDEMO_R13=off", normalizeItsudemo(DRAFT, { customerText: "了解です", scene: "ack" }, { ITSUDEMO_R13: "off" }).changed === 0);

// ⑧ 〇〇さん達
const D2 = "〇〇さん達のご条件に合ったお部屋ピックアップしお送りさせて頂きます！！";
t("手がかりが無い → さん", fixSanTachi(D2, ["梅田周辺で家賃8万以内です", "大丈夫です"], {}).text === "〇〇さんのご条件に合ったお部屋ピックアップしお送りさせて頂きます！！");
t("同棲と言っていた → 達のまま", fixSanTachi(D2, ["彼氏と同棲予定で2LDKを探しています"], {}).changed === 0);
t("0歳児（子ども）→ 達のまま", fixSanTachi(D2, ["0歳児がいます"], {}).changed === 0);
t("「大丈夫」の夫は手がかりにしない", fixSanTachi(D2, ["大丈夫です"], {}).changed === 1);

// ⑨ 人生の出来事
t("出来事は新しい状態に合わせた注記", buildSituationNote("彼女と別れることになりまして一人で住む予定です", true).includes("新しい状態"), buildSituationNote("彼女と別れることになりまして一人で住む予定です", true));
t("手本の文（10-02 別れ）を持つ", LIFE_EVENT_NOTE.includes("改めて家賃・広さ・設備のご希望を教えて頂けますと幸いです"));

// 10/09 検討しますの扉: 確認の結果・見積書の後は申込の一言／詳細の直後は内覧の案内だけ／それ以外は閉じる
t("見積書の後は申込の一言", consideringDirectionFor({ afterEstimateOrCheck: true, afterPropertyDetails: false }).includes("お申込みしお部屋抑えさせて頂きます"));
t("詳細の直後は内覧の案内だけ", consideringDirectionFor({ afterEstimateOrCheck: false, afterPropertyDetails: true }).includes("ご案内させて頂きます") && !consideringDirectionFor({ afterEstimateOrCheck: false, afterPropertyDetails: true }).includes("お申込みしお部屋抑え"));
t("それ以外は閉じる", consideringDirectionFor({ afterEstimateOrCheck: false, afterPropertyDetails: false }) === CONSIDERING_CLOSE_DIRECTION);
// 10/09 竹内さんの答え
t("全力でサポートの後の何卒: 初回は続ける", nanisotsuNote({ scene: "conditions", isFirstContact: true, ackOnly: false }, {}).includes("初回は「何卒よろしくお願い致します！！」を続ける"));
t("全力でサポートの後の何卒: 初回以外は続けない", nanisotsuNote({ scene: "conditions", isFirstContact: false, ackOnly: false }, {}).includes("何卒を続けない"));
t("出産 → 広さ・間取りを聞き直す", buildSituationNote("来年の春に子供が産まれる予定なんです", true).includes("広さ・間取りを聞き直す"));

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exitCode = 1;
