// AIX で送った画像を AIX の記録の物件名に結ぶ（2026-11-21 作業員G・#448・SENT_IMAGE_AIX_ATTRIBUTE・既定 off）
// 実行: npx tsx app/lib/__tests__/sent-image-aix-attribute.test.ts
import { pickAixProperty, sentImageAixAttributeOn, splitNameRoom, looksLikePropertyName } from "../sent-image-aix-attribute";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
const at = Date.parse("2026-11-20T10:00:00Z");
const log = (type: string, names: string[], dtSec = 30) => ({ aix_type: type, property_names: names, sent_at: new Date(at + dtSec * 1000).toISOString(), created_at: new Date(at + dtSec * 1000).toISOString() });
t("既定 off", !sentImageAixAttributeOn({}) && sentImageAixAttributeOn({ SENT_IMAGE_AIX_ATTRIBUTE: "on" }));
t("名前と号室を分ける", JSON.stringify(splitNameRoom("エスタート御幣島 308号室")) === JSON.stringify({ name: "エスタート御幣島", room: "308" }));
t("号室なし", splitNameRoom("Belle Court 大美野").room === null);
const r1 = pickAixProperty("aix:property_check_result", at, [log("property_check_result", ["テストハイツ 202号室"])]);
t("AIX の記録が1件・物件1件・種類が同じ → 結ぶ", !!r1 && r1.name === "テストハイツ" && r1.room === "202", r1);
t("手で送った画像は結ばない", pickAixProperty("staff_image", at, [log("property_check_result", ["テストハイツ 202号室"])]) === null);
t("物件が2件の AIX は結ばない", pickAixProperty("aix:property_check_result", at, [log("property_check_result", ["A 101号室", "B 202号室"])]) === null);
t("前後5分に AIX の記録が2件は結ばない", pickAixProperty("aix:property_check_result", at, [log("property_check_result", ["A 101号室"]), log("estimate_sheet", ["B 202号室"], 60)]) === null);
t("種類が違う記録は結ばない", pickAixProperty("aix:property_check_result", at, [log("estimate_sheet", ["A 101号室"])]) === null);
t("5分より離れた記録は使わない", pickAixProperty("aix:property_check_result", at, [log("property_check_result", ["A 101号室"], 400)]) === null);
t("物件名の欄の説明文は結ばない（実物の形）", !looksLikePropertyName("- 物件資料の画像を送付（賃貸物件の詳細情報、間取り図、写真、地図を含む）") && pickAixProperty("aix:property_check_result", at, [log("property_check_result", ["- 物件資料の画像を送付（詳細情報）"])]) === null);
t("「00号室」は号室なし", splitNameRoom("テストハイツ 00号室").room === null);
const withBody = (body: string) => ({ ...log("property_check_result", ["テストハイツ 202号室"]), generated_text: body });
t("AIX の本文に物件名が出ている → 結ぶ", pickAixProperty("aix:property_check_result", at, [withBody("テストハイツ202号室のお写真お送りさせて頂きます")]) !== null);
t("AIX の本文に物件名が出ていない → 結ばない（確かめられない）", pickAixProperty("aix:property_check_result", at, [withBody("お部屋のお写真お送りさせて頂きます")]) === null);
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
