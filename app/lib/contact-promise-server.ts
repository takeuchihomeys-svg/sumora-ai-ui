// app/lib/contact-promise-server.ts — 送った文の「連絡の日の約束」をカレンダー（calendar_events・【必ず】の約束と同じ行）に入れる／閉じる
// 2026-10-08 竹内さん「連絡する期間を約束したらカレンダーに入れる…その日に連絡するように約束後カレンダーに組み込む」
//   決まりは contact-promise.ts（純関数）。ここは DB の読み書きだけ。戻す: CONTACT_PROMISE_CALENDAR=off
//   申込ツール（screening-admin）のカレンダーへの連動は内覧の予定だけの決まり（screening-calendar-sync.shouldSyncViewingToScreening）なので、ここでは入れない（竹内さんに確認中）
import { supabase } from "@/app/lib/supabase";
import { parseContactPromise, contactEventRow, planContactPromiseSync, CONTACT_DATE_MARK_RE } from "@/app/lib/contact-promise";

export function contactPromiseCalendarOn(): boolean {
  return (process.env.CONTACT_PROMISE_CALENDAR ?? "").toLowerCase() !== "off";
}

/**
 * こちらの送信1通（手打ち・AIX・予約送信）でカレンダーの連絡の日の行を同期する。失敗しても送信は止めない（ログに contact-promise:failed）
 *   delivered: この送信で物件・御見積書を送った（送信時の記録の properties_sent / estimate_sent）
 */
export async function syncContactPromiseCalendar(o: { conversationId: string; text: string | null | undefined; sentAt: string; delivered: boolean }): Promise<void> {
  if (!contactPromiseCalendarOn()) return;
  try {
    const promise = parseContactPromise(o.text, o.sentAt);
    const { data: openRows, error } = await supabase.from("calendar_events").select("id, notes, is_done")
      .eq("conversation_id", o.conversationId).eq("is_done", false).like("notes", "【必ず】%【連絡日%").limit(20);
    if (error) throw new Error(error.message);
    const open = ((openRows ?? []) as Array<{ id: number; notes: string | null; is_done: boolean | null }>).filter((r) => CONTACT_DATE_MARK_RE.test(r.notes ?? ""));
    if (!promise && open.length === 0) return;
    const plan = planContactPromiseSync({ open, promise, sentAt: o.sentAt, delivered: o.delivered });
    if (plan.closeIds.length > 0) {
      const { error: e1 } = await supabase.from("calendar_events").update({ is_done: true }).in("id", plan.closeIds);
      if (e1) console.warn("[contact-promise] close failed:", e1.message);
    }
    let inserted: string | null = null;
    if (promise && plan.insert) {
      const { data: conv } = await supabase.from("conversations").select("customer_name, property_customer_id").eq("id", o.conversationId).maybeSingle();
      let moveInLabel: string | null = null;
      const pcId = (conv?.property_customer_id as string | null) ?? null;
      if (!promise.moveInLabel && pcId) {
        const { data: pc } = await supabase.from("property_customers").select("move_in_time").eq("id", pcId).maybeSingle();
        moveInLabel = ((pc?.move_in_time as string | null) ?? "").replace(/\s+/g, "").slice(0, 12) || null;
      }
      const row = contactEventRow(promise, { customerName: (conv?.customer_name as string | null) ?? null, conversationId: o.conversationId, sentAt: o.sentAt, moveInLabel });
      const { error: e2 } = await supabase.from("calendar_events").insert(row);
      if (e2) console.warn("[contact-promise] insert failed:", e2.message);
      else inserted = `${row.title} ${row.start_at}`;
    }
    if (plan.closeIds.length > 0 || inserted) console.log(JSON.stringify({ tag: "contact-promise:calendar", conversationId: o.conversationId, closed: plan.closeIds, inserted }));
  } catch (e) {
    console.error(JSON.stringify({ tag: "contact-promise:failed", conversationId: o.conversationId, error: e instanceof Error ? e.message : String(e) }));
  }
}
