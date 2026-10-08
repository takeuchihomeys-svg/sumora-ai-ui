// app/lib/viewing-morning-greeting-server.ts — 内覧当日の朝の挨拶の要対応（サーバー専用）
//
// 2026-10-08 竹内さん「作る」: 待ち合わせ場所の AIX で確定した内覧の日の朝（cron /api/cron/viewing-morning-greeting・JST 9:15）に、
//   まだ当日の内覧挨拶（AIX【内覧挨拶→内覧前】）を送っていない・取りやめていない会話について AIX要対応を立て、売上番長グループに1件ずつ通知する。
//   決めるのは viewing-day-greeting.morningViewingGreetingPlan（純関数）・材料は行動台帳（ブレインと同じ buildActionLedger）。
//   送ったら自動で済み（AIX → completeAixActionItem／普通の送信の挨拶 → completeAixActionItemByStaffText）。前の日の残りはここで取り下げる。
//   dryRun=true は読むだけ（登録・通知・取り下げをしない）＝監査とテスト用
import { supabase } from "@/app/lib/supabase";
import { buildActionLedger, type LedgerAixRow } from "@/app/lib/action-ledger";
import { loadCustomerStateInput } from "@/app/lib/customer-state-server";
import { isPostApplyStatus } from "@/app/lib/llm-alt-provider";
import { morningViewingGreetingPlan, morningGreetingNoticeLine, VIEWING_MORNING_GREETING_PATTERN, type MorningGreetingWhy } from "@/app/lib/viewing-day-greeting";
import { registerRuleAixActionItem } from "@/app/lib/aix-action-items";
import { isTestConversation } from "@/app/lib/test-conversations";

const DAY = 86_400_000;
const jstYmd = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);

export type MorningGreetingRow = { conversationId: string; customerName: string; why: MorningGreetingWhy | "read_failed"; appointment: string | null; registered: boolean };

/** 候補の会話（30日以内に待ち合わせを送った・今日の内覧の予定がある） */
async function candidateConversations(nowMs: number): Promise<string[]> {
  const since = new Date(nowMs - 30 * DAY).toISOString();
  const today = jstYmd(nowMs);
  const dayStart = new Date(Date.parse(`${today}T00:00:00+09:00`)).toISOString();
  const dayEnd = new Date(Date.parse(`${today}T00:00:00+09:00`) + DAY).toISOString();
  const [aix, facts, cal] = await Promise.all([
    supabase.from("aix_usage_logs").select("conversation_id").eq("aix_type", "meeting_place").not("sent_at", "is", null).gte("created_at", since).limit(1000),
    supabase.from("sent_facts").select("conversation_id").eq("kind", "meeting_place_sent").gte("sent_at", since).limit(1000),
    supabase.from("calendar_events").select("conversation_id").eq("event_type", "viewing").gte("start_at", dayStart).lt("start_at", dayEnd).limit(500),
  ]);
  const ids = new Set<string>();
  for (const r of [...(aix.data ?? []), ...(facts.data ?? []), ...(cal.data ?? [])] as Array<{ conversation_id: string | null }>) if (r.conversation_id && !isTestConversation(String(r.conversation_id))) ids.add(String(r.conversation_id));   // YUMA・社内は only で明示した時だけ
  return [...ids];
}

/** 前の日（JST）に立てた内覧挨拶（内覧前）の未完了を取り下げる（その日の内覧は過ぎた） */
async function dismissPastGreetingItems(nowMs: number, dryRun: boolean): Promise<number> {
  const todayStart = new Date(Date.parse(`${jstYmd(nowMs)}T00:00:00+09:00`)).toISOString();
  const { data } = await supabase.from("aix_action_items").select("id").eq("status", "pending").eq("action", "greeting_viewing")
    .eq("check_pattern", VIEWING_MORNING_GREETING_PATTERN).lt("created_at", todayStart).limit(200);
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (!dryRun && ids.length) {
    await supabase.from("aix_action_items").update({ status: "dismissed", dismissed_reason: "viewing_day_passed", updated_at: new Date(nowMs).toISOString() })
      .in("id", ids).eq("status", "pending");
  }
  return ids.length;
}

export async function runViewingMorningGreeting(opts: { nowMs?: number; dryRun?: boolean; only?: string[]; ignorePending?: boolean } = {}): Promise<{ rows: MorningGreetingRow[]; dismissed: number }> {
  const nowMs = opts.nowMs ?? Date.now();
  const dryRun = !!opts.dryRun;
  const dismissed = await dismissPastGreetingItems(nowMs, dryRun);
  const ids = opts.only?.length ? opts.only : await candidateConversations(nowMs);
  const rows: MorningGreetingRow[] = [];
  const todayDay = Math.floor((nowMs + 9 * 3600_000) / DAY);
  for (const id of ids) {
    let input: Awaited<ReturnType<typeof loadCustomerStateInput>> = null;
    try { input = await loadCustomerStateInput(id, { now: nowMs }); } catch { input = null; }
    const [{ data: conv }, { data: open }] = await Promise.all([
      supabase.from("conversations").select("customer_name").eq("id", id).maybeSingle(),
      supabase.from("aix_action_items").select("action, check_pattern").eq("conversation_id", id).eq("status", "pending").maybeSingle(),
    ]);
    const customerName = String((conv as { customer_name?: string | null } | null)?.customer_name ?? "");
    if (!input) { rows.push({ conversationId: id, customerName, why: "read_failed", appointment: null, registered: false }); continue; }
    // 監査（過去の朝で dryRun）でも同じ線になるよう、その時刻より後の材料は読まない（本番では何も落ちない）
    const before = (iso: string | null | undefined) => { const x = Date.parse(String(iso ?? "")); return !Number.isFinite(x) || x <= nowMs; };
    const messages = input.messages.filter((m) => before(m.createdAt)).map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.createdAt, isAix: m.isAix, lineMessageId: m.lineMessageId ?? null }));
    const ledger = buildActionLedger({
      recentAixRows: (input.aixRows as unknown as LedgerAixRow[]).filter((r) => before(r.sent_at ?? r.created_at)),
      messages,
      lineTasks: (input.lineTasks ?? []).filter((x) => before(x.created_at)),
      recordedFacts: (input.recordedFacts ?? []).filter((f) => before(f.sent_at)),
      lastCustomerAt: [...messages].reverse().find((m) => m.sender === "customer")?.createdAt ?? null,
      now: nowMs,
    });
    const appt = ledger.facts.viewingAppointment;
    const aixTypesToday = (input.aixRows as Array<{ aix_type?: string | null; created_at?: string | null }>).filter((r) => before(r.created_at))
      .filter((r) => Math.floor((Date.parse(String(r.created_at ?? "")) + 9 * 3600_000) / DAY) === todayDay).map((r) => String(r.aix_type ?? ""));
    const plan = morningViewingGreetingPlan({
      appointmentDay: appt?.day ?? null,
      flowConfirmed: ledger.facts.viewingFlow ? ledger.facts.viewingFlow.confirmed : null,
      flowCancelled: /cancelled/.test(ledger.facts.viewingFlow?.reason ?? ""),
      appointmentTime: appt?.time ?? null,
      postApply: isPostApplyStatus(input.status),
      pending: opts.ignorePending ? null : (open as { action: string; check_pattern: string | null } | null) ?? null,
      staffMessages: messages.filter((m) => m.sender !== "customer").map((m) => ({ text: m.text, createdAt: m.createdAt ?? "" })),
      aixTypesToday,
      nowMs,
    });
    const apptLabel = appt ? `${appt.dateMD ?? "?"} ${appt.time ?? ""} ${appt.place ?? ""}`.trim() : null;
    let registered = false;
    if (plan.register && !dryRun) {
      registered = await registerRuleAixActionItem({
        conversationId: id, customerName, action: "greeting_viewing", checkPattern: VIEWING_MORNING_GREETING_PATTERN,
        noticeExtra: morningGreetingNoticeLine({ time: appt?.time ?? null, place: appt?.place ?? null }),
        note: `rule:viewing_morning_greeting ${apptLabel ?? ""}`,
      });
    }
    rows.push({ conversationId: id, customerName, why: plan.why, appointment: apptLabel, registered });
  }
  console.log(JSON.stringify({ tag: "viewing-morning-greeting", dryRun, candidates: ids.length, dismissed, due: rows.filter((r) => r.why === "due").length, registered: rows.filter((r) => r.registered).length,
    whys: rows.reduce<Record<string, number>>((a, r) => { a[r.why] = (a[r.why] ?? 0) + 1; return a; }, {}) }));
  return { rows, dismissed };
}
