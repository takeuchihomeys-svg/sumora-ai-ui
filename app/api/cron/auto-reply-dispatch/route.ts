import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { canAutoReply, resolveAutoSendAt, type AutoReplyInput } from "@/app/lib/auto-reply-policy";

export const maxDuration = 60;

// GET /api/cron/auto-reply-dispatch（毎分）
//
// 2026-09-18 竹内「自動ボタンに切り替えたお客さんは AIX以外自動で返信されるようにする」
//   「今セットされる返信を自動返信として送る形」＝ conversations.ai_draft をそのまま予約に積む。
//
// ここは**予約を積むだけ**。実際の LINE 送信は既存の /api/send-scheduled-messages（毎分・
// アトミッククレーム・失敗記録・messages 記録・約束カレンダー同期つき）が行う。
// 送信の仕組みを二重に作らない（設計知見「入口は1つの関数にまとめる」）。
//
// 送ってよいかの判定は app/lib/auto-reply-policy.ts の canAutoReply 1か所（四者同名）。
// **切り替えていない会話（auto_send_enabled が NULL / false）は絶対に送らない。**

type ConvRow = {
  id: string;
  line_user_id: string | null;
  account: string | null;
  status: string | null;
  last_sender: string | null;
  ai_draft: string | null;
  ai_draft_check: unknown;
  suggested_aix_meta: unknown;
  auto_send_enabled: boolean | null;
  updated_at: string | null;
};

/** 最終チェックの結果に block があるか（ai_draft_check の形は経路で揺れるので広めに読む） */
function hasBlock(check: unknown): boolean {
  if (!check || typeof check !== "object") return false;
  const c = check as Record<string, unknown>;
  if (c.ok === false) return true;
  const items = Array.isArray(c.issues) ? c.issues : Array.isArray(c.items) ? c.items : [];
  return items.some((it) => {
    if (!it || typeof it !== "object") return false;
    const sev = (it as Record<string, unknown>).severity;
    return sev === "block" || sev === "error";
  });
}

function metaOf(meta: unknown): { replyMode: string | null; action: string | null } {
  if (!meta || typeof meta !== "object") return { replyMode: null, action: null };
  const m = meta as Record<string, unknown>;
  const action = typeof m.action === "string" && m.action.trim() ? m.action.trim() : null;
  const replyMode = typeof m.reply_mode === "string" ? m.reply_mode : null;
  return { replyMode, action };
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const nowIso = new Date().toISOString();

  // 切り替えた会話だけを見る（ここが唯一の入口。NULL/false は SQL の時点で入ってこない）
  const { data, error } = await supabase
    .from("conversations")
    .select("id, line_user_id, account, status, last_sender, ai_draft, ai_draft_check, suggested_aix_meta, auto_send_enabled, updated_at")
    .eq("auto_send_enabled", true)
    .eq("last_sender", "customer")
    .not("ai_draft", "is", null)
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const convs = (data ?? []) as ConvRow[];
  if (!convs.length) return NextResponse.json({ ok: true, scheduled: 0, checked: 0 });

  // 未送信の予約がある会話（二重送信を防ぐ）
  const { data: pend } = await supabase
    .from("scheduled_messages")
    .select("conversation_id")
    .in("status", ["pending", "sending"])
    .in("conversation_id", convs.map((c) => c.id));
  const pendingIds = new Set((pend ?? []).map((p) => p.conversation_id as string));

  let scheduled = 0;
  const skipped: Record<string, number> = {};

  for (const c of convs) {
    const { replyMode, action } = metaOf(c.suggested_aix_meta);
    const input: AutoReplyInput = {
      autoSendEnabled: c.auto_send_enabled,
      lastSender: c.last_sender,
      replyMode,
      suggestedAixAction: action,
      draft: c.ai_draft,
      draftHasBlock: hasBlock(c.ai_draft_check),
      status: c.status,
      hasPendingScheduled: pendingIds.has(c.id),
    };
    const verdict = canAutoReply(input);
    if (!verdict.ok) { skipped[verdict.reason] = (skipped[verdict.reason] ?? 0) + 1; continue; }
    if (!c.line_user_id) { skipped["no_line_user"] = (skipped["no_line_user"] ?? 0) + 1; continue; }

    // お客様の最後の発言時刻（ここから待ち時間を数える）
    const { data: lastMsg } = await supabase
      .from("messages")
      .select("created_at")
      .eq("conversation_id", c.id)
      .eq("sender", "customer")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const customerMsgAt = (lastMsg?.created_at as string | undefined) ?? c.updated_at ?? nowIso;

    const draft = (c.ai_draft ?? "").trim();
    const plan = resolveAutoSendAt({ customerMsgAt, draft, nowIso, seedKey: c.id });

    const { error: insErr } = await supabase.from("scheduled_messages").insert({
      conversation_id: c.id,
      line_user_id: c.line_user_id,
      account: c.account ?? "sumora",
      text: draft,
      scheduled_at: plan.sendAt,
      status: "pending",
      is_aix: false,
    });
    if (insErr) { skipped["insert_failed"] = (skipped["insert_failed"] ?? 0) + 1; continue; }

    pendingIds.add(c.id);
    scheduled++;
    console.log(JSON.stringify({
      tag: "auto-reply:scheduled", conversationId: c.id,
      delayMinutes: plan.delayMinutes, shifted: plan.shifted, sendAt: plan.sendAt,
      chars: draft.replace(/\s/g, "").length,
    }));
  }

  if (Object.keys(skipped).length) console.log(JSON.stringify({ tag: "auto-reply:skipped", skipped }));
  return NextResponse.json({ ok: true, checked: convs.length, scheduled, skipped });
}
