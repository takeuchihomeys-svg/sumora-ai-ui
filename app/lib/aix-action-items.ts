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
  meta: {
    action?: string | null; check_pattern?: string | null; reply_mode?: string | null; source?: string | null; analyzed_msg_ts?: string | null;
    condition_change_type?: string | null; first_contact_pickup?: string | null;
  } | null;
}): Promise<void> {
  const { conversationId, customerName, meta } = input;
  // cached は今回の顧客発言を見ていない判断なので使わない
  if (!meta || meta.source === "cached") return;
  // 初回（スタッフ未返信）でお客様が条件を送ってきた: action は出さない（挨拶下書き優先）が、ブレインが残した「物件ピックアップが必要」を使う
  const action = meta.action || meta.first_contact_pickup || null;
  // 実在の AIX ボタンだけ。reply_mode=aix（ブレインが AIX 必要と判断）か、初回の条件受領（first_contact_pickup）
  const needsAix = !!action && !!AIX_BUTTON_LABELS[action] && (meta.reply_mode === "aix" || !!meta.first_contact_pickup);
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
    if (open.action === action && (open.check_pattern ?? null) === checkPattern) {
      // 同じ指示は再通知しない。ただし物件ピックアップ待ちのままお客様が条件を変えた時は、新しい条件で検索し直す
      if (AIX_AUTO_SEARCH_ACTIONS.has(action!) && meta.condition_change_type) {
        await enqueueAixPropertySearch(conversationId, action!).catch((e) =>
          console.warn("[aix-action-items] re-enqueue on condition change failed:", conversationId, e instanceof Error ? e.message : e));
      }
      return;
    }
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
  if (AIX_AUTO_SEARCH_ACTIONS.has(action!)) {
    await enqueueAixPropertySearch(conversationId, action!).catch((e) =>
      console.warn("[aix-action-items] enqueue auto search failed:", conversationId, e instanceof Error ? e.message : e));
  }
}

/** AIX モード（拡張の AIX ボタン ON の PC）で自動の物件検索→売上番長グループ送信を行う AIX 指示 */
const AIX_AUTO_SEARCH_ACTIONS = new Set(["property_send", "property_recommendation", "property_search"]);
/** AIX 連動の自動検索で使う検索サイト（Web画面の「リアプロで検索」と同じキー） */
const AIX_AUTO_SEARCH_SITES = ["realnetpro"];

/**
 * AIX で物件ピックアップ・物件オススメの指示が出たお客さんの自動検索コマンドを積む（2026-09-12 竹内方針「AIXモード」）。
 * payload.source="aix" のコマンドは AIX モードの PC だけが claim する（/api/automation/pending ?aix=1）。
 * 物件出し顧客（property_customers）に紐付いていない会話は条件が無いので積まない。同じ顧客の未実行・実行中があれば積まない。
 */
async function enqueueAixPropertySearch(conversationId: string, action: string): Promise<void> {
  const { data: conv } = await supabase
    .from("conversations").select("property_customer_id, line_user_id").eq("id", conversationId).maybeSingle();
  let customerId = (conv?.property_customer_id as string | null | undefined) ?? null;
  // 紐付け漏れ（同じ LINE ID の物件顧客がいるのに conversations.property_customer_id が空）を補う。
  //   同じ LINE ID の物件顧客がちょうど1人の時だけ紐付ける（2人以上は誰か決められないので積まない）
  if (!customerId && conv?.line_user_id) {
    const { data: pcs } = await supabase
      .from("property_customers").select("id").eq("line_user_id", conv.line_user_id as string).limit(2);
    if (pcs && pcs.length === 1) {
      customerId = pcs[0].id as string;
      await supabase.from("conversations").update({ property_customer_id: customerId }).eq("id", conversationId).is("property_customer_id", null);
    }
  }
  if (!customerId) return;
  const { data: existing } = await supabase
    .from("automation_commands")
    .select("id")
    .in("status", ["pending", "running"])
    .contains("customer_ids", [customerId])
    .limit(1);
  if (existing && existing.length > 0) return;
  const { error } = await supabase.from("automation_commands").insert({
    command_type: "batch_property_search",
    customer_ids: [customerId],
    sites: AIX_AUTO_SEARCH_SITES,
    payload: { source: "aix", aix_action: action, conversation_id: conversationId, is_wide: false },
    status: "pending",
  });
  if (error) console.warn("[aix-action-items] automation insert failed:", error.message);
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
