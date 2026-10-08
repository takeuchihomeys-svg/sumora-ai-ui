// app/lib/customer-attention.ts
// お客様一覧の画面（app/customers/page.tsx）の「要対応」と並び（純関数・画面から使う）。
// 2026-10-08 竹内さん「その形でおねがい」: 要対応＝ブレインの判断（AIX要対応 pending・今の AIX・物件出しの約束＝brain-attention brainNeedsStaff）
//   ＋スタッフが手で付けた印。並び＝AIX要対応 → ①内覧済み ②審査落ち → ③新規 → ④物件検索中（attentionRank）。
//   ブレインを読めていない（brain=null・NEXT_PUBLIC_BRAIN_ATTENTION=off・読み込み前）は今まで通り is_flagged。

/** /api/brain-attention の1件（brain-attention-server AttentionInfo の画面で使う部分） */
export type AttentionLite = { needs: boolean; rank: number; tier?: string | null; pendingAixAction?: string | null };

export function customerAttention(i: {
  convId: string | null;
  isFlaggedDb: boolean;
  brain: Record<string, AttentionLite> | null;
  manualFlags?: Set<string> | null;
}): { flagged: boolean; rank: number } {
  if (!i.brain) return { flagged: i.isFlaggedDb, rank: 9 };
  if (!i.convId) return { flagged: false, rank: 9 };
  const a = i.brain[i.convId];
  const manual = !!i.manualFlags?.has(i.convId);
  return { flagged: !!a?.needs || manual, rank: a ? a.rank : 9 };
}
