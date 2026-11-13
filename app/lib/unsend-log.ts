// app/lib/unsend-log.ts — LINE の送信取り消しの控え（message_unsends）の1行を作る（純関数・作業員5・11/13）
//   統括役の案A（KB 6ad3a25f）: 取り消した通は messages から物理削除されるので、読みに「取り消した通」として渡す控えだけ残す。
//   本文は maskPII で伏せた頭40字だけ・申込以降の会話は残さない（呼ぶ側で status を渡す）。切替: UNSEND_LOG=on（既定 off）
import { maskPII } from "./pii-mask";

type Env = Record<string, string | undefined>;
export const unsendLogOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.UNSEND_LOG ?? "").trim().toLowerCase() === "on";
export const UNSEND_KEEP_DAYS = 30;
export const UNSEND_HEAD_CHARS = 40;

export type UnsendRow = { conversation_id: string; unsent_at: string; original_sent_at: string | null; sender: string | null; text_head: string | null };

/** 控えの1行（残さない時は null） */
export function unsendLogRow(o: { conversationId: string | null | undefined; sender: string | null | undefined; createdAt: string | null | undefined; text: string | null | undefined; postApply: boolean; nowIso?: string }): UnsendRow | null {
  if (!o.conversationId || o.postApply) return null;
  const raw = String(o.text ?? "").replace(/\s+/g, " ").trim();
  const head = raw ? maskPII(raw).slice(0, UNSEND_HEAD_CHARS) : null;
  return { conversation_id: o.conversationId, unsent_at: o.nowIso ?? new Date().toISOString(), original_sent_at: o.createdAt ?? null, sender: o.sender ?? null, text_head: head };
}
/** これより古い控えは消す（ISO） */
export const unsendPurgeBefore = (nowMs: number = Date.now()) => new Date(nowMs - UNSEND_KEEP_DAYS * 86_400_000).toISOString();
