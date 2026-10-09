// app/lib/promise-queue-server.ts — 約束の並び（promise-queue.ts）を DB から組み立て、AIX を1本送った後に次の AIX要対応を立てる
//
// 2026-10-09 竹内さん「読み込んで約束して、約束した事を記録して、それを AIX で送っていけば完全にできる」:
//   実測（scripts/audit-multi-request-turns.ts・60日）: 1通で2種類以上を約束した番の2本目以降の AIX は、前の AIX の後に要対応が立っていなかった
//   （log-aix-usage は要対応を済みにするだけでブレインを回し直さない＝残りの約束の AIX は次のお客様の発言まで立たない）。
//   → AIX の送信の後（log-aix-usage）と、返信の本文で要対応を済ませた後（send-line-message）に、約束の並びを組み立て直し、
//     まだ果たしていない約束があって今の要対応（ブレインの行）が無ければ、次の AIX を要対応に立てる（resolution_note=rule:promise_queue…）。
//   ブレインの判断とぶつかる時はブレインが勝つ（次のお客様の発言でブレインが違う AIX にしたら上書き・お客様が止まった/断ったら取り下げ＝aix-action-items）。
//   記録は増やさない: 約束は送った通の記録（sent_facts の約束の行・行動台帳）と通の本文に既にある＝毎回ここで組み立てる（DDL なし）。
//   戻す: 既定 off・PROMISE_QUEUE=on で入る
import { supabase } from "@/app/lib/supabase";
import { buildPromiseQueue, nextPromiseAix, promiseQueueEnabled, promiseQueueNote, promiseStepLabel, PROMISE_KIND_JA, type PromiseStep, type QueueAixLog, type QueueMsg } from "@/app/lib/promise-queue";
import { isTestConversation } from "@/app/lib/test-conversations";
import { MAIN_AIX_ITEM_OR } from "@/app/lib/viewing-day-greeting";

const WINDOW_DAYS = 7;

export async function loadPromiseQueue(conversationId: string, nowMs = Date.now(), extra?: { text: string; at: string } | null): Promise<PromiseStep[]> {
  const since = new Date(nowMs - (WINDOW_DAYS + 1) * 86_400_000).toISOString();
  const [{ data: msgs, error: mErr }, { data: logs, error: lErr }] = await Promise.all([
    supabase.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", conversationId).gte("created_at", since).order("created_at", { ascending: true }).limit(400),
    supabase.from("aix_usage_logs").select("aix_type, check_pattern, sent_at, created_at, estimate_sent, generated_text").eq("conversation_id", conversationId).gte("created_at", since).order("created_at", { ascending: true }).limit(100),
  ]);
  if (mErr || lErr) throw new Error(`promise-queue load: ${mErr?.message ?? lErr?.message}`);
  const qMsgs: QueueMsg[] = ((msgs ?? []) as Array<{ sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null }>)
    .map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: !!m.is_aix_generated }));
  // 送った直後（画面が messages に保存する前）の本文を足す（同じ本文が既にあれば足さない）
  if (extra?.text && !qMsgs.some((m) => m.sender !== "customer" && (m.text ?? "") === extra.text)) qMsgs.push({ sender: "staff", text: extra.text, createdAt: extra.at, isAix: false });
  const qLogs: QueueAixLog[] = ((logs ?? []) as Array<{ aix_type: string; check_pattern: string | null; sent_at: string | null; created_at: string; estimate_sent: boolean | null; generated_text: string | null }>)
    .map((l) => ({ aixType: l.aix_type, checkPattern: l.check_pattern, sentAt: l.sent_at ?? l.created_at, estimateSent: l.estimate_sent, text: l.generated_text }));
  return buildPromiseQueue(qMsgs, qLogs, nowMs, { windowDays: WINDOW_DAYS });
}

/**
 * 次の AIX要対応を立てる（立てたら true）。立てない: 戻した・申込以降・未果たしの約束が無い・ブレインの要対応がもう立っている。
 *   テストの会話（YUMA 等）は行だけ立てて売上番長グループへは送らない。
 */
export async function advancePromiseQueue(conversationId: string, o: { trigger: "aix" | "staff_text"; sentText?: string | null; sentAt?: string | null } = { trigger: "aix" }): Promise<boolean> {
  if (!promiseQueueEnabled()) return false;
  const { data: conv } = await supabase.from("conversations").select("customer_name, is_post_apply").eq("id", conversationId).maybeSingle();
  if (!conv || conv.is_post_apply) return false;
  const steps = await loadPromiseQueue(conversationId, Date.now(), o.sentText ? { text: o.sentText, at: o.sentAt ?? new Date().toISOString() } : null);
  const nx = nextPromiseAix(steps);
  if (!nx) return false;
  const { data: open } = await supabase.from("aix_action_items").select("id").eq("conversation_id", conversationId).eq("status", "pending").or(MAIN_AIX_ITEM_OR).limit(1);
  if (open && open.length) return false;
  const now = new Date().toISOString();
  const note = promiseQueueNote(nx.next, nx.rest);
  const { error } = await supabase.from("aix_action_items").insert({
    conversation_id: conversationId, customer_name: (conv.customer_name as string | null) || null, action: nx.next.action, check_pattern: nx.next.checkPattern,
    status: "pending", brain_analyzed_msg_ts: null, notified_at: now, resolution_note: note,
  });
  if (error) { if (!/duplicate|unique/i.test(error.message)) console.warn("[promise-queue] insert failed:", conversationId, error.message); return false; }
  console.log(JSON.stringify({ tag: "promise-queue:next", conversationId, trigger: o.trigger, next: nx.next.kind, action: nx.next.action, rest: nx.rest.map((s) => s.kind) }));
  if (!isTestConversation(conversationId)) {
    const { buildAixActionNotice, pushToHanbancyoGroup } = await import("@/app/lib/aix-action-items");
    const extra = `（約束の続き: ${PROMISE_KIND_JA[nx.next.kind]}${nx.rest.length ? `／残り ${nx.rest.map((s) => PROMISE_KIND_JA[s.kind]).join("・")}` : ""}）`;
    await pushToHanbancyoGroup(`${buildAixActionNotice((conv.customer_name as string | null) ?? "", nx.next.action, nx.next.checkPattern)}\n${extra}`);
  }
  return true;
}

/** 画面「約束の続き」用（次に送る AIX・残り・果たした物） */
export async function promiseQueueView(conversationId: string): Promise<{ next: string | null; rest: string[]; done: string[]; steps: PromiseStep[] }> {
  const steps = await loadPromiseQueue(conversationId);
  const nx = nextPromiseAix(steps);
  return {
    next: nx ? promiseStepLabel(nx.next) : null,
    rest: nx ? nx.rest.map(promiseStepLabel) : [],
    done: steps.filter((s) => s.status !== "pending").map((s) => `${PROMISE_KIND_JA[s.kind]}（${s.doneBy ?? "済み"}）`),
    steps,
  };
}
