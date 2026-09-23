// app/lib/post-apply.ts
// 「申込以降の会話か」を1か所で決める（別クラウドに回さない・マスク以前に送らない、の判定）。
//
// 2026-09-23 竹内「AIXの申込へボタンがトリガーにする。そうするとお客さんの個人情報（本人確認書類もここで届く）が渡らないのでより安全」
//
// 【実物】これまでの判定は conversations.status だけ（llm-alt-provider.isPostApplyStatus）。
//   status は27.4%の会話でブレインの段階より遅れていて（申込昇格の画像の旗が0件）、
//   llm_usage_logs で数えると DeepSeek での返信生成 156回のうち **38回（7会話）が AIX【申込へ】押下の後**、
//   12回は本人確認書類が届いた後だった（scripts/audit-post-apply-gate.ts）。
//
// 【線】申込以降とみなす根拠を4つの OR にする（どれも決定論・記録から引ける）:
//   ① status が DRAFT_SKIP_STATUSES（従来）
//   ② スタッフが付けた申込以降の印（conversations.is_post_apply）
//   ③ AIX【申込へ】（application_push）を一度でも押した会話（aix_usage_logs）
//   ④ お客様から本人確認書類（messages.image_type = 'id_document'）が届いた会話
//   ③④は押した・届いた瞬間に記録されるので、status の昇格を待たない。
//
// 【広げ方】現状（339会話）で新たに申込以降になるのは 31会話（③）＋3会話（④・押していないが書類あり）。
//   ⚠ ここで決めるのは「外に出さない」だけ。下書きを作る／作らない（DRAFT_SKIP_STATUSES）は別の事実なので触らない
//   （同じ集合にすると、申込へを押しただけの会話で下書きが止まる）。
//
// 【読めない時】fail-closed（申込以降＝外に出さない側へ倒す）。呼び出し側は loadPostApplyFacts の失敗を true 扱いにする。

import { DRAFT_SKIP_STATUSES } from "./conversation-status";

export type PostApplyFacts = {
  status: string | null | undefined;
  /** スタッフが付けた申込以降の印（conversations.is_post_apply） */
  isPostApply?: boolean | null;
  /** AIX【申込へ】を押した記録があるか（aix_usage_logs.aix_type = 'application_push'） */
  applicationPushPressed?: boolean | null;
  /** お客様から本人確認書類が届いたか（messages.image_type = 'id_document'） */
  idDocumentReceived?: boolean | null;
};

/** 申込以降の会話か（純関数）。理由も返す（ログ・監査用） */
export function resolvePostApply(f: PostApplyFacts): { postApply: boolean; reason: "status" | "badge" | "application_push" | "id_document" | null } {
  if (DRAFT_SKIP_STATUSES.has((f.status ?? "").trim())) return { postApply: true, reason: "status" };
  if (f.isPostApply === true) return { postApply: true, reason: "badge" };
  if (f.applicationPushPressed === true) return { postApply: true, reason: "application_push" };
  if (f.idDocumentReceived === true) return { postApply: true, reason: "id_document" };
  return { postApply: false, reason: null };
}

export function isPostApplyConversation(f: PostApplyFacts): boolean {
  return resolvePostApply(f).postApply;
}

// supabase-js の型をそのまま受けると TS2589（型の展開が深すぎる）になるので、使う形だけを緩く受ける
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = { from: (table: string) => any };
type Res = { data: unknown; error: { message: string } | null };

/**
 * 記録から4つの根拠を引く。**どれか1つでも読めなければ例外**（呼び出し側は申込以降＝外に出さない側へ倒す）。
 * 3クエリだが全部 index のある列（conversation_id）で軽い。
 */
export async function loadPostApplyFacts(sb: Sb, conversationId: string): Promise<PostApplyFacts> {
  const [conv, push, idDoc] = (await Promise.all([
    sb.from("conversations").select("status, is_post_apply").eq("id", conversationId).maybeSingle(),
    sb.from("aix_usage_logs").select("id").eq("conversation_id", conversationId).eq("aix_type", "application_push").limit(1),
    sb.from("messages").select("id").eq("conversation_id", conversationId).eq("image_type", "id_document").limit(1),
  ])) as [Res, Res, Res];
  if (conv.error) throw new Error(`post-apply: conversations: ${conv.error.message}`);
  if (push.error) throw new Error(`post-apply: aix_usage_logs: ${push.error.message}`);
  if (idDoc.error) throw new Error(`post-apply: messages: ${idDoc.error.message}`);
  const row = (conv.data ?? null) as { status?: string | null; is_post_apply?: boolean | null } | null;
  return {
    status: row?.status ?? null,
    isPostApply: row?.is_post_apply === true,
    applicationPushPressed: ((push.data ?? []) as unknown[]).length > 0,
    idDocumentReceived: ((idDoc.data ?? []) as unknown[]).length > 0,
  };
}
