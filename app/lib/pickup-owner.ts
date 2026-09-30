// app/lib/pickup-owner.ts — 物件の付け先（誰の候補として記録・共有するか）の関所（純関数）
//
// 2026-09-30 竹内「監視のところでちゃんと入り込まんように対策する／お客さんの名前ずれてないか監視する」
//   拡張 v2.5.47 までの自動便で、ITANDI の物件が「検索したお客様」でなく前のお客様に付いた（16:39〜19:02 の 161件・未送信のうちに外した）。
//   拡張 v2.5.49 は送信の出口で「今そのサイトで検索している回のお客様」（batch_owner）と照らし、サーバーにも渡してくる。
//   ここはサーバー側の2枚目の壁: 渡ってきた回のお客様と、記録しようとしている相手が違えば受け取らない（記録も ★物件出し★ への共有もしない）。
//   batch_owner が無い送信（手の検索・スタッフの送信・古い版の拡張）は今まで通り通す。
type AuditStepLite = { k?: string | null; d?: string | null };

export type BatchOwner = { customer_id?: string | null; customer_name?: string | null; run_id?: string | null; command_id?: string | null };

export type OwnerVerdict =
  | { ok: true }
  | { ok: false; reason: "owner_mismatch"; detail: string };

const short = (s: string | null | undefined) => String(s ?? "").slice(0, 8) || "?";

/** 記録しようとしている相手（resolvedCustomerId）が、拡張の言う「検索している回のお客様」と同じか */
export function checkPickupOwner(i: { resolvedCustomerId: string | null | undefined; batchOwner: BatchOwner | null | undefined; postedName?: string | null }): OwnerVerdict {
  const owner = i.batchOwner && typeof i.batchOwner.customer_id === "string" ? i.batchOwner.customer_id.trim() : "";
  const to = (i.resolvedCustomerId ?? "").trim();
  if (!owner || !to) return { ok: true };
  if (owner === to) return { ok: true };
  return {
    ok: false, reason: "owner_mismatch",
    detail: `送る相手 ${short(to)}（${i.postedName ?? "名前なし"}）が、検索している回のお客様 ${short(owner)}（${i.batchOwner?.customer_name ?? "名前なし"}）と違う`,
  };
}

/** 名前の比べ方（拡張の batch-guard.js normName と同じ）: NFKC・末尾の「さん／様」・空白を除く */
export function normCustomerName(s: string | null | undefined): string {
  return String(s ?? "").normalize("NFKC").replace(/(さん|様)\s*$/, "").replace(/[\s　]+/g, "");
}

/** 点検の段（search_audits.steps）から、付け先のずれ・名前ずれの段を拾う（search-audit-check の札の材料） */
export function ownerStepsFrom(steps: ReadonlyArray<AuditStepLite> | null | undefined): { mismatch: string[]; nameDrift: string[]; fill: number } {
  const out = { mismatch: [] as string[], nameDrift: [] as string[], fill: 0 };
  for (const s of steps ?? []) {
    if (!s || typeof s.k !== "string") continue;
    if (s.k === "owner_mismatch") out.mismatch.push(String(s.d ?? ""));
    else if (s.k === "owner_name_drift") out.nameDrift.push(String(s.d ?? ""));
    else if (s.k === "owner_fill") out.fill++;
  }
  return out;
}
