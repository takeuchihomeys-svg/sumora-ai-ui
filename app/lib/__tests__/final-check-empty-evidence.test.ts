// 最終チェックの「該当なし」の証拠の知らせを外す（2026-11-18 作業員H・FINAL_CHECK_DROP_EMPTY_EVIDENCE・11/18 から既定 on）
// 実行: npx tsx app/lib/__tests__/final-check-empty-evidence.test.ts
import { isEmptyEvidence, shouldDropEmptyEvidence, dropEmptyEvidenceOn } from "../final-check-empty-evidence";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
const on = { FINAL_CHECK_DROP_EMPTY_EVIDENCE: "on" };
// 実物（見張り 15631・15229 の証拠）
t("既定 on・=off で止める", dropEmptyEvidenceOn({}) && !dropEmptyEvidenceOn({ FINAL_CHECK_DROP_EMPTY_EVIDENCE: "off" }));
t("「該当なし」は空", isEmptyEvidence("該当なし"));
t("「該当する具体的な金額記載なし」は空", isEmptyEvidence("該当する具体的な金額記載なし"));
t("「見当たりません」「特になし」は空", isEmptyEvidence("見当たりません") && isEmptyEvidence("特になし"));
t("引用のある証拠は空でない（家賃8万円台）", !isEmptyEvidence("家賃8万円台の物件もご紹介できます"));
t("引用のある証拠は空でない（号室）", !isEmptyEvidence("エクセレント目黒503号室"));
t("「空室なし」のような中身の引用は空でない", !isEmptyEvidence("満室で空室なしとなっております"));
t("off は外さない", !shouldDropEmptyEvidence("該当なし", "はい😊！！", { FINAL_CHECK_DROP_EMPTY_EVIDENCE: "off" }));
t("on・下書きに無い空の証拠は外す", shouldDropEmptyEvidence("該当なし", "はい😊！！ご連絡お待ちしております！！", on));
t("on・下書きにその言葉がある時は外さない", !shouldDropEmptyEvidence("該当なし", "現在ご希望の条件に該当なしのため", on));
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
// 11/18 監査で見た形: 「返信文全体に日付・時刻の明記がない」は空・MISSED_QUESTION のお客様の引用「…中々ないですかね」は外さない
import("../final-check-empty-evidence").then(({ isEmptyEvidence, shouldDropEmptyEvidence }) => {
  const a = isEmptyEvidence("返信文全体に日付・時刻の明記がない");
  const b = !shouldDropEmptyEvidence("大型犬行けるとこは中々ないですかね💦", "はい", { FINAL_CHECK_DROP_EMPTY_EVIDENCE: "on" }, "MISSED_QUESTION");
  const c = shouldDropEmptyEvidence("なし", "はい", { FINAL_CHECK_DROP_EMPTY_EVIDENCE: "on" }, "FABRICATED_POLICY");
  console.log(a && b && c ? "  OK  監査の形（日付の明記がない・お客様の引用・なし）" : `  NG  監査の形 ${a} ${b} ${c}`);
  if (!(a && b && c)) process.exit(1);
});
