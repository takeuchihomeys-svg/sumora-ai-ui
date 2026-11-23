// app/lib/action-ledger-digest.ts — 行動台帳（buildActionLedger）の行の数の短い形（純関数・記録だけ・2026-11-23 作業員N2・台帳 #566）
//   連携の地図 next.ledger（行動台帳を次の番の材料に）は、台帳が brain-core の analyzeConversation の中だけで作られ、digest にも meta にも残らない＝
//   値のある番を数えられなかった（fill が src none「材料の塊」）。ここで行の数を「e:<行>|p:<宣言だけ>|d:<済み>|k:<種類>」の1語にし、
//   meta.action_ledger_counts → brainDecisionDigestExtra が digest.ld に写す。ブレインの材料（プロンプト）は変えない。
//   つなぐ所（夜・brain-exam の前後を回してから）: brain-core の brainLedger を作った後に meta.action_ledger_counts = actionLedgerDigestOf(brainLedger.entries)、
//   linkage-map の next.ledger の fill を { src: "digest", path: "ld" } に
export type LedgerEntryLike = { kind: string; status: string };

export function actionLedgerDigestOf(entries: ReadonlyArray<LedgerEntryLike> | null | undefined): string | null {
  if (!Array.isArray(entries)) return null;
  const p = entries.filter((e) => e.status === "promised").length;
  const d = entries.filter((e) => e.status === "done").length;
  const k = new Set(entries.map((e) => e.kind)).size;
  return `e:${entries.length}|p:${p}|d:${d}|k:${k}`;
}

/** digest.ld の1語を数に戻す（数える台本が使う）。形が違えば null */
export function parseActionLedgerDigest(s: unknown): { entries: number; promised: number; done: number; kinds: number } | null {
  if (typeof s !== "string") return null;
  const m = /^e:(\d+)\|p:(\d+)\|d:(\d+)\|k:(\d+)$/.exec(s.trim());
  return m ? { entries: Number(m[1]), promised: Number(m[2]), done: Number(m[3]), kinds: Number(m[4]) } : null;
}
