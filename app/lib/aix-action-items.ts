// app/lib/aix-action-items.ts
// 売上番長グループの「AIX要対応」（2026-09-12 竹内方針）
//   「AIXの要対応がスタッフが特に行う部分。売上番長のグループに送られるのはAIX要対応の指示だけ。
//    お客さん名と【AIX】ボタンの種類の指示がLINEで届く。物件出しのように一覧をつくって完了したら✅」
//
// 1会話につき未完了（pending）は1件。判断者はブレインだけ（[[feedback-brain-owns-aix]]）:
//   登録・1件通知  … brain-core runBrainAndNotify（ブレインが今回の顧客発言を見て AIX 必要と判断した時）
//   不要になった   … 同じく runBrainAndNotify（ブレインが AIX なしと判断し直した時 → dismissed。通知しない）
//   完了（✅）     … log-aix-usage（その会話でスタッフが AIX を送った時）
//   定時一覧       … cron/announce-aix-actions（10:30〜20:30 の2時間ごと）
import { supabase } from "@/app/lib/supabase";
import { buildAixActionNotice } from "@/app/lib/aix-action-text";
import { AIX_BUTTON_LABELS } from "@/app/lib/aix-taxonomy";
export { aixButtonText, buildAixActionNotice, buildAixActionList, type AixActionItemRow } from "@/app/lib/aix-action-text";

/** 売上番長グループへ push（宛先・トークンの決め方は notify-group と同じ: env → hanbancyo_settings.group_id） */
export async function pushToHanbancyoGroup(text: string): Promise<boolean> {
  let targetId = process.env.LINE_STAFF_GROUP_ID || null;
  if (!targetId) {
    const { data } = await supabase.from("hanbancyo_settings").select("value").eq("key", "group_id").maybeSingle();
    targetId = (data?.value as string | undefined) ?? null;
  }
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ?? process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN;
  if (!targetId || !token) return false;
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: targetId, messages: [{ type: "text", text }] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) console.warn("[aix-action-items] push failed:", res.status, await res.text().catch(() => ""));
  return res.ok;
}

/**
 * ブレインの最新判断（今回の顧客発言を見た判断のみ）を AIX要対応に反映する。
 *   AIX あり → 未完了が無ければ登録して1件通知／違う AIX に変わったら更新して1件通知／同じなら何もしない
 *   AIX なし → 未完了があれば dismissed（ブレインが不要と判断し直した。通知しない）
 */
export async function syncAixActionItem(input: {
  conversationId: string;
  customerName: string;
  meta: { action?: string | null; check_pattern?: string | null; reply_mode?: string | null; source?: string | null; analyzed_msg_ts?: string | null } | null;
}): Promise<void> {
  const { conversationId, customerName, meta } = input;
  // cached は今回の顧客発言を見ていない判断なので使わない
  if (!meta || meta.source === "cached") return;
  const action = meta.action || null;
  // 初回返信（reply_mode=null）は人の挨拶返信で、AIX要対応ではない。実在の AIX ボタンだけ（画面の AIX バッジ isAixBadge と同じ条件）
  const needsAix = !!action && !!AIX_BUTTON_LABELS[action] && meta.reply_mode === "aix";
  const checkPattern = meta.check_pattern ?? null;

  const { data: open } = await supabase
    .from("aix_action_items")
    .select("id, action, check_pattern")
    .eq("conversation_id", conversationId)
    .eq("status", "pending")
    .maybeSingle();
  const now = new Date().toISOString();

  if (!needsAix) {
    if (open) {
      await supabase.from("aix_action_items")
        .update({ status: "dismissed", dismissed_reason: "brain_no_aix", updated_at: now })
        .eq("id", open.id).eq("status", "pending");
    }
    return;
  }

  if (open) {
    if (open.action === action && (open.check_pattern ?? null) === checkPattern) return; // 同じ指示は再通知しない
    await supabase.from("aix_action_items")
      .update({ action, check_pattern: checkPattern, customer_name: customerName || null, brain_analyzed_msg_ts: meta.analyzed_msg_ts ?? null, notified_at: now, updated_at: now })
      .eq("id", open.id).eq("status", "pending");
  } else {
    const { error } = await supabase.from("aix_action_items").insert({
      conversation_id: conversationId, customer_name: customerName || null, action, check_pattern: checkPattern,
      status: "pending", brain_analyzed_msg_ts: meta.analyzed_msg_ts ?? null, notified_at: now,
    });
    // 同時実行で一意制約（1会話1件の pending）に当たった＝もう一方が登録・通知済み
    if (error) { if (!/duplicate|unique/i.test(error.message)) console.warn("[aix-action-items] insert failed:", error.message); return; }
  }
  await pushToHanbancyoGroup(buildAixActionNotice(customerName, action!, checkPattern));
}

/** スタッフがその会話で AIX を送った → 未完了を完了（✅）にする。押した AIX がブレインの指示と同じかも残す */
export async function completeAixActionItem(conversationId: string, aixType: string): Promise<void> {
  const { data: open } = await supabase
    .from("aix_action_items")
    .select("id, action")
    .eq("conversation_id", conversationId)
    .eq("status", "pending")
    .maybeSingle();
  if (!open) return;
  const norm = (x: string) => (x === "property_check" ? "property_check_result" : x);
  const now = new Date().toISOString();
  await supabase.from("aix_action_items")
    .update({ status: "done", done_at: now, done_aix_type: aixType, done_matched: norm(open.action) === norm(aixType), updated_at: now })
    .eq("id", open.id).eq("status", "pending");
}
