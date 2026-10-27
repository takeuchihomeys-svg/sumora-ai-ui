// app/lib/brain-rag-state-filter.ts — ブレインのナレッジ検索から「会話の段階が違う行」を落として、空いた枠を次の候補で埋める（純関数）
//
// 2026-10-27 節約②（P0 1bf03f2c・測ってから使う）。本番の番50件（scripts/audit-brain-rag-recall.ts・申込以降と AIX だけの番は除く）で、
//   今の検索（問い1本・上位12件）は取れた行の27%が会話の状態の名前が付いた別の段階の行・3%が申込以降の行だった。
//   多めに30件取り、状態の名前が付いていて今の状態と違う行を落として上位12件にすると、スタッフの実際の文への近さはほぼ同じ（0.534→0.524）のまま
//   混ざり 27%→0%・渡す字数 1,573→1,154（−27%）。問いを分けて引く（split）・2本を合わせる（prodMix）は近さが下がったので入れない。
//   状態の名前が付いていない行（TPO の日本語・AIX の種類の行）は落とさない（段階に依らない知識）。
// スイッチ: BRAIN_RAG_STATE_FILTER=on（既定 off＝今と同じ件数・同じ行）

export function brainRagStateFilterOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_RAG_STATE_FILTER ?? "").trim().toLowerCase() === "on";
}

/** 会話の状態の名前（conversations.status と同じ語） */
export const STATUS_VOCAB: ReadonlySet<string> = new Set(["hearing", "proposing", "viewing", "applying", "closed_won", "screening", "property_recommendation", "first_reply", "condition_hearing"]);

/** 多めに取った行から、状態の名前が付いていて今の状態と違う行を落として上位 k 件。今の状態が分からない時は落とさない */
export function filterKnowledgeByState<T extends { conversation_state?: string | null }>(rows: ReadonlyArray<T>, convStatus: string | null | undefined, k: number): T[] {
  const st = (convStatus ?? "").trim();
  const keep = (r: T) => !st || !r.conversation_state || !STATUS_VOCAB.has(r.conversation_state) || r.conversation_state === st;
  return rows.filter(keep).slice(0, k);
}
