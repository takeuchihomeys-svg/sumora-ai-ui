// app/lib/viewing-morning-greeting-server.ts — 内覧当日の朝の挨拶の要対応（サーバー専用）
//
// 2026-10-08 竹内さん「作る」: 待ち合わせ場所の AIX で確定した内覧の日の朝（cron /api/cron/viewing-morning-greeting・JST 9:15）に、
//   まだ当日の内覧挨拶（AIX【内覧挨拶→内覧前】）を送っていない・取りやめていない会話について AIX要対応を立て、売上番長グループに1件ずつ通知する。
//   決めるのは viewing-day-greeting.morningViewingGreetingPlan（純関数）・材料は行動台帳（ブレインと同じ buildActionLedger）。
//   送ったら自動で済み（AIX → completeAixActionItem／普通の送信の挨拶 → completeAixActionItemByStaffText）。前の日の残りはここで取り下げる。
//   dryRun=true は読むだけ（登録・通知・取り下げをしない）＝監査とテスト用
import { supabase } from "@/app/lib/supabase-server";
import { buildActionLedger, type LedgerAixRow } from "@/app/lib/action-ledger";
import { loadCustomerStateInput } from "@/app/lib/customer-state-server";
import { isPostApplyStatus } from "@/app/lib/llm-alt-provider";
import { morningViewingGreetingPlan, morningGreetingNoticeLine, VIEWING_MORNING_GREETING_PATTERN, MORNING_GREETING_NOTE_PREFIX, isMorningGreetingItem, viewingFlowCancelled, viewingGreetingSetMinute, minuteLabel, type MorningGreetingWhy } from "@/app/lib/viewing-day-greeting";
import { registerRuleAixActionItem } from "@/app/lib/aix-action-items";
import { isTestConversation } from "@/app/lib/test-conversations";

const DAY = 86_400_000;
const jstYmd = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);

/** setAt: その会話の内覧挨拶をセットする時刻（JST「10:00」・11時より前の内覧は2時間前）。withdrawn: 今日立てた行を取りやめ・変更で取り下げた */
export type MorningGreetingRow = { conversationId: string; customerName: string; why: MorningGreetingWhy | "read_failed"; appointment: string | null; registered: boolean; setAt?: string; withdrawn?: boolean };

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

/**
 * 今日（JST）立てた朝の行（どの状態でも）。2026-10-15〜 cron は30分おきに走るので、今日すでに立てた会話は立て直さない（通知の重ね打ちを防ぐ）。
 *   pending の行は内覧の取りやめ・日の変更・申込を見て取り下げる（viewing_changed）ために返す
 */
async function todaysMorningItems(nowMs: number): Promise<Map<string, { id: string; status: string }>> {
  const todayStart = new Date(Date.parse(`${jstYmd(nowMs)}T00:00:00+09:00`)).toISOString();
  const { data } = await supabase.from("aix_action_items").select("id, conversation_id, status, resolution_note, created_at").eq("action", "greeting_viewing")
    .eq("check_pattern", VIEWING_MORNING_GREETING_PATTERN).gte("created_at", todayStart).lte("created_at", new Date(nowMs).toISOString()).limit(500);
  const m = new Map<string, { id: string; status: string }>();
  for (const r of (data ?? []) as Array<{ id: string; conversation_id: string; status: string; resolution_note: string | null }>) {
    // 朝の行（rule:…）か、朝の行が送信で済みになった行（resolution_note が書き換わる）。ブレインの行（check_pattern before・note なし）も今日あれば立て直さない
    // fix(review): check_pattern "before" はブレインの依頼の行（resolution_note なし）とも同じ。未完了・取り下げの行は朝の行（note が rule:…）だけを数える
    //   （ブレインの未完了の行を「今日の朝の行」と読むと、日の変更などで viewing_changed としてブレインの行を取り下げてしまう）。済みの行は挨拶を送った印なのでどちらも数える
    if (r.status !== "done" && !isMorningGreetingItem(r)) continue;
    const cur = m.get(String(r.conversation_id));
    if (!cur || r.status === "pending") m.set(String(r.conversation_id), { id: r.id, status: r.status });
  }
  return m;
}

/** 取りやめ・日の変更・申込で、今日立てた朝の行を取り下げる理由（それ以外は null） */
const CHANGED_WHYS = new Set<MorningGreetingWhy>(["not_today", "not_confirmed", "cancelled", "post_apply"]);

export async function runViewingMorningGreeting(opts: { nowMs?: number; dryRun?: boolean; only?: string[]; ignorePending?: boolean; probe?: boolean } = {}): Promise<{ rows: MorningGreetingRow[]; dismissed: number }> {
  const nowMs = opts.nowMs ?? Date.now();
  const dryRun = !!opts.dryRun;
  const dismissed = await dismissPastGreetingItems(nowMs, dryRun);
  // 2026-10-15: 今日すでに立てた会話は読まない（30分おきの cron で1会話1日1回）。pending の行は取りやめ・変更を見るためだけに読む。戻す VIEWING_GREETING_SET_TIME=off（その時も1日1回は守る）
  const todays = opts.ignorePending ? new Map<string, { id: string; status: string }>() : await todaysMorningItems(nowMs);
  const baseIds = opts.only?.length ? opts.only : await candidateConversations(nowMs);
  const ids = [...new Set([...baseIds, ...(opts.only?.length ? [] : [...todays.entries()].filter(([, v]) => v.status === "pending").map(([k]) => k))])]
    .filter((id) => !todays.has(id) || todays.get(id)!.status === "pending");
  const rows: MorningGreetingRow[] = [];
  const todayDay = Math.floor((nowMs + 9 * 3600_000) / DAY);
  for (const id of ids) {
    let input: Awaited<ReturnType<typeof loadCustomerStateInput>> = null;
    try { input = await loadCustomerStateInput(id, { now: nowMs }); } catch { input = null; }
    const [{ data: conv }, { data: open }] = await Promise.all([
      supabase.from("conversations").select("customer_name").eq("id", id).maybeSingle(),
      // 2026-10-08 竹内さん「（別の要対応が残っていても）立てる」: 未完了は2行まで（ブレインの依頼の行＋朝の挨拶の行）。朝の挨拶の行があればそれ（already_pending）・無ければブレインの行
      supabase.from("aix_action_items").select("action, check_pattern, resolution_note").eq("conversation_id", id).eq("status", "pending").limit(5),
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
    const todayPending = todays.get(id)?.status === "pending" ? todays.get(id)! : null;
    const plan = morningViewingGreetingPlan({
      appointmentDay: appt?.day ?? null,
      flowConfirmed: ledger.facts.viewingFlow ? ledger.facts.viewingFlow.confirmed : null,
      flowCancelled: viewingFlowCancelled(ledger.facts.viewingFlow?.reason),
      appointmentTime: appt?.time ?? null,
      postApply: isPostApplyStatus(input.status),
      // 今日の朝の行が pending の会話は「今も立てる番か」を見る（取りやめ・変更の取り下げ用）ので未完了で止めない
      pending: opts.ignorePending || todayPending ? null : ((rows: Array<{ action: string; check_pattern: string | null; resolution_note: string | null }>) =>
        rows.find((r) => isMorningGreetingItem(r)) ?? rows[0] ?? null)((open ?? []) as Array<{ action: string; check_pattern: string | null; resolution_note: string | null }>),
      staffMessages: messages.filter((m) => m.sender !== "customer").map((m) => ({ text: m.text, createdAt: m.createdAt ?? "" })),
      aixTypesToday,
      nowMs,
      ignoreSetTime: !!opts.probe || !!todayPending,
    });
    const apptLabel = appt ? `${appt.dateMD ?? "?"} ${appt.time ?? ""} ${appt.place ?? ""}`.trim() : null;
    const setAt = minuteLabel(viewingGreetingSetMinute(appt?.time ?? null));
    if (todayPending) {
      // 2026-10-15 竹内さん「内覧がキャンセル・変更なら変更後の日で」: 今日立てた行は、取りやめ・日の変更・申込になったら取り下げる（画面の主のボタンから消える）
      const changed = CHANGED_WHYS.has(plan.why);
      if (changed && !dryRun) {
        await supabase.from("aix_action_items").update({ status: "dismissed", dismissed_reason: `viewing_changed:${plan.why}`, updated_at: new Date(nowMs).toISOString() })
          .eq("id", todayPending.id).eq("status", "pending");
      }
      rows.push({ conversationId: id, customerName, why: changed ? plan.why : "already_pending", appointment: apptLabel, registered: false, setAt, withdrawn: changed });
      continue;
    }
    let registered = false;
    if (plan.register && !dryRun) {
      registered = await registerRuleAixActionItem({
        conversationId: id, customerName, action: "greeting_viewing", checkPattern: VIEWING_MORNING_GREETING_PATTERN,
        noticeExtra: morningGreetingNoticeLine({ time: appt?.time ?? null, place: appt?.place ?? null }),
        note: `${MORNING_GREETING_NOTE_PREFIX} ${apptLabel ?? ""}`,
      });
    }
    rows.push({ conversationId: id, customerName, why: plan.why, appointment: apptLabel, registered, setAt });
  }
  console.log(JSON.stringify({ tag: "viewing-morning-greeting", dryRun, candidates: ids.length, dismissed, skippedToday: todays.size, withdrawn: rows.filter((r) => r.withdrawn).length, due: rows.filter((r) => r.why === "due").length, registered: rows.filter((r) => r.registered).length,
    whys: rows.reduce<Record<string, number>>((a, r) => { a[r.why] = (a[r.why] ?? 0) + 1; return a; }, {}) }));
  return { rows, dismissed };
}
