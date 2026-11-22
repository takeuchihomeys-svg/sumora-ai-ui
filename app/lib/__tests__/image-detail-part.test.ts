// app/lib/__tests__/image-detail-part.test.ts — 2026-11-22 作業員K2（#287・IMAGE_DETAIL_PART）
//   実行: npx tsx app/lib/__tests__/image-detail-part.test.ts
import { imageDetailPartOn, partOfAixImage, partForDetail, IMAGE_PARTS } from "../image-detail-part";
import { estimateRoleRows } from "../estimate-image-role";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
t("既定 on（2026-11-22）・off で止める", imageDetailPartOn({}) && !imageDetailPartOn({ IMAGE_DETAIL_PART: "off" }));
t("言葉は customer_image_records.part と同じ5つ", IMAGE_PARTS.join(",") === "listing,interior,floor_plan,exterior,cost");
t("見積書送る → cost", partOfAixImage({ aixType: "estimate_sheet" }) === "cost");
t("見積書の同封の画像 → cost", partOfAixImage({ aixType: "property_check_result", isEstimateImage: true }) === "cost");
t("物件確認した の室内写真 → interior", partOfAixImage({ aixType: "property_check_result", checkPattern: "interior_photo" }) === "interior");
t("物件確認した（その他） → 決めない", partOfAixImage({ aixType: "property_check_result", checkPattern: "availability" }) === null);
t("物件ピックアップ → listing", partOfAixImage({ aixType: "property_send" }) === "listing");
t("物件オススメ（資料と室内が混ざる） → 決めない", partOfAixImage({ aixType: "property_recommendation" }) === null);
t("読み取りが estimate なら cost", partForDetail("estimate", null) === "cost");
t("読み取りが property なら送った時の部分（cost は入れない）", partForDetail("property", "interior") === "interior" && partForDetail("property", "cost") === null && partForDetail("property", null) === null);
t("書類・その他は部分なし", partForDetail("document", "listing") === null && partForDetail("other", "interior") === null);
const off = estimateRoleRows(["https://x/property-images/aix/c1/a.jpg"], "c1", { IMAGE_DETAIL_PART: "off" });
const on = estimateRoleRows(["https://x/property-images/aix/c1/a.jpg"], "c1", {});
t("見積書の先の行: off は part を書かない・on は cost", !("part" in off[0]) && on[0].part === "cost" && on[0].kind === "estimate");
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
