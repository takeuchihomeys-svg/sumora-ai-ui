// app/lib/far-move-in-todo-server.ts — 入居の時期が先のお客様の AIX要対応（物件を送る）を【連絡日】の約束に置き換える（DB の読み書き）。決まりは far-move-in-todo.ts
//   TODO_FAR_MOVE_IN=on の時だけ呼ばれる（aix-action-items の「今回の発言に AIX は要らない」の道）。
import { supabase } from "@/app/lib/supabase-server";
import { contactEventRow } from "@/app/lib/contact-promise";
import { farMoveInOfTurns, moveInRangeLabel, contactYmdOf, FAR_MOVE_IN_TURN_MAX_DAYS } from "@/app/lib/far-move-in-todo";

/**
 * 開いている物件を送る要対応（id）を、お客様の入居の時期が先なら取り下げて【必ず】【連絡日】の行に置き換える。
 * 置き換えた時 true（読めない・時期が近い・言っていない時は false＝呼び手は今まで通り）。
 */
export async function replacePickupItemWithContactDate(o: { conversationId: string; customerName: string | null; itemId: string | number; nowMs?: number }): Promise<boolean> {
  const nowMs = o.nowMs ?? Date.now();
  const since = new Date(nowMs - FAR_MOVE_IN_TURN_MAX_DAYS * 86_400_000).toISOString();
  const { data: turns, error } = await supabase.from("messages").select("text, created_at")
    .eq("conversation_id", o.conversationId).eq("sender", "customer").gte("created_at", since)
    .or("text.ilike.%入居%,text.ilike.%引っ越%,text.ilike.%引越%,text.ilike.%転居%")
    .order("created_at", { ascending: false }).limit(30);
  if (error) { console.warn("[far-move-in] turns:", error.message); return false; }
  const plan = farMoveInOfTurns((turns ?? []) as Array<{ text: string | null; created_at: string }>, nowMs);
  if (!plan) return false;
  const range = moveInRangeLabel(plan);
  const ymd = contactYmdOf(plan);
  const nowIso = new Date(nowMs).toISOString();
  const { error: e1 } = await supabase.from("aix_action_items")
    .update({ status: "dismissed", dismissed_reason: "far_move_in_contact", resolution_note: `連絡の日 ${ymd} まで待つ（${range}入居）`.slice(0, 200), updated_at: nowIso })
    .eq("id", o.itemId).eq("status", "pending");
  if (e1) { console.warn("[far-move-in] dismiss:", e1.message); return false; }
  // 同じ会話に開いている【連絡日】の行が無ければ入れる（あれば日付はスタッフ・送った約束の物を残す）
  const { data: open } = await supabase.from("calendar_events").select("id")
    .eq("conversation_id", o.conversationId).eq("is_done", false).like("notes", "【必ず】%【連絡日 %").limit(1);
  if (!(open ?? []).length) {
    const row = contactEventRow(
      { contact: plan.contact, sentence: `（入居${range}のため連絡の日まで待つ・お客様「${plan.evidence}」）`, kind: "contact", moveInLabel: range },
      { customerName: o.customerName, conversationId: o.conversationId, sentAt: nowIso, moveInLabel: range },
    );
    const { error: e2 } = await supabase.from("calendar_events").insert(row);
    if (e2) console.warn("[far-move-in] contact row:", e2.message);
  }
  console.log(JSON.stringify({ tag: "aix-action-items:far-move-in-contact", conversationId: o.conversationId, contact: ymd, moveIn: range }));
  return true;
}
