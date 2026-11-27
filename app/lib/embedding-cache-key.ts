// app/lib/embedding-cache-key.ts — embedding_cache の鍵（純関数・DB なし）
// 2026-11-28 作業員L（統括役の決め・案B）: 鍵は文のまま残さない＝md5（伏せきれない文が DB に溜まらない）。
//   先頭の場面の札（[TPO:…]・40字まで・個人の値を含まない）だけは鍵に残す（scripts/audit-rag-garbage の「[TPO:」で始まる本番の問い の絞りが使う）。
//   前の形（文のまま）の行は鍵が合わなくなる＝作り直されるだけ（push の後に全部消して作り直す）
import { createHash } from "node:crypto";
export function embeddingCacheKey(masked: string): string {
  const tag = masked.match(/^\[TPO:[^\]\n]{0,40}\]/)?.[0] ?? "";
  return `${tag}h:${createHash("md5").update(masked).digest("hex")}`;
}
