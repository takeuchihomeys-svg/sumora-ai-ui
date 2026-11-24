// scripts/lib/exam-cut-guard.ts — 試験の削りの「質を落とさない線」（純関数・台帳 #686 の③・2026-11-25 作業員L）
//   竹内さん 11/24 20時「試験の費用も抑えて、質も上げていく仕組み」・統括役: 削りを入れる時は前の答案になぞって見落とし0を必ず示す。見落としが出た削りは自動で止める（=off）。
//   削りごとに、なぞりの道具の出力（見落とした悪化の一覧）から、止めるか（examEnv に =off を書く）を決める。
export type CutId = "narrow" | "reps" | "guards";
export const CUTS: Record<CutId, { sw: string; tool: string; name: string; autoOff: boolean }> = {
  narrow: { sw: "EXAM_NARROW", tool: "scripts/audit-narrow-rule.ts", name: "積む時の問題の絞り", autoOff: true },
  reps: { sw: "EXAM_REPS_ONE_IF_SAME", tool: "scripts/audit-reps-rule.ts", name: "最初の回が前と同じなら回さない（a）", autoOff: true },
  // 守りは「削り」ではなく見落としを拾う側＝止めずに、守りが見つけた悪化の数を出す（減らした守りで拾えなくなる恐れの目安）
  guards: { sw: "EXAM_GUARDS_REUSE_ONLY", tool: "scripts/audit-guard-yield.ts", name: "守りは使い回せる物だけ・1問まで", autoOff: false },
};
/** なぞりの道具の出力（JSON）から見落としの一覧を取り出す */
export function missedOf(cut: CutId, out: Record<string, unknown>): string[] {
  const arr = (k: string) => (Array.isArray(out[k]) ? (out[k] as unknown[]).map(String) : []);
  if (cut === "narrow") return arr("missed");
  if (cut === "reps") return arr("ruleMissed");
  return arr("worse");
}
/** 止めるか: 見落としが1件でもあり、自動で止める削りで、まだ止まっていない時 */
export function decideOff(cut: CutId, missed: readonly string[], examEnv: Readonly<Record<string, string>>): { off: boolean; why: string } {
  const c = CUTS[cut];
  if (!missed.length) return { off: false, why: "見落とし0" };
  if (!c.autoOff) return { off: false, why: `守りが見つけた悪化 ${missed.length}件（止めずに数だけ）` };
  if (String(examEnv[c.sw] ?? "").toLowerCase() === "off") return { off: false, why: `見落とし ${missed.length}件・もう off` };
  return { off: true, why: `見落とし ${missed.length}件（${missed.slice(0, 5).join("・")}）` };
}
