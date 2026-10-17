// app/lib/__tests__/condition-image-guard.test.ts
// 実行: npx tsx app/lib/__tests__/condition-image-guard.test.ts（全 PASS で exit 0）
import { conditionImageVerdict } from "../condition-image-guard";
let fail = 0;
const eq = (n: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) { fail++; console.log(`✗ ${n} got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); } else console.log(`✓ ${n}`); };
eq("検索条件の画面は通る", conditionImageVerdict({ text: "[画像] 【物件以外：検索条件の画面】\nエリア 大阪市北区 賃料 8万円以下", image_type: "other" }).personal, false);
eq("物件の資料は通る", conditionImageVerdict({ text: "[画像] 【物件の資料】\n賃料 6万円", image_type: "floor_plan" }).personal, false);
eq("やり取りのスクショは通る", conditionImageVerdict({ text: "[画像] 【物件以外：やり取りのスクショ】\n…", image_type: "other" }).personal, false);
eq("本人確認書類（種類だけの形）は倒す", conditionImageVerdict({ text: "[画像] 本人確認書類", image_type: "id_document" }).personal, true);
eq("image_type が身分証", conditionImageVerdict({ text: "[画像]", image_type: "id_document" }).personal, true);
eq("振込の控え", conditionImageVerdict({ text: "[画像] 【物件以外：振込・支払いの控え】", image_type: "estimate" }).personal, true);
eq("個人情報の載った画像", conditionImageVerdict({ text: "[画像] 【物件以外：個人情報の載った画像】", image_type: "other" }).personal, true);
eq("人物の写真", conditionImageVerdict({ text: "[画像] 【物件以外：人物の写真】", image_type: "other" }).personal, true);
eq("当たらない＝通る", conditionImageVerdict(null).personal, false);
if (fail) { console.log(`${fail} FAIL`); process.exit(1); }
console.log("ALL PASS");
