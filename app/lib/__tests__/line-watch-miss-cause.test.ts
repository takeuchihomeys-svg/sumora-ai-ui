// app/lib/__tests__/line-watch-miss-cause.test.ts — 返信の番の文の外れの原因の分け（実物の番の項目）
//   実行: npx tsx app/lib/__tests__/line-watch-miss-cause.test.ts
import { classifyMiss, isTextMiss, type MissRow } from "../line-watch-miss-cause";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const row = (o: Partial<MissRow>): MissRow => ({ scene_key: "返信:質問", verdict: "partial", draft_last: "", staff_texts: [], staff_aix: [], verdict_detail: { path: "返信" }, ...o });

// #7437 申込へ を押して記入のお願い
t("F3 申込へ（#7437）", classifyMiss(row({ staff_texts: [{ text: "福田さん先ほどの記入欄にご入力いただき、福田さんご本人の運転免許証またはマイナンバーカードの裏表の写真をお送りくださいませ！！", burst: true }], staff_aix: [{ aix_type: "application_push", burst: true }] })).cause === "F3");
// #5414 見積書の AIX
t("F4 見積書（#5414）", classifyMiss(row({ staff_aix: [{ aix_type: "estimate_sheet", burst: true }], staff_texts: [{ text: "Rさんクリエオーレ照ヶ丘Ⅱ 204号室最大限割引しました初期費用の御見積書となります！！", burst: true }] })).cause === "F4");
// #6038 画像だけ
t("F4 画像だけ（#6038）", classifyMiss(row({ staff_texts: [{ text: "[画像]", burst: true }] })).cause === "F4");
// #5230 お礼の番にオススメ
t("F1 お礼の番にオススメ（#5230）", classifyMiss(row({ scene_key: "返信:短い了承・お礼", staff_aix: [{ aix_type: "property_recommendation", burst: true }] })).cause === "F1");
// 内覧後の挨拶の AIX は添え（F にしない）
t("挨拶の AIX は F にしない", !classifyMiss(row({ staff_aix: [{ aix_type: "greeting_viewing", burst: true }], verdict_detail: { path: "返信", missing_acts: ["cost_amount"] } })).cause.startsWith("F"));
// #5204 確認の結果を手打ち
t("F2 確認の結果（#5204）", classifyMiss(row({ scene_key: "返信:短い了承・お礼", draft_last: "はい！！ 何卒よろしくお願い致します！！", staff_texts: [{ text: "Tio Parterre管理会社に確認させていただき、お部屋ご両親での代理契約でのお申込みも可能とのことです！！", burst: true }] })).cause === "F2");
// #6686 明日一番を下書きだけが足した
t("D 明日一番（下書きだけ）", classifyMiss(row({ draft_last: "明日一番で確認しご連絡させて頂きます！！", staff_texts: [{ text: "確認しご連絡させて頂きます！！", burst: true }] })).cause === "D");
// 食い違い
t("C 日時の食い違い", classifyMiss(row({ verdict_detail: { path: "返信", facts: { conflict: ["datetime"], draftOnly: [], staffOnly: [] } } })).cause === "C");
// 物差し
t("外れの番＝返信の道の partial", isTextMiss({ verdict: "partial", verdict_detail: { path: "返信" } }));
t("AIX の道は外れの番にしない", !isTextMiss({ verdict: "different", verdict_detail: { path: "AIX" } }));
t("na は外れの番にしない", !isTextMiss({ verdict: "na", verdict_detail: { path: "返信", reason: "staff_only_turn" } }));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
