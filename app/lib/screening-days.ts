// app/lib/screening-days.ts — 審査期間の言い方を竹内さんの決定（2026-09-26「審査期間は 3日〜10日にそろえる」）にそろえる（純関数）
//
// 2026-11-13 作業員9（統括役）: 会社の事実（company-facts）と手続きの答え（procedure-question の PROCEDURE_FACTS.flow）の両方に
//   「早ければ2〜3営業日、長くて1週間程」が残っていた。竹内さんの実送信の言い方「保証会社による入居審査（通常3日〜10日程）」にそろえる。
//   決定は1つなのでスイッチも1つ（COMPANY_FACT_SCREENING_DAYS_UNIFY・既定 off）。両方のファイルから読むため、循環しないよう別の部品にした。
export function screeningDaysUnifyOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.COMPANY_FACT_SCREENING_DAYS_UNIFY ?? "").trim().toLowerCase() === "on";
}
export function unifyScreeningDays(fact: string, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): string {
  if (!screeningDaysUnifyOn(env)) return fact;
  return fact
    .replace(/保証会社の審査期間は早ければ2〜3営業日、長くて1週間程/g, "保証会社による入居審査は通常3日〜10日程")
    .replace(/保証会社の審査（早ければ2〜3営業日、長くて1週間程）/g, "保証会社による入居審査（通常3日〜10日程）")
    .replace(/保証会社による審査（早ければ2〜3営業日、長くて1週間程）/g, "保証会社による入居審査（通常3日〜10日程）")
    .replace(/早ければ2〜3営業日、長くて1週間程/g, "通常3日〜10日程");
}
