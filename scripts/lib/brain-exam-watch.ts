// scripts/lib/brain-exam-watch.ts — 見張りで外れた番から、正解が「台帳と押した AIX」で決まる試験の問題を作る線（純関数・2026-10-13）
//   使う所: scripts/brain-exam-watch-candidates.ts。テスト: scripts/lib/__tests__/brain-exam-watch.test.ts
const AIX_RE = /^[a-z_]+$/;
/** 時刻で押す AIX（内覧後の挨拶 等）はお客様の発言への一手でない＝自動の正解にしない */
const TIMING_AIX = new Set(["greeting_viewing", "followup_revive"]);

export type WatchMissRow = {
  brain_action: string | null; brain_reply_mode: string | null; brain_check_pattern?: string | null;
  verdict_detail: Record<string, unknown> | null;
  staff_aix: Array<{ aix_type: string; check_pattern: string | null; at?: string; burst: boolean }> | null;
};

/**
 * 自動で足してよい番の正解（決まらなければ null）。
 *   aix_other（ブレインは別の AIX）・text_but_aix（ブレインは返信）で、返事のまとまりで押した AIX が1種類だけの番。
 *   accept = 押した AIX（ピッカーがあれば ピッカーつき＋種類だけ）／mustNot = ブレインの道
 */
export function autoAnswerOf(r: WatchMissRow): { accept: string[]; mustNot: string[]; type: string } | null {
  const reason = String(r.verdict_detail?.reason ?? "");
  if (reason !== "aix_other" && reason !== "text_but_aix") return null;
  const burst = (r.staff_aix ?? []).filter((p) => p.burst && AIX_RE.test(p.aix_type));
  const kinds = [...new Set(burst.map((p) => p.aix_type))];
  if (kinds.length !== 1 || TIMING_AIX.has(kinds[0])) return null; // 2種類以上押した番は正解が1つに決まらない
  const p = burst[0];
  const accept = [`AIX:${p.aix_type}${p.check_pattern ? `/${p.check_pattern}` : ""}`];
  if (p.check_pattern) accept.push(`AIX:${p.aix_type}`);
  if (reason === "aix_other") {
    const b = String(r.brain_action ?? "").trim();
    if (!b || !AIX_RE.test(b) || b === p.aix_type) return null;
    return { accept, mustNot: [`AIX:${b}`], type: "AIXの種類" };
  }
  return { accept, mustNot: ["返信"], type: "返信かAIXか" };
}
