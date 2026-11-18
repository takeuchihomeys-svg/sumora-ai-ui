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


/**
 * 2026-11-18 統括役の割り当て（W46 の当たりの低い場面）: 外れの型を、竹内さんの決まり（CLAUDE.md の3つ）の原因に分ける目安（決定論・読んで直す前の初めの振り分け）。
 *   材料: ブレインの要件の記録が無い（材料が届いていない）／場面: 道は合っているが組・AIX の種類・1通に両方（場面や決まりの読み違い）／AIX: 返信か AIX かの取り違え
 */
export type CauseKind = "材料が届いていない" | "場面の読み違い" | "AIX の番の取り違え" | "合う";
export function causeOf(outlier: string): CauseKind {
  if (outlier.startsWith("合う")) return "合う";
  if (outlier.startsWith("要件の記録なし")) return "材料が届いていない";
  if (/取り違え|取りこぼし（AIX 側）/.test(outlier)) return "AIX の番の取り違え";
  return "場面の読み違い"; // 2つ目の AIX の席・重ねの候補・AIX の種類が違う
}
/** 道は合っているが AIX の種類が違う（ブレインの最終の AIX と竹内さんの AIX の束が違う） */
export function aixKindMismatch(brainAction: string | null | undefined, staffKinds: readonly string[]): boolean {
  const b = String(brainAction ?? "").split("/")[0].trim();
  if (!b || b === "null" || !staffKinds.length) return false;
  return !staffKinds.includes(aixBundleFamily(b));
}
/** 帳面の3つ（取りこぼし・重ね・取り違え）のどれか */
export function ledgerClassOf(outlier: string): "取りこぼし" | "重ね" | "取り違え" | "記録なし" | "合う" | "種類違い" {
  if (outlier.startsWith("合う")) return "合う";
  if (outlier.startsWith("要件の記録なし")) return "記録なし";
  if (outlier.startsWith("取りこぼし")) return "取りこぼし";
  if (outlier.startsWith("重ね")) return "重ね";
  if (outlier.startsWith("AIX の種類")) return "種類違い";
  return "取り違え";
}
