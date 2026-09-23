// app/lib/post-apply.ts
// 「申込以降の会話か」を1か所で決める（別クラウドに回さない・マスク以前に送らない、の判定）。
//
// 2026-09-23 竹内「AIXの申込へボタンがトリガーにする。そうするとお客さんの個人情報（本人確認書類もここで届く）が渡らないのでより安全」
// 2026-09-23 竹内「一度申込にした人でも審査が否決となって再度物件提案中にもどる場合もあるから、その場合は渡してよい。
//   そうしたらまた申込までうごくかたちやから。ただ申込からの審査中は…重要な個人情報が入るかたちとなるからそこは deepseek にわたらないようにする」
//
// 【実物】これまでの判定は conversations.status だけ（llm-alt-provider.isPostApplyStatus）。
//   status は27.4%の会話でブレインの段階より遅れていて（申込昇格の画像の旗が0件）、
//   llm_usage_logs で数えると DeepSeek での返信生成 157回のうち **37回（6会話）が AIX【申込へ】押下・本人確認書類の後**、
//   AIX 物件オススメ（画像経路・歯止めが無かった）171回のうち 114回（5会話）が申込へ押下の後だった（scripts/audit-post-apply-gate.ts）。
//
// 【線】申込以降とみなす根拠（どれも決定論・記録から引ける）:
//   ① status が DRAFT_SKIP_STATUSES（従来。申込・審査中は必ずここ）
//   ② スタッフが付けた申込以降の印（conversations.is_post_apply）
//   ③ AIX【申込へ】（application_push）の最後の押下（aix_usage_logs）
//   ④ お客様からの本人確認書類の最後の受信（messages.image_type = 'id_document'）
//   ③④は押した・届いた瞬間に記録されるので、status の昇格を待たない。
//
// 【戻り】③④は**永続にしない**。否決などでスタッフが段階を戻した時刻（conversations.status_manual_back_at・
//   page.tsx の状態変更と「申込以降」の解除で付く）が ③④の最後より**後**なら、申込前に戻ったとみなして再び回してよい。
//   実物: 戻しの印がある9会話のうち8会話が申込へ押下の後の戻し（否決→物件提案中）。
//   その後また申込へを押せば ③ が戻しより新しくなるので、また申込以降になる。
//
// 【広げ方】⚠ ここで決めるのは「外に出さない」だけ。下書きを作る／作らない（DRAFT_SKIP_STATUSES）は別の事実なので触らない
//   （同じ集合にすると、申込へを押しただけの会話で下書きが止まる）。
//
// 【読めない時】fail-closed（申込以降＝外に出さない側へ倒す）。呼び出し側は loadPostApplyFacts の失敗を true 扱いにする。

import { DRAFT_SKIP_STATUSES } from "./conversation-status";

export type PostApplyFacts = {
  status: string | null | undefined;
  /** スタッフが付けた申込以降の印（conversations.is_post_apply） */
  isPostApply?: boolean | null;
  /** AIX【申込へ】を最後に押した時刻（ISO）。無ければ null */
  applicationPushAt?: string | null;
  /** お客様から本人確認書類が最後に届いた時刻（ISO）。無ければ null */
  idDocumentAt?: string | null;
  /** スタッフが段階を前に戻した時刻（conversations.status_manual_back_at）。無ければ null */
  statusManualBackAt?: string | null;
};

export type PostApplyReason = "status" | "badge" | "application_push" | "id_document" | null;

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
};

/** 申込以降の会話か（純関数）。理由も返す（ログ・監査用）。movedBack は「申込の記録はあるが、その後に戻した」 */
export function resolvePostApply(f: PostApplyFacts): { postApply: boolean; reason: PostApplyReason; movedBack: boolean } {
  if (DRAFT_SKIP_STATUSES.has((f.status ?? "").trim())) return { postApply: true, reason: "status", movedBack: false };
  if (f.isPostApply === true) return { postApply: true, reason: "badge", movedBack: false };
  const pushAt = ms(f.applicationPushAt), docAt = ms(f.idDocumentAt), backAt = ms(f.statusManualBackAt);
  const latest = Math.max(pushAt ?? -Infinity, docAt ?? -Infinity);
  if (!Number.isFinite(latest)) return { postApply: false, reason: null, movedBack: false };
  // 最後の申込の記録より後に戻していれば申込前（否決→物件提案中）。同時刻は「戻した」側に倒さない（記録が先）
  if (backAt !== null && backAt > latest) return { postApply: false, reason: null, movedBack: true };
  return { postApply: true, reason: latest === pushAt ? "application_push" : "id_document", movedBack: false };
}

export function isPostApplyConversation(f: PostApplyFacts): boolean {
  return resolvePostApply(f).postApply;
}

// supabase-js の型をそのまま受けると TS2589（型の展開が深すぎる）になるので、使う形だけを緩く受ける
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = { from: (table: string) => any };
type Res = { data: unknown; error: { message: string } | null };

/**
 * 記録から根拠を引く。**どれか1つでも読めなければ例外**（呼び出し側は申込以降＝外に出さない側へ倒す）。
 * 3クエリだが全部 index のある列（conversation_id）で軽い。
 */
export async function loadPostApplyFacts(sb: Sb, conversationId: string): Promise<PostApplyFacts> {
  const [conv, push, idDoc] = (await Promise.all([
    sb.from("conversations").select("status, is_post_apply, status_manual_back_at").eq("id", conversationId).maybeSingle(),
    sb.from("aix_usage_logs").select("created_at").eq("conversation_id", conversationId).eq("aix_type", "application_push").order("created_at", { ascending: false }).limit(1),
    sb.from("messages").select("created_at").eq("conversation_id", conversationId).eq("sender", "customer").eq("image_type", "id_document").order("created_at", { ascending: false }).limit(1),
  ])) as [Res, Res, Res];
  if (conv.error) throw new Error(`post-apply: conversations: ${conv.error.message}`);
  if (push.error) throw new Error(`post-apply: aix_usage_logs: ${push.error.message}`);
  if (idDoc.error) throw new Error(`post-apply: messages: ${idDoc.error.message}`);
  const row = (conv.data ?? null) as { status?: string | null; is_post_apply?: boolean | null; status_manual_back_at?: string | null } | null;
  const first = (r: Res): string | null => (((r.data ?? []) as Array<{ created_at?: string | null }>)[0]?.created_at ?? null);
  return {
    status: row?.status ?? null,
    isPostApply: row?.is_post_apply === true,
    applicationPushAt: first(push),
    idDocumentAt: first(idDoc),
    statusManualBackAt: row?.status_manual_back_at ?? null,
  };
}
