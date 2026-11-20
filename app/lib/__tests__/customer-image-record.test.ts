// お客様の画像の記録の行（2026-11-21 作業員G・CUSTOMER_IMAGE_RECORD・既定 off）
// 実行: npx tsx app/lib/__tests__/customer-image-record.test.ts
import { linkCustomerImage } from "../customer-image-link";
import { customerImageRecordOn, customerImageRecordRow } from "../customer-image-record";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
t("既定 on・=off で止める", customerImageRecordOn({}) && !customerImageRecordOn({ CUSTOMER_IMAGE_RECORD: "off" }));
const at = "2026-11-20T10:00:00.000Z";
const msg = (text: string, image_type: string | null = null) => ({ id: "m1", conversation_id: "c1", created_at: at, text, image_type });
// こちらの資料の送り返し（画面の文字だけ・人の名前なし）
const ours = ["[画像] 【物件の資料】", "物件名：アイボリーフロント雑賀WEST", "号室名：803（8階部分）", "賃料 7.2万円 管理費 8,000円 1K 25.5m²"].join("\n");
const sent = [{ name: "アイボリーフロント雑賀WEST", room: "803", sentAt: "2026-11-18T10:00:00.000Z" }];
const l1 = linkCustomerImage({ text: ours, at, customerWords: "ここ内覧したいです", sent });
const r1 = customerImageRecordRow({ ...msg(ours), nameVia: "text" }, l1);
t("物件の資料: 種類・物件名・号室・照合・聞いている事", r1.kind === "property_material" && r1.property_name === "アイボリーフロント雑賀WEST" && r1.room_no === "803" && r1.ours_kind === "same_room" && r1.asks.includes("viewing") && !!r1.unit_key, r1);
t("書き起こし・文そのものは行に無い", !JSON.stringify(r1).includes("ここ内覧") && !JSON.stringify(r1).includes("賃料 7.2"));
// 書類は種類だけ
const doc = "[画像] 本人確認書類";
const l2 = linkCustomerImage({ text: doc, imageType: "id_document", at, sent: [] });
const r2 = customerImageRecordRow(msg(doc, "id_document"), l2);
t("書類: kind だけ・物件の欄は空", r2.kind === "document" && r2.property_name === null && r2.unit_key === null && r2.rent_yen === null, r2);
// 見積書は会社と数字だけ（宛名は入れない）
const est = ["[画像] 【見積書・初期費用の明細】", "御見積書", "山田 太郎 様", "株式会社テスト不動産", "敷金 0", "礼金 70,000", "仲介手数料 77,000", "保証会社 35,000", "合計 250,000"].join("\n");
const l3 = linkCustomerImage({ text: est, at, sent: [] });
const r3 = customerImageRecordRow(msg(est), l3);
t("見積書: 会社と数字だけ・宛名なし", !!r3.estimate && r3.estimate.company === "other" && r3.estimate.items.total === 250000 && !JSON.stringify(r3).includes("山田") && !JSON.stringify(r3).includes("テスト不動産"), r3);
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
