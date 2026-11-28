// app/lib/checkpoint-history.ts — セーブデータ（conversation_checkpoints）の要約に渡す会話の文（純関数）
// 2026-11-28 作業員L（統括役の決め3・申込以降を学びに使わない）: セーブデータの要約は会話の通をそのまま渡すので、記入済みの申込フォームの中身も要約に入り、
//   その要約は backfill-checkpoint-embeddings で埋め込まれる。CHECKPOINT_SKIP_APP_FORM=on（既定 off・段階で読む）の時だけ、記入済みの申込フォームの通は
//   中身を省いて「[申込フォーム（記入済み・中身は省く）]」の1行にする。off の時は今までの組み立てと1字も変わらない（試験 checkpoint-history）
import { isFilledApplicationForm } from "./post-apply";

export type CheckpointMsg = { sender: string; text: string | null; created_at: string; is_aix_generated?: boolean | null };
export const APP_FORM_PLACEHOLDER = "[申込フォーム（記入済み・中身は省く）]";
export function checkpointHistoryText(msgs: readonly CheckpointMsg[], fmtDate: (iso: string) => string, opts: { skipFilledForm?: boolean } = {}): string {
  return msgs
    .map((m) => {
      const role = m.sender === "customer" ? "顧客" : (m.is_aix_generated ? "スタッフ(AIX)" : "スタッフ");
      const body = opts.skipFilledForm && m.sender === "customer" && isFilledApplicationForm(m.text) ? APP_FORM_PLACEHOLDER : (m.text ?? "").slice(0, 600);
      return `${role} ${fmtDate(m.created_at as string)}: ${body}`;
    })
    .join("\n");
}
