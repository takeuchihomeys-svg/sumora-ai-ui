// app/lib/brain-meta-load.ts
// 生成（返信・AIX 文面・テンプレ）がブレインの判断を読む時の共通の入口（サーバー専用）。
// 判定は brain-meta-restore.ts の restoreMetaAfterShown（純関数）。ここは DB から「最新のお客様発言の時刻」を読むだけ。
import { supabase } from "@/app/lib/supabase";
import { BRAIN_SKIP_STATUSES } from "@/app/lib/conversation-status";
import { restoreMetaAfterShown, staffTurnStillOpen, SHOWN_DRAFT_SENTINEL, type ShownRestoreResult } from "@/app/lib/brain-meta-restore";

export type BrainMetaRow = {
  suggested_aix_meta?: unknown;
  last_brain_meta?: unknown;
  ai_draft?: string | null;
  status?: string | null;
};

/** 続きの番（AIX の後の2通目）でブレインの判断を戻してよい、スタッフの番の長さ（お客様の発言の後のスタッフの最初の送信から） */
export const AIX_TEMPLATE_BRAIN_TURN_MS = 2 * 60 * 60 * 1000;

/** conversations の select に足す列（suggested_aix_meta と一緒に読む） */
export const BRAIN_META_RESTORE_COLUMNS = "suggested_aix_meta, last_brain_meta, ai_draft, status";

/**
 * suggested_aix_meta が表示で消えただけなら last_brain_meta から戻した判断を返す（戻した時は brain:meta-restored をログ）。
 * それ以外は suggested_aix_meta をそのまま返す。DB 読み取りに失敗しても生成は止めない（戻さないだけ）。
 */
export async function resolveBrainMetaForGeneration(
  conversationId: string,
  row: BrainMetaRow | null,
  route: string,
  opts: { afterStaffSend?: boolean } = {},
): Promise<ShownRestoreResult> {
  // 2026-10-14 竹内さん「AIX の後の返信（AIX テンプレート）をブレイン基準に」: AIX の1通目を送ると画面が suggested_aix_meta と ai_draft を消す（page.tsx の送信）。
  //   その直後の2通目（aix-template-generate）は同じスタッフの番の続きなのに、表示の印（__SHOWN__）が無いので戻さず「ブレインなし」で作っていた
  //   （10/08〜10/14 の ✨ 生成 51回中 49回が brain=none・うち 42回は最新のお客様発言を見たブレインの判断があった）。
  //   続きの番（afterStaffSend）では、表示の印が無くても同じ線（最新のお客様発言を見た判断・申込以降でない・戻せる出どころ）で last_brain_meta から戻す。
  //   戻す AIX_TEMPLATE_BRAIN_RESTORE=off
  const continuing = !!opts.afterStaffSend && (process.env.AIX_TEMPLATE_BRAIN_RESTORE ?? "").toLowerCase() !== "off"
    && !row?.suggested_aix_meta && row?.ai_draft !== SHOWN_DRAFT_SENTINEL && !!row?.last_brain_meta;
  if (continuing) row = { ...row, ai_draft: SHOWN_DRAFT_SENTINEL };
  const base = {suggestedAixMeta: row?.suggested_aix_meta ?? null, lastBrainMeta: row?.last_brain_meta ?? null, aiDraft: row?.ai_draft ?? null, status: row?.status ?? null, skipStatuses: BRAIN_SKIP_STATUSES };
  // 表示済みで判断が空の時だけ最新のお客様発言を読む（それ以外は DB を余計に読まない）
  if (row?.suggested_aix_meta || row?.ai_draft !== SHOWN_DRAFT_SENTINEL) {
    return restoreMetaAfterShown({ ...base, latestCustomerMsgAt: null });
  }
  let latestCustomerMsgAt: string | null = null;
  try {
    const { data } = await supabase.from("messages").select("created_at")
      .eq("conversation_id", conversationId).eq("sender", "customer")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    latestCustomerMsgAt = (data?.created_at as string | undefined) ?? null;
  } catch { /* 戻さない */ }
  let result = restoreMetaAfterShown({ ...base, latestCustomerMsgAt });
  // 2026-10-14 独立レビュー（穴:G6 古い判断の注入・ac4966f6）: 続きの番で戻すのは、今のスタッフの番がその判断の見たお客様の発言に答えている時だけ。
  //   AIX_META_PATCH が止まり（10/13）last_brain_meta は次のお客様の発言まで残るので、鮮度（最新のお客様発言を見た）だけでは
  //   何日も前の判断・別の番の返信方向が戻る（✨ 14日 149回のうち 83回は、お客様の発言の後のスタッフの最初の送信から 12時間超＝別の番）。
  //   お客様の発言の後のスタッフの最初の送信が AIX_TEMPLATE_BRAIN_TURN_MS（既定2時間）より前なら戻さない（読めない時も戻さない）
  if (continuing && result.restored && latestCustomerMsgAt) {
    let firstStaffMs: number | null = NaN;
    try {
      const { data: firstStaff, error } = await supabase.from("messages").select("created_at")
        .eq("conversation_id", conversationId).neq("sender", "customer").gt("created_at", latestCustomerMsgAt)
        .order("created_at", { ascending: true }).limit(1).maybeSingle();
      if (!error) firstStaffMs = firstStaff?.created_at ? Date.parse(String(firstStaff.created_at)) : null;
    } catch { /* 読めない → 戻さない */ }
    if (!staffTurnStillOpen(firstStaffMs, Date.now(), AIX_TEMPLATE_BRAIN_TURN_MS)) {
      result = { meta: null, restored: false, reason: "other_turn" };
    }
  }
  console.log(JSON.stringify({
    tag: result.restored ? "brain:meta-restored" : "brain:meta-not-restored", route, conversationId, reason: continuing ? `after_staff_send:${result.reason}` : result.reason,
    analyzed_msg_ts: (result.meta?.analyzed_msg_ts as string | undefined) ?? null, latestCustomerMsgAt,
  }));
  return result;
}
