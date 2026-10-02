// scripts/lib/replay-truth.ts
// 2026-10-02 ⑫（竹内さん「原因はわかっているのか？改善されない部分の」→ 22巡の外れを全件分類）:
//   再生の外れのうち「正解の側が竹内さんの決定より古い」「再生の環境に材料が無い」物を、本当の外れと分けて数える（純関数・DB なし）。
//   ・decision（竹内さんの決定どおり・外れに数えない）:
//       2段の場面（brain.two_stage あり・返信）で、スタッフはその場で AIX を押していた（10/02「送れる物が無い時は約束の返信」）
//       日にちが決まった番で AIX【待ち合わせ】・スタッフは「待ち合わせ場所追ってご連絡」（10/02 訂正「内覧日決まったら1件目の内覧場所を集合場所」）
//   ・environment（再生の環境・外れに数えない）: 場面を作れなかった（DB のタイムアウト 等）／本番は売上サポに送れる物件があった（YUMA には無い）／
//       正解の側に個別の印（scripts/replay-reference-corrections.json）がある場面
//   ・miss: それ以外の外れ（本当の弱さ）
export type TruthRec = {
  id?: string; path_ok?: boolean; decided?: string; accept?: string[]; error?: string; staff_text?: string;
  brain?: { two_stage?: string | null; source?: string | null } | null;
};
export type Correction = { label: "decision" | "environment" | "outlier"; why: string };
export type Truth = "hit" | "decision" | "environment" | "outlier" | "miss";

const MEETING_LATER_RE = /(?:お)?待ち合わせ(?:場所|の場所)[^。\n！!]{0,14}(?:追って|改めて|後ほど|前日|当日|お送り|ご連絡|お伝え|あわせて)/;

export function truthOf(r: TruthRec, corrections: Record<string, Correction> = {}): Truth {
  if (r.error) return "environment";
  if (r.path_ok) return "hit";
  const c = r.id ? corrections[r.id] : undefined;
  if (c) return c.label;
  const acc = r.accept ?? [];
  if (r.brain?.two_stage && r.decided === "reply" && acc.some((a) => a !== "reply")) return "decision";
  if (r.decided === "meeting_place" && MEETING_LATER_RE.test(r.staff_text ?? "")) return "decision";
  return "miss";
}

/** 同じ場面の判断が巡ごとに変わったか（揺れ）。histories は場面ごとの判断の並び */
export function flipped(decisions: ReadonlyArray<string | undefined>): boolean {
  return new Set(decisions.filter(Boolean)).size > 1;
}
