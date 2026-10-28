// app/lib/brain-material-self-report.ts — ブレインの自己申告「判断に要ったのに材料に無かった物」（純関数・記録だけ）
//
// 2026-10-29 竹内さん（KB P1「材料が足りない所と知識が弱い所を、仕組みで把握して見つけ出し続ける」）・作業員1:
//   ブレインに毎回「この判断に要ったのに、渡された材料に無かった物」を material_missing（短い名前の配列）で書かせ、
//   brain_decision_logs.digest.mm に残す。読めなかった材料（brain:material-miss・DB の時間切れ）と合わせて、毎週どの材料が何回足りなかったかを
//   scripts/line-watch-miss-causes.ts の章で数える。判断・下書きには使わない（記録だけ）。
//   指示はプロンプトの最後のブロック（毎回変わる素の入力の後ろ）に足す＝system と会話のキャッシュの前置きは崩さない。
//   止める: BRAIN_MATERIAL_SELF_REPORT=off（指示も記録も出さない）
type Env = Record<string, string | undefined>;

export function brainMaterialSelfReportOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_MATERIAL_SELF_REPORT ?? "").trim().toLowerCase() !== "off";
}

/** プロンプトの最後に足す指示（出力の JSON に1項目足すだけ・判断のやり方は変えない） */
export const MATERIAL_SELF_REPORT_INSTRUCTION =
  "【記録用・判断は変えない】出力の JSON に \"material_missing\" を足す: この番の判断に要ったのに、上の材料に無かった（または読めなかった）物の短い名前の配列（1つ15字まで・最大5つ）。" +
  "例: [\"送った物件の現況\",\"見積の金額\",\"入居時期\",\"会社の事実（引越し業者の手配）\"]。足りていれば []。推測で埋めた物も書く。";

/** LLM の material_missing を整える（文字列だけ・空と重複を外す・最大5つ・1つ30字まで）。項目が無い時は null（記録しない） */
export function normalizeMaterialMissing(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const out: string[] = [];
  for (const x of arr) {
    if (typeof x !== "string") continue;
    const s = Array.from(x.replace(/\s+/g, " ").trim()).slice(0, 30).join("");
    if (!s || /^(なし|無し|特になし|none|n\/a)$/i.test(s) || out.includes(s)) continue;
    out.push(s);
    if (out.length >= 5) break;
  }
  return out;
}
