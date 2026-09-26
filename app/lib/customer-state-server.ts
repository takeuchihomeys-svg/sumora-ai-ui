// app/lib/customer-state-server.ts
// お客様の状況（customer-state.ts の resolveCustomerState）の材料を DB から読む（サーバー専用）。
//   画面は GET /api/customer-state（内部認証）経由で読む。ブレイン・返信生成は getCustomerState を直接呼ぶ（段2・段3でつなぐ）。
//   読むだけ（書き込みなし）。1会話あたり 7 本のクエリを並列に投げる。
import { supabase } from "@/app/lib/supabase";
import {
  resolveCustomerState,
  type CustomerState, type CustomerStateInput, type CustomerStateMessage, type CustomerStateAixRow, type ViewingHistoryRow, type SentPropertyRow,
} from "@/app/lib/customer-state";
import type { RecordedFact, LedgerTask } from "@/app/lib/action-ledger";

/** 読む範囲（メッセージは新しい方から）。見積・内覧・申込の出来事は数か月前でも効くので広めに */
export const CUSTOMER_STATE_MESSAGE_LIMIT = 600;
export const CUSTOMER_STATE_AIX_LIMIT = 200;

export async function loadCustomerStateInput(conversationId: string, opts: { now?: number } = {}): Promise<CustomerStateInput | null> {
  const [conv, msgs, aix, facts, vh, sp, tasks] = await Promise.all([
    supabase.from("conversations").select("id, status, is_post_apply, status_manual_back_at, conversation_direction, property_customer_id").eq("id", conversationId).maybeSingle(),
    supabase.from("messages").select("sender, text, created_at, is_aix_generated, line_message_id").eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(CUSTOMER_STATE_MESSAGE_LIMIT),
    supabase.from("aix_usage_logs").select("aix_type, check_pattern, created_at, sent_at, line_message_id, generated_text, property_names, prop_statuses, estimate_sent, template_name").eq("conversation_id", conversationId).not("sent_at", "is", null).order("created_at", { ascending: false }).limit(CUSTOMER_STATE_AIX_LIMIT),
    supabase.from("sent_facts").select("sent_at, origin, aix_type, kind, status, line_message_id, detail, evidence").eq("conversation_id", conversationId).order("sent_at", { ascending: false }).limit(300),
    supabase.from("viewing_history").select("scheduled_date, scheduled_time, status, property_name, actual_date, viewing_report, created_at").eq("conversation_id", conversationId).order("scheduled_date", { ascending: false }).limit(30),
    supabase.from("sent_properties").select("property_name, room_no, sent_at").eq("conversation_id", conversationId).order("sent_at", { ascending: false }).limit(300),
    supabase.from("line_tasks").select("task_type, status, created_at, resolved_at, result").eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(30),
  ]);
  // 2026-09-26 反証レビュー: supabase は失敗を例外でなく error で返す。1本でも読めていない材料で決めると
  //   「初回・お部屋なし」「内覧の話なし」のような誤った事実を「こちらが正」としてブレイン・生成に渡してしまう
  //   （生成は status=viewing を提案中に畳み、ブレインは旧の【内覧履歴・予定】に戻らない）→ 読めなかったら投げて null（呼ぶ側は従来どおり）
  const failed = ([["conversations", conv], ["messages", msgs], ["aix_usage_logs", aix], ["sent_facts", facts], ["viewing_history", vh], ["sent_properties", sp], ["line_tasks", tasks]] as const)
    .filter(([, r]) => r.error).map(([name, r]) => `${name}: ${r.error?.message ?? "error"}`);
  if (failed.length) throw new Error(`read failed (${failed.join(" / ")})`);
  const c = conv.data as { status: string | null; is_post_apply: boolean | null; status_manual_back_at: string | null; conversation_direction: { current_phase?: string | null; updated_at?: string | null } | null; property_customer_id: string | null } | null;
  if (!c) return null;
  let situation: string | null = null;
  if (c.property_customer_id) {
    const { data: pc } = await supabase.from("property_customers").select("ai_summary_json").eq("id", c.property_customer_id).maybeSingle();
    const s = (pc?.ai_summary_json as { situation?: unknown } | null)?.situation;
    situation = typeof s === "string" && s.trim() ? s.trim() : null;
  }
  return {
    now: opts.now,
    status: c.status,
    isPostApply: c.is_post_apply,
    statusManualBackAt: c.status_manual_back_at,
    brainPhase: c.conversation_direction?.current_phase ?? null,
    brainPhaseUpdatedAt: c.conversation_direction?.updated_at ?? null,
    brainSituation: situation,
    messages: ((msgs.data ?? []) as Array<{ sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; line_message_id: string | null }>)
      .reverse().map((m): CustomerStateMessage => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: !!m.is_aix_generated, lineMessageId: m.line_message_id })),
    aixRows: ((aix.data ?? []) as CustomerStateAixRow[]).reverse(),
    recordedFacts: ((facts.data ?? []) as RecordedFact[]).reverse(),
    viewingHistory: (vh.data ?? []) as ViewingHistoryRow[],
    sentProperties: ((sp.data ?? []) as SentPropertyRow[]).reverse(),
    lineTasks: ((tasks.data ?? []) as Array<{ task_type: string; status: string; created_at: string | null; resolved_at: string | null; result: string | null }>)
      .map((t): LedgerTask => ({ task_type: t.task_type, status: t.status, created_at: t.created_at, completed_at: t.resolved_at, result: t.result })),
  };
}

/**
 * 1会話の今の状況（会話が無い・読み込みに失敗したら null・例外は投げない）。
 * 2026-09-26 反証レビュー: 旧は失敗時に空の状況（段階＝初回・お部屋なし・内覧なし）を返していた。空の状況は「読めなかった」と区別が付かず、
 *   ブレインには「今の段階: 初回・お部屋: まだ送った・話に出たお部屋なし（こちらが正）」、生成には「内覧の話なし」として届く → null にして呼ぶ側の従来の経路に戻す
 */
export async function getCustomerState(conversationId: string, opts: { now?: number } = {}): Promise<CustomerState | null> {
  try {
    const input = await loadCustomerStateInput(conversationId, opts);
    if (!input) return null;
    return resolveCustomerState(input);
  } catch (e) {
    console.warn("[customer-state] failed:", conversationId.slice(0, 8), e instanceof Error ? e.message : e);
    return null;
  }
}
