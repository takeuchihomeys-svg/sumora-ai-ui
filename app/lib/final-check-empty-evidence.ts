// app/lib/final-check-empty-evidence.ts — 最終チェックが「該当なし」等の証拠のまま出した知らせを外す出口の網（純関数・DB/LLM なし）
//
// 2026-11-18 作業員H（統括役の頼み・朝の穴の割り当て 3「材料に無い金額を書いた」1件の確かめ）:
//   直近7日の FABRICATED_AMOUNT 2件は、どちらも最終チェック（anomaly_scan）が自分で証拠に「該当なし」「該当する具体的な金額記載なし」と書いたまま
//   知らせとして出していた（15631: 下書きの「家賃5万円以下」はお客様のフォームの「0〜5万」の復唱／15229: 下書きに金額が無い）。
//   証拠が「無い」と言っている知らせは、引用の無い指摘（今も破棄している）と同じ＝外す。最終チェックをボトルネックにしない決まり（feedback_final_check_not_bottleneck）とも合う。
//   外す条件: 捏造の知らせ（FABRICATED_*）で、証拠の全体が「該当なし／記載なし／見当たらない／特になし／ありません／問題なし」の言い方だけ（引用の言葉が他に無い）で、下書きにその言葉が無い。
//   切替: 11/18 から既定 on（止める FINAL_CHECK_DROP_EMPTY_EVIDENCE=off）。監査: scripts/audit-final-check-empty-evidence.ts（過去の知らせに当てて誤って外す物を数える）
// テスト: app/lib/__tests__/final-check-empty-evidence.test.ts
type Env = Record<string, string | undefined>;
export function dropEmptyEvidenceOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.FINAL_CHECK_DROP_EMPTY_EVIDENCE ?? "").trim().toLowerCase() !== "off"; // 11/18 統括役の決め: 30日 270件の監査で誤って外す物0 → 既定 on（止める =off）
}
/** 証拠が「無い」と言っているだけか（括弧・句読点・空白を除いて、無いの言い方の語だけで出来ている） */
const EMPTY_PHRASE = /^(?:(?:返信文|返信|本文|文|全体|中|に|で|該当|対象|具体的な|記載|明記|言及|該当する|金額|日付|時刻|物件名|号室|数字|箇所|もの|物|の|は|が|する)*?)(?:なし|無し|ない|ありません|見当たらない|見当たりません|特になし|特に無し|問題なし|問題ありません|なし。?)$/;
export function isEmptyEvidence(evidence: string): boolean {
  const e = String(evidence ?? "").normalize("NFKC").replace(/[\s「」『』()（）\[\]【】、。.,・:：\-ー"'”“]/g, "");
  if (!e) return true;
  if (e.length > 30) return false; // 長い証拠は引用を含む＝外さない
  return EMPTY_PHRASE.test(e);
}
/** 外すか（引用が下書きに本当にある時は外さない＝「該当なし」という語を下書きが書いた等） */
export function shouldDropEmptyEvidence(evidence: string, draft: string, env?: Env, code?: string): boolean {
  if (!dropEmptyEvidenceOn(env)) return false;
  if (code !== undefined && !/^FABRICATED_/.test(String(code))) return false; // 捏造の知らせだけ（MISSED_QUESTION の証拠はお客様の引用＝「ないですかね」を外さない）
  const e = String(evidence ?? "").trim();
  if (!isEmptyEvidence(e)) return false;
  if (e && String(draft ?? "").includes(e)) return false;
  return true;
}
