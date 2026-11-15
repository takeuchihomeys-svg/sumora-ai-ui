// scripts/lib/ask-route-of.ts — 要件→行き先の型の純関数（scripts/audit-ask-route-takeuchi.ts が使う・テスト scripts/test-audit-ask-route.ts）・作業員M 2026-11-15
/** 要件の route の内訳（digest.tc "n:r1p0a1n0[:c][:w|:o]"） */
export function tcMix(tc: string | null | undefined): { r: number; p: number; a: number; n: number } | null {
  const m = /^(\d+):r(\d+)p(\d+)a(\d+)n(\d+)/.exec(String(tc ?? ""));
  return m ? { r: +m[2], p: +m[3], a: +m[4], n: +m[5] } : null;
}
/** 物件オススメ＋ピックアップは1つの束（オススメ1＋9 の型） */
export const aixBundleFamily = (k: string): string => (/property_send|property_recommend/.test(k) ? "物件の束" : k.split("/")[0]);
/** 竹内さんの通の並び（R=返信・A=AIX・同じ記号の連続はまとめる）と AIX の種類 */
export function sendShape(moves: ReadonlyArray<{ aix: boolean }>): string {
  const ks: string[] = [];
  for (const m of moves) { const k = m.aix ? "A" : "R"; if (ks[ks.length - 1] !== k) ks.push(k); }
  return ks.join("");
}
export function outlierOf(mix: { r: number; p: number; a: number } | null, shape: string, aixKinds: number): string {
  if (!mix) return "要件の記録なし";
  const sentAix = shape.includes("A");
  // 返信だけの要件なのに竹内さんは AIX だけ＝道の取り違え（AIX 側の取りこぼしより先に見る）
  if (mix.a === 0 && mix.p === 0 && mix.r > 0 && shape === "A") return "取り違え（返信→AIX）";
  if (sentAix && mix.a === 0 && mix.p === 0) return "取りこぼし（AIX 側）";
  if (aixKinds >= 2 && mix.a <= 1) return "取りこぼし（2つ目の AIX）";
  if (mix.a > 0 && !sentAix && mix.p === 0) return "取り違え（AIX→返信）";
  if (mix.r > 0 && mix.a > 0 && shape.length === 1) return "重ねの候補（1通で両方）";
  return "合う";
}

