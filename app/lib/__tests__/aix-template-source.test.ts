// 実行: npx tsx app/lib/__tests__/aix-template-source.test.ts
// 2026-10-01 竹内「✨この会話に合った文を生成のところをこの改善したようにする」: テンプレート一覧を後から開いた時も、会話の履歴の最後の AIX を1通目として渡す
import { resolveTemplateSentMessage, ctaPreferenceOf } from "../aix-template-source";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, note = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${note}`); } }

const NOW = Date.parse("2026-10-01T08:00:00Z");
// YUMA の会話に 9/30 22:26 に届いた1通目そのまま（物件オススメ）
const REC1 = "🌟S-RESIDENCE福島玉川Deux 208\n\n家賃管理費込78,000円の1Kで、YUMAさんにかなりオススメ出来るお部屋となります！！\n\n玉川駅徒歩4分・2023年築で、独立洗面台・浴室乾燥機も完備しております！！";
const PICK1 = "YUMAさんご希望のご条件でお部屋ピックアップさせて頂きました😊！！\nお手隙の際にご査収ください！！";
const EST1 = "🌟最大限割引しました初期費用の御見積書お送りさせて頂きました！！";
const H = (text: string, at = "2026-10-01T07:00:00Z", isAix = true) => ({ sender: "staff", text, isAix, rawCreatedAt: at });
const C = (text: string, at = "2026-10-01T07:10:00Z") => ({ sender: "customer", text, rawCreatedAt: at });

console.log("■ resolveTemplateSentMessage");
t("★ 送った直後の本文（postAixContext）があればそれ", resolveTemplateSentMessage({ actionType: "property_recommendation", postAixSent: REC1, recent: [], nowMs: NOW }).source === "post_aix");
const h1 = resolveTemplateSentMessage({ actionType: "property_recommendation", recent: [H("[画像]"), H(REC1), C("ありがとうございます")], nowMs: NOW });
t("★ 後から開いた（postAix なし）→ 履歴の最後の AIX（物件オススメの形）を渡す", h1.source === "history" && h1.text === REC1, JSON.stringify(h1));
t("[画像] の行は飛ばす", resolveTemplateSentMessage({ actionType: "property_recommendation", recent: [H(REC1), H("[画像]")], nowMs: NOW }).text === REC1);
t("★ 最後の AIX が別の種類（見積書）→ 物件オススメには渡さない", resolveTemplateSentMessage({ actionType: "property_recommendation", recent: [H(REC1), H(EST1)], nowMs: NOW }).text === null);
t("物件ピックアップのカテゴリ → ピックアップの本文だけ", resolveTemplateSentMessage({ actionType: "property_send", recent: [H(PICK1)], nowMs: NOW }).text === PICK1 && resolveTemplateSentMessage({ actionType: "property_send", recent: [H(REC1)], nowMs: NOW }).text === null);
t("AIX でないスタッフの文は使わない", resolveTemplateSentMessage({ actionType: "property_recommendation", recent: [H(REC1, "2026-10-01T07:00:00Z", false)], nowMs: NOW }).text === null);
t("24時間より前の AIX は使わない", resolveTemplateSentMessage({ actionType: "property_recommendation", recent: [H(REC1, "2026-09-29T07:00:00Z")], nowMs: NOW }).text === null);
t("補い方を決めていない種類（内覧へ 等）は今まで通り渡さない", resolveTemplateSentMessage({ actionType: "viewing_invite", recent: [H(REC1)], nowMs: NOW }).text === null && resolveTemplateSentMessage({ actionType: null, recent: [H(REC1)], nowMs: NOW }).text === null);
t("履歴が無い → null", resolveTemplateSentMessage({ actionType: "property_recommendation", recent: null, nowMs: NOW }).text === null);

console.log("■ ctaPreferenceOf（訴求方法を選択する！！）");
t("内覧 → viewing・申込 → apply・未選択 → null", ctaPreferenceOf("内覧") === "viewing" && ctaPreferenceOf("申込") === "apply" && ctaPreferenceOf(null) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
