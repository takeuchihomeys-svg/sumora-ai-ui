// こちらが送った画像の書類の守り（2026-11-21 作業員G・SENT_IMAGE_DOC_GUARD・既定 on）と、読みの現況の指示（IMAGE_READ_STATUS_STRICT・既定 on）
// 実行: npx tsx app/lib/__tests__/sent-image-doc-guard.test.ts
import { sentDocTurn, sentImageDocGuardOn } from "../sent-image-doc-guard";
import { propertyImagePrompt, imageReadStatusStrictOn } from "../property-image-read";
import { ledgerItemsSystem } from "../image-read-ledger";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
t("既定 on・=off で止める", sentImageDocGuardOn({}) && !sentImageDocGuardOn({ SENT_IMAGE_DOC_GUARD: "off" }));
// 14日の手で送った画像の前後の文の形（人の名前は伏せた）
for (const s of ["@All お疲れ様です！ 契約書類届いております！ ご確認よろしくお願いいたします", "〇〇さん 11/23日振り込み期日で請求書となります！ 契約書類の返送の際に住民票", "リビングFITのご案内兼重要事項を一度開いていただき下までスクロール", "お待たせいたしました！！ 内定通知書が完成しましたのでお送りさせていただきました"]) t(`書類の番: ${s.slice(0, 16)}`, sentDocTurn([s]).doc);
for (const s of ["こちら本日新着で募集に出た〇〇さんにオススメ出来るご条件のお部屋となります！！", "お待たせいたしました！！ 仲介手数料6万円のお見積書お送りさせていただきました！", "かしこまりました！！ お申し手続き進めさせて頂きます！！", "701号室お申し込みが入ってしまい1001号室1番手にてお申し込みしております！", "割引金額は御見積書も同じ金額で割引出来ますようにお伝えしております", "〇〇さん 先ほどはお電話ありがとうございました！！ こちらのQRコードからLINE"]) t(`書類の番でない: ${s.slice(0, 16)}`, !sentDocTurn([s]).doc);
t("画像の書き起こし（自社の御見積書の御請求金額）は見ない", !sentDocTurn(["[画像] 【見積書・初期費用の明細】\n御見積書\n御請求金額 ¥235,300"]).doc);
t("文が無い時は止めない", !sentDocTurn([]).doc && !sentDocTurn([null]).doc);
t("現況の指示 既定 on", imageReadStatusStrictOn({}) && propertyImagePrompt({}).includes("status の決め方") && !propertyImagePrompt({ IMAGE_READ_STATUS_STRICT: "off" }).includes("status の決め方"));
t("台帳の読みにも同じ指示", ledgerItemsSystem({}).includes("status の決め方") && !ledgerItemsSystem({ IMAGE_READ_STATUS_STRICT: "off" }).includes("status の決め方"));
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
