// app/lib/brain-attention-server.ts
// ブレインの判断 → やること（line_tasks）・hot・今日のターゲットの読み出し（サーバー専用。画面から import しない）
// 判定はすべて app/lib/brain-attention.ts（純関数）。ここは DB の読み書きだけ。
//
// 2026-10-08 竹内さんの決定（原文は brain-attention.ts の頭）: ブレイン以外が「次にやる事」を決めている所をブレインに寄せる。
import { supabase } from "@/app/lib/supabase";
import { runBrainAndNotify } from "@/app/lib/brain-core";
import { isSimulatedCustomerTurn } from "@/app/lib/customer-sim-guard";
import {
  attentionRank, isAttentionExcluded, BRAIN_TASK_NOTE, brainHotDecision, brainNeedsStaff, brainTaskTypes, brainTaskTypesToCancel, classifyTarget, compareTargets, flagOn,
  POST_APPLY_STATUSES, targetSummary,
  type AttentionMeta, type TargetInput, type TargetTier,
} from "@/app/lib/brain-attention";
import { detectDealLossText, isApplicationCancelText } from "@/app/lib/deal-outcome";
import { brainHotDrop, FOLLOWUP_AIX_TYPES, ignoredFollowUpStreak, silentDaysSetting } from "@/app/lib/brain-hot-drop";
import { screeningSummaryLine, targetSummaryLine } from "@/app/lib/target-list-format";
import { contactDateOfNotes, contactDue } from "@/app/lib/contact-promise";

// ─────────────────────────────────────────────────────────────────────────────
// 連絡の約束の日（2026-10-08 竹内さん「その日に連絡するように約束後カレンダーに組み込む」）
//   カレンダーの【必ず】【連絡日 YYYY-MM-DD】（contact-promise）で、その日が来た未完了の行。会話の updated_at が古くても（約束した後に話していない人も）戻す。
//   戻す: CONTACT_DUE_TARGET=off
// ─────────────────────────────────────────────────────────────────────────────
type ContactDue = { ymd: string; title: string };
async function loadDueContacts(db: Db): Promise<Map<string, ContactDue>> {
  const out = new Map<string, ContactDue>();
  if (!flagOn(process.env.CONTACT_DUE_TARGET)) return out;
  const now = Date.now();
  const endOfTodayJst = new Date(Math.floor((now + 9 * 3_600_000) / 86_400_000) * 86_400_000 + 86_400_000 - 9 * 3_600_000).toISOString();
  const { data, error } = await db.from("calendar_events").select("conversation_id, title, notes, start_at")
    .eq("is_done", false).like("notes", "【必ず】%【連絡日%").lte("start_at", endOfTodayJst).limit(300);
  if (error) { console.warn("[brain-attention] contact due:", error.message); return out; }
  for (const r of (data ?? []) as Array<{ conversation_id: string | null; title: string | null; notes: string | null }>) {
    const ymd = contactDateOfNotes(r.notes);
    if (!r.conversation_id || !ymd || !contactDue(r.notes, now)) continue;
    const prev = out.get(r.conversation_id);
    if (!prev || ymd < prev.ymd) out.set(r.conversation_id, { ymd, title: r.title ?? "" });
  }
  return out;
}
const CONV_SELECT = "id, customer_name, status, line_status, created_at, updated_at, last_sender, last_message, property_customer_id, status_manual_back_at, suggested_aix_meta";
/** 期間の外（updated_at が古い）でも連絡の約束の日が来た会話を足す */
async function withDueConversations(db: Db, convs: ConvRow[], due: Map<string, ContactDue>, onlyIds?: string[]): Promise<ConvRow[]> {
  const have = new Set(convs.map((c) => c.id));
  const missing = [...due.keys()].filter((id) => !have.has(id) && (!onlyIds || onlyIds.includes(id)));
  if (missing.length === 0) return convs;
  const { data } = await db.from("conversations").select(CONV_SELECT).in("id", missing).not("status", "in", "(closed_won,closed_lost,lost,contract)");
  return [...convs, ...((data ?? []) as ConvRow[]).filter((c) => !isAttentionExcluded(c.id, c.customer_name))];
}

type Db = typeof supabase;

/** ブレインを動かし、その判断から やること・hot を合わせる（runBrainAndNotify の代わりに呼ぶ。戻り値は同じ） */
export async function runBrainWithFollowups(...args: Parameters<typeof runBrainAndNotify>): ReturnType<typeof runBrainAndNotify> {
  const snap = await runBrainAndNotify(...args);
  // 待つ（呼び出し元の多くは after() の中＝待たないと関数の終わりで切れる）。DB の読み書き数回だけ（ブレインの数秒に比べて小さい）
  if (snap?.meta) {
    await syncBrainFollowups(args[0], snap.meta as unknown as AttentionMeta, snap.customerName).catch((e) =>
      console.warn("[brain-attention] followups failed:", args[0], e instanceof Error ? e.message : e));
  }
  return snap;
}

/**
 * ブレインの今の判断から:
 *   1. やること（line_tasks）を作る／ブレインが前に置いた物を取り下げる（BRAIN_TASKS_ONLY=off で何もしない＝旧の語の作成に戻すのは各所）
 *   2. hot（property_customers.status）に上げる（HOT_BY_BRAIN=off で何もしない）
 * お客様役（テスト・YUMA の模擬の番）は何もしない（syncAixActionItem と同じ）
 */
export async function syncBrainFollowups(conversationId: string, meta: AttentionMeta | null, customerName?: string | null, db: Db = supabase): Promise<void> {
  if (!meta || meta.source === "cached") return;
  if (await isSimulatedCustomerTurn(conversationId)) return;
  if (flagOn(process.env.BRAIN_TASKS_ONLY)) await syncBrainTasks(db, conversationId, meta, customerName ?? null);
  if (flagOn(process.env.HOT_BY_BRAIN)) await syncBrainHot(db, conversationId, meta);
}

/** やることの合わせ（syncBrainFollowups の中身・確かめのスクリプトからも呼ぶ） */
export async function syncBrainTasks(db: Db, conversationId: string, meta: AttentionMeta, customerName: string | null): Promise<void> {
  const want = brainTaskTypes(meta) ?? [];
  const cancel = brainTaskTypesToCancel(meta);
  const { data: pending } = await db.from("line_tasks").select("id, task_type, result_note").eq("conversation_id", conversationId).eq("status", "pending");
  const rows = (pending ?? []) as Array<{ id: string; task_type: string; result_note: string | null }>;
  const now = new Date().toISOString();
  // ブレインが前に置いた物（印 brain）のうち、今の判断が要らないと言った物だけ取り下げる（スタッフが手で作った物は触らない）
  const toCancel = rows.filter((r) => r.result_note === BRAIN_TASK_NOTE && (cancel as string[]).includes(r.task_type)).map((r) => r.id);
  if (toCancel.length) {
    await db.from("line_tasks").update({ status: "cancelled", completed_at: now, result_note: `${BRAIN_TASK_NOTE}:no_longer` }).in("id", toCancel).eq("status", "pending");
  }
  for (const type of want) {
    if (rows.some((r) => r.task_type === type)) continue;
    let name = customerName;
    if (!name) {
      const { data: c } = await db.from("conversations").select("customer_name").eq("id", conversationId).maybeSingle();
      name = (c?.customer_name as string | null) ?? "お客様";
    }
    const { error } = await db.from("line_tasks").insert({ conversation_id: conversationId, task_type: type, customer_name: name, status: "pending", result_note: BRAIN_TASK_NOTE });
    // 1会話×種類の pending は1件（一意索引）。同時実行で当たった＝もう一方が作った
    if (error && !/duplicate|unique/i.test(error.message)) console.warn("[brain-attention] task insert failed:", conversationId, type, error.message);
    else if (!error) console.log(JSON.stringify({ tag: "brain-attention:task", conversationId, type, decision_source: meta.decision_source ?? null, action: meta.action ?? null }));
  }
}

async function syncBrainHot(db: Db, conversationId: string, meta: AttentionMeta): Promise<void> {
  const { data: conv } = await db.from("conversations")
    .select("id, customer_name, status, line_status, created_at, updated_at, last_sender, property_customer_id, status_manual_back_at")
    .eq("id", conversationId).maybeSingle();
  if (!conv?.property_customer_id) return;
  if (isAttentionExcluded(conversationId, conv.customer_name as string | null)) return;
  const { data: pc } = await db.from("property_customers").select("id, status").eq("id", conv.property_customer_id as string).maybeSingle();
  if (!pc || !["new_inquiry", "property_search"].includes(String(pc.status ?? ""))) return;
  const [input] = await buildTargetInputs(db, [conv as ConvRow], { metaOverride: { [conversationId]: meta } });
  if (!input) return;
  const d = brainHotDecision(input.input);
  if (!d.hot) return;
  await db.from("property_customers").update({ status: "hot", updated_at: new Date().toISOString() }).eq("id", pc.id as string).in("status", ["new_inquiry", "property_search"]);
  console.log(JSON.stringify({ tag: "brain-attention:hot", conversationId, from: pc.status, reason: d.reason }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 今日のターゲット（グループの全リスト・daily-brief・announce-sonota）
// ─────────────────────────────────────────────────────────────────────────────
type ConvRow = {
  id: string; customer_name?: string | null; status: string | null; line_status?: string | null; created_at?: string | null; updated_at?: string | null;
  last_sender?: string | null; last_message?: string | null; property_customer_id?: string | null; status_manual_back_at?: string | null; suggested_aix_meta?: unknown;
};

export type BrainTarget = {
  conversationId: string;
  customerName: string;
  status: string | null;
  tier: TargetTier;
  reason: string;
  summary: string;
  /** 「🌟ターゲット🌟」の一言（竹内さんの書き方・target-list-format targetSummaryLine） */
  summaryLine: string;
  lastCustomerAt: string | null;
  lastSender: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  lastMessage: string | null;
  pendingAixAction: string | null;
  propertyCustomerId: string | null;
};

const latestIso = (...xs: Array<string | null | undefined>): string | null => {
  let best: string | null = null;
  for (const x of xs) if (x && Number.isFinite(Date.parse(x)) && (!best || Date.parse(x) > Date.parse(best))) best = x;
  return best;
};

async function buildTargetInputs(
  db: Db,
  convs: ConvRow[],
  opts: { metaOverride?: Record<string, AttentionMeta>; contactDue?: Map<string, ContactDue> } = {},
): Promise<Array<{ conv: ConvRow; input: TargetInput; pendingAixAction: string | null; pendingCheckPattern: string | null }>> {
  if (convs.length === 0) return [];
  const ids = convs.map((c) => c.id);
  const since = new Date(Date.now() - 45 * 86_400_000).toISOString();
  const [{ data: items }, { data: views }, { data: metas }, { data: custMsgs }, { data: outcomes, error: outcomesErr }, { data: aixMsgs }] = await Promise.all([
    db.from("aix_action_items").select("conversation_id, action, check_pattern").eq("status", "pending").in("conversation_id", ids),
    db.from("viewing_history").select("conversation_id, status, scheduled_date, actual_date").in("status", ["done", "lapsed"]).in("conversation_id", ids),
    // 返信を送ると suggested_aix_meta は消える（判断は last_brain_meta に残る）→ 無い時は last_brain_meta（ブレインの最後の判断）を読む
    db.from("conversations").select("id, suggested_aix_meta, last_brain_meta").in("id", ids),
    // お客様の最後の発言の時刻（スタッフが返した後は会話行からは分からない）
    db.from("messages").select("conversation_id, created_at, text").eq("sender", "customer").in("conversation_id", ids).gte("created_at", since)
      .order("created_at", { ascending: false }).limit(8000),
    // 案件の失注の確定（L1 他で決めた・L4 引越し中止・L6 申込の取り消し）。審査落ちの後に終わった人を外す
    db.from("deal_outcomes").select("conversation_id, episode_no, result, result_certainty, lost_type, lost_at").in("conversation_id", ids),
    // 続けて返事の無い追客（hot から外す・brain-hot-drop）。お客様の最後の発言より後の追客だけ数える
    // 追客＝AIX【物件ピックアップした】【物件オススメ】の送信（2026-10-08 竹内「追客は AIX の物件ピックアップ または 物件オススメ」）
    db.from("aix_usage_logs").select("conversation_id, created_at, sent_at").in("aix_type", [...FOLLOWUP_AIX_TYPES]).in("conversation_id", ids) /* 期間で切らない（止まった人の追客は45日より前のことがある・実物 みゅ 8/10）。物件の AIX だけなので軽い */
      .order("created_at", { ascending: false }).limit(8000),
  ]);
  const aixBy = new Map<string, string[]>();
  for (const m of (aixMsgs ?? []) as Array<{ conversation_id: string; created_at: string; sent_at?: string | null }>) {
    const arr = aixBy.get(m.conversation_id) ?? [];
    arr.push(m.sent_at ?? m.created_at);
    aixBy.set(m.conversation_id, arr);
  }
  const hotDrop = flagOn(process.env.HOT_DROP_BY_BRAIN);
  const hotDropSilentDays = silentDaysSetting(process.env.HOT_DROP_SILENT_DAYS);
  const lastCustBy = new Map<string, string>();
  const custTextsBy = new Map<string, Array<{ at: string; text: string | null }>>();
  for (const m of (custMsgs ?? []) as Array<{ conversation_id: string; created_at: string; text: string | null }>) {
    if (!lastCustBy.has(m.conversation_id)) lastCustBy.set(m.conversation_id, m.created_at);
    const arr = custTextsBy.get(m.conversation_id) ?? [];
    arr.push({ at: m.created_at, text: m.text });
    custTextsBy.set(m.conversation_id, arr);
  }
  // 台帳の一番新しい案件が失注で確定（型が終わり＝L1・L4・L6）の時刻
  const ENDED_LOST_TYPES = new Set(["declined_elsewhere", "move_cancelled", "application_cancelled"]);
  const latestEp = new Map<string, { episode_no: number; result: string | null; result_certainty: string | null; lost_type: string | null; lost_at: string | null }>();
  if (outcomesErr) console.warn("[brain-attention] deal_outcomes:", outcomesErr.message);
  for (const o of (outcomes ?? []) as Array<{ conversation_id: string; episode_no: number; result: string | null; result_certainty: string | null; lost_type: string | null; lost_at: string | null }>) {
    const prev = latestEp.get(o.conversation_id);
    if (!prev || o.episode_no > prev.episode_no) latestEp.set(o.conversation_id, o);
  }
  const endedFromLedger = (id: string): string | null => {
    const o = latestEp.get(id);
    return o && o.result === "lost" && o.result_certainty === "confirmed" && ENDED_LOST_TYPES.has(o.lost_type ?? "") ? o.lost_at : null;
  };
  // お客様の文の決まった言い方（審査落ちの後の文だけ）で終わった時刻
  const endedFromText = (id: string, afterIso: string | null): string | null => {
    if (!afterIso) return null;
    const after = Date.parse(afterIso);
    for (const m of custTextsBy.get(id) ?? []) { // 新しい順
      if (!(Date.parse(m.at) > after)) break;
      if (detectDealLossText(m.text) || isApplicationCancelText(m.text)) return m.at;
    }
    return null;
  };
  const itemBy = new Map(((items ?? []) as Array<{ conversation_id: string; action: string | null; check_pattern: string | null }>).map((r) => [r.conversation_id, r]));
  const viewedBy = new Map<string, string>();
  for (const v of (views ?? []) as Array<{ conversation_id: string; scheduled_date: string | null; actual_date: string | null }>) {
    // lapsed＝日付が過ぎた（実施の記録なし）。実物は lapsed の大半で内覧後のお礼を送っている（brain-core の注記）ので内覧済みに数える
    const d = v.actual_date ?? v.scheduled_date;
    if (d) viewedBy.set(v.conversation_id, latestIso(viewedBy.get(v.conversation_id), d) as string);
  }
  const metaBy = new Map(((metas ?? []) as Array<{ id: string; suggested_aix_meta: unknown; last_brain_meta: unknown }>).map((r) => [r.id, r.suggested_aix_meta ?? r.last_brain_meta ?? null]));
  const now = Date.now();
  return convs.map((conv) => {
    const meta = (opts.metaOverride?.[conv.id] ?? conv.suggested_aix_meta ?? metaBy.get(conv.id) ?? null) as AttentionMeta | null;
    const item = itemBy.get(conv.id) ?? null;
    const status = conv.status ?? null;
    // 審査落ち（切り替え中）: スタッフが申込から戻した印（今は申込の手前）／ブレインの審査落ちの切り替え
    const backAt = conv.status_manual_back_at && !POST_APPLY_STATUSES.has(String(status ?? "")) ? conv.status_manual_back_at : null;
    const brainFailAt = meta?.decision_source === "correction:screening_failed_switch" ? (meta.analyzed_msg_ts ?? null) : null;
    const lastCustomerAt = latestIso(lastCustBy.get(conv.id) ?? null, meta?.analyzed_msg_ts ?? null, conv.last_sender === "customer" ? conv.updated_at ?? null : null);
    const screeningFailedAt = latestIso(backAt, brainFailAt);
    // 終わった人を外すのは審査落ちの人だけ（竹内さんの答えの範囲・③④ はブレインの取り下げの線がある）
    const dealEndedAt = screeningFailedAt ? latestIso(endedFromLedger(conv.id), endedFromText(conv.id, screeningFailedAt)) : null;
    const input: TargetInput = {
      status, lineStatus: conv.line_status ?? null, createdAt: conv.created_at ?? null, lastCustomerAt,
      meta, pendingAixAction: item?.action ?? null, lastViewedAt: viewedBy.get(conv.id) ?? null,
      screeningFailedAt, dealEndedAt, staffNeverReplied: status === "first_reply" || status === "new_inquiry", nowMs: now,
      // お客様の最後の発言は45日の窓の外のこともある → 窓の外なら窓の中の AIX を全部数える（窓より前の発言なので同じ）
      ignoredAix: ignoredFollowUpStreak(aixBy.get(conv.id) ?? [], lastCustomerAt), hotDrop, hotDropSilentDays,
      contactDueYmd: opts.contactDue?.get(conv.id)?.ymd ?? null, contactDueTitle: opts.contactDue?.get(conv.id)?.title ?? null,
    };
    return { conv, input, pendingAixAction: item?.action ?? null, pendingCheckPattern: item?.check_pattern ?? null };
  });
}

/**
 * 今日のターゲットの一覧（並び: ①内覧済み ②審査落ち ③新規 ④物件検索中 → 最後のお客様の発言が新しい順）。
 * 申込以降は審査落ちの切り替えだけ・テスト用の会話・ブロックは入れない
 */
export async function loadBrainTargets(db: Db = supabase, opts: { sinceDays?: number; limit?: number } = {}): Promise<BrainTarget[]> {
  const since = new Date(Date.now() - (opts.sinceDays ?? 60) * 86_400_000).toISOString();
  const { data: convRows, error } = await db.from("conversations")
    .select("id, customer_name, status, line_status, created_at, updated_at, last_sender, last_message, property_customer_id, status_manual_back_at, suggested_aix_meta")
    .not("status", "in", "(closed_won,closed_lost,lost,contract)")
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(opts.limit ?? 600);
  if (error) throw new Error(`loadBrainTargets: ${error.message}`);
  const due = await loadDueContacts(db);
  const convs = await withDueConversations(db, ((convRows ?? []) as ConvRow[]).filter((c) => !isAttentionExcluded(c.id, c.customer_name)), due);
  const inputs = await buildTargetInputs(db, convs, { contactDue: due });
  const picked = inputs.map((x) => ({ x, t: classifyTarget(x.input) })).filter((r): r is { x: typeof inputs[number]; t: NonNullable<ReturnType<typeof classifyTarget>> } => !!r.t);
  const pcIds = [...new Set(picked.map((r) => r.x.conv.property_customer_id).filter(Boolean) as string[])];
  const { data: pcs } = pcIds.length
    ? await db.from("property_customers").select("id, desired_area, commute_station, commute_minutes, rent_max, floor_plan, other_requests, ai_summary_json, ai_summary_at").in("id", pcIds)
    : { data: [] as Array<Record<string, unknown>> };
  const nextViewBy = await loadNextViewings(db, picked.map((r) => r.x.conv.id));
  const nowMs = Date.now();
  const pcBy = new Map(((pcs ?? []) as Array<Record<string, unknown>>).map((p) => [String(p.id), p]));
  const out: BrainTarget[] = picked.map(({ x, t }) => {
    const pc = x.conv.property_customer_id ? pcBy.get(x.conv.property_customer_id) : undefined;
    return {
      conversationId: x.conv.id,
      customerName: x.conv.customer_name || "名称未設定",
      status: x.conv.status,
      tier: t.tier,
      reason: t.reason,
      summary: targetSummary({
        tier: t.tier,
        desiredArea: (pc?.desired_area as string | null) ?? null, commuteStation: (pc?.commute_station as string | null) ?? null,
        commuteMinutes: (pc?.commute_minutes as number | null) ?? null, rentMax: (pc?.rent_max as number | null) ?? null,
        floorPlan: (pc?.floor_plan as string | null) ?? null, otherRequests: (pc?.other_requests as string | null) ?? null,
        nextAix: x.pendingAixAction, nextCheckPattern: x.pendingCheckPattern,
      }),
      summaryLine: targetSummaryLine({
        tier: t.tier,
        desiredArea: (pc?.desired_area as string | null) ?? null, commuteStation: (pc?.commute_station as string | null) ?? null,
        commuteMinutes: (pc?.commute_minutes as number | null) ?? null, rentMax: (pc?.rent_max as number | null) ?? null,
        floorPlan: (pc?.floor_plan as string | null) ?? null, otherRequests: (pc?.other_requests as string | null) ?? null,
        situation: situationOf(pc), situationAt: (pc?.ai_summary_at as string | null) ?? null,
        nextViewingDate: nextViewBy.get(x.conv.id) ?? null, nowMs,
      }),
      lastCustomerAt: x.input.lastCustomerAt ?? null,
      lastSender: x.conv.last_sender ?? null,
      updatedAt: x.conv.updated_at ?? null,
      createdAt: x.conv.created_at ?? null,
      lastMessage: x.conv.last_message ?? null,
      pendingAixAction: x.pendingAixAction,
      propertyCustomerId: x.conv.property_customer_id ?? null,
    };
  });
  // 連絡の約束の日の人は、一言の頭に約束（「連絡の約束の日 12/17・入居2月」）を付ける
  for (const t of out) {
    if (t.tier !== "contact_due") continue;
    const d = due.get(t.conversationId);
    const mv = d?.title.match(/（入居([^）]+)）/)?.[1];
    t.summaryLine = [`連絡の約束の日${d ? ` ${Number(d.ymd.slice(5, 7))}/${Number(d.ymd.slice(8, 10))}` : ""}${mv ? `・入居${mv}` : ""}`, t.summaryLine].filter(Boolean).join("、");
  }
  return out.sort(compareTargets);
}

const situationOf = (pc: Record<string, unknown> | undefined): string | null => {
  const j = pc?.ai_summary_json as { situation?: unknown } | null | undefined;
  return j && typeof j.situation === "string" ? j.situation : null;
};

/** これからの内覧（viewing_history scheduled・今日以降の一番近い日）。会話ごと */
async function loadNextViewings(db: Db, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  const { data } = await db.from("viewing_history").select("conversation_id, scheduled_date").eq("status", "scheduled").gte("scheduled_date", today).in("conversation_id", ids);
  for (const v of (data ?? []) as Array<{ conversation_id: string; scheduled_date: string | null }>) {
    if (!v.scheduled_date) continue;
    const prev = out.get(v.conversation_id);
    if (!prev || v.scheduled_date < prev) out.set(v.conversation_id, v.scheduled_date);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 【審査中】（申込以降＝別ツールの領分・ブレインの判断は足さない・今ある情報だけ）
// ─────────────────────────────────────────────────────────────────────────────
export type ScreeningRow = { conversationId: string; customerName: string; summaryLine: string; updatedAt: string | null };

/** conversations.status=applying の人（テスト用の会話・ブロックは入れない）。一言は property_customers.ai_summary_json.situation（新しい時だけ） */
export async function loadScreeningList(db: Db = supabase, opts: { limit?: number } = {}): Promise<ScreeningRow[]> {
  const { data, error } = await db.from("conversations")
    .select("id, customer_name, line_status, updated_at, property_customer_id")
    .eq("status", "applying")
    .order("updated_at", { ascending: false })
    .limit(opts.limit ?? 60);
  if (error) throw new Error(`loadScreeningList: ${error.message}`);
  const rows = ((data ?? []) as Array<{ id: string; customer_name: string | null; line_status: string | null; updated_at: string | null; property_customer_id: string | null }>)
    .filter((c) => !isAttentionExcluded(c.id, c.customer_name) && c.line_status !== "blocked");
  const pcIds = [...new Set(rows.map((r) => r.property_customer_id).filter(Boolean) as string[])];
  const { data: pcs } = pcIds.length
    ? await db.from("property_customers").select("id, ai_summary_json, ai_summary_at").in("id", pcIds)
    : { data: [] as Array<Record<string, unknown>> };
  const pcBy = new Map(((pcs ?? []) as Array<Record<string, unknown>>).map((p) => [String(p.id), p]));
  const nowMs = Date.now();
  return rows.map((r) => {
    const pc = r.property_customer_id ? pcBy.get(r.property_customer_id) : undefined;
    return {
      conversationId: r.id,
      customerName: r.customer_name || "名称未設定",
      summaryLine: screeningSummaryLine({ situation: situationOf(pc), situationAt: (pc?.ai_summary_at as string | null) ?? null, nowMs }),
      updatedAt: r.updated_at,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// hot から外す（2026-10-08 竹内「hot から外す事もブレインがしてよい」「AIX 3回連続無視等」）
// ─────────────────────────────────────────────────────────────────────────────
export type HotDropRow = { propertyCustomerId: string; customerName: string; conversationId: string; reason: string };

/**
 * property_customers.status=hot のうち、追客（AIX 物件ピックアップした／物件オススメ）を3回続けて返事なしの人を property_search に下げる
 *   （2本目の線＝お客様の発言が N 日無い は HOT_DROP_SILENT_DAYS に数字を入れた時だけ）。
 *   物件の検索は止めない（property_search＝止まった人の週2回の便）。お客様が戻れば発言の後のブレイン（syncBrainHot）が再び hot に上げる。
 *   dryRun=true は読むだけ。戻す: HOT_DROP_BY_BRAIN=off（何もしない）
 */
export async function syncBrainHotDrops(db: Db = supabase, opts: { dryRun?: boolean } = {}): Promise<HotDropRow[]> {
  if (!flagOn(process.env.HOT_DROP_BY_BRAIN)) return [];
  const { data: pcs } = await db.from("property_customers").select("id, customer_name, hot_confirmed_at").eq("status", "hot").limit(500);
  const pcRows = (pcs ?? []) as Array<{ id: string; customer_name: string | null; hot_confirmed_at: string | null }>;
  if (pcRows.length === 0) return [];
  const { data: convs } = await db.from("conversations").select("id, customer_name, property_customer_id, status, created_at").in("property_customer_id", pcRows.map((p) => p.id));
  const convRows = ((convs ?? []) as Array<{ id: string; customer_name: string | null; property_customer_id: string; status: string | null; created_at: string | null }>)
    .filter((c) => !isAttentionExcluded(c.id, c.customer_name) && !POST_APPLY_STATUSES.has(String(c.status ?? "")));
  if (convRows.length === 0) return [];
  const ids = convRows.map((c) => c.id);
  const since = new Date(Date.now() - 45 * 86_400_000).toISOString();
  const [{ data: custMsgs }, { data: aixMsgs }] = await Promise.all([
    db.from("messages").select("conversation_id, created_at").eq("sender", "customer").in("conversation_id", ids).gte("created_at", since)
      .order("created_at", { ascending: false }).limit(8000),
    // 追客＝AIX【物件ピックアップした】【物件オススメ】の送信（2026-10-08 竹内「追客は AIX の物件ピックアップ または 物件オススメ」）
    db.from("aix_usage_logs").select("conversation_id, created_at, sent_at").in("aix_type", [...FOLLOWUP_AIX_TYPES]).in("conversation_id", ids) /* 期間で切らない（止まった人の追客は45日より前のことがある・実物 みゅ 8/10）。物件の AIX だけなので軽い */
      .order("created_at", { ascending: false }).limit(8000),
  ]);
  const lastCust = new Map<string, string>();
  for (const m of (custMsgs ?? []) as Array<{ conversation_id: string; created_at: string }>) if (!lastCust.has(m.conversation_id)) lastCust.set(m.conversation_id, m.created_at);
  // 45日の窓に発言が無い会話だけ、窓の外の最後の発言を読む（理由の日数を正しく出す・止まった人は発言が少ないので軽い）
  const missing = ids.filter((id) => !lastCust.has(id));
  if (missing.length) {
    const { data: old } = await db.from("messages").select("conversation_id, created_at").eq("sender", "customer").in("conversation_id", missing)
      .order("created_at", { ascending: false }).limit(10000);
    for (const m of (old ?? []) as Array<{ conversation_id: string; created_at: string }>) if (!lastCust.has(m.conversation_id)) lastCust.set(m.conversation_id, m.created_at);
  }
  const aixBy = new Map<string, string[]>();
  for (const m of (aixMsgs ?? []) as Array<{ conversation_id: string; created_at: string; sent_at?: string | null }>) {
    const arr = aixBy.get(m.conversation_id) ?? [];
    arr.push(m.sent_at ?? m.created_at);
    aixBy.set(m.conversation_id, arr);
  }
  const nowMs = Date.now();
  const silentDays = silentDaysSetting(process.env.HOT_DROP_SILENT_DAYS);
  const out: HotDropRow[] = [];
  for (const pc of pcRows) {
    const mine = convRows.filter((c) => c.property_customer_id === pc.id);
    if (mine.length === 0) continue;
    // 1人に会話が複数ある時: どの会話でもお客様が戻っていない（全部の会話で外す線を満たす）時だけ外す
    const ds = mine.map((c) => ({ c, d: brainHotDrop({
      ignored: ignoredFollowUpStreak(aixBy.get(c.id) ?? [], lastCust.get(c.id) ?? null), hotConfirmedAt: pc.hot_confirmed_at,
      // 発言が一度も無い会話は会話を始めた時から数える
      lastCustomerAt: lastCust.get(c.id) ?? null, silentSince: c.created_at, silentDays, nowMs,
    }) }));
    if (!ds.every((x) => x.d.drop)) continue;
    out.push({ propertyCustomerId: pc.id, customerName: pc.customer_name || "名称未設定", conversationId: ds[0].c.id, reason: ds[0].d.reason ?? "" });
  }
  if (!opts.dryRun && out.length) {
    const nowIso = new Date().toISOString();
    for (const r of out) {
      await db.from("property_customers").update({ status: "property_search", property_send_count: 0, updated_at: nowIso }).eq("id", r.propertyCustomerId).eq("status", "hot");
      console.log(JSON.stringify({ tag: "brain-attention:hot-drop", propertyCustomerId: r.propertyCustomerId, conversationId: r.conversationId, reason: r.reason }));
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 要対応と並び（お客様一覧の画面・brain/list）— 会話の画面と同じ brain-attention の判定
// ─────────────────────────────────────────────────────────────────────────────
export type AttentionInfo = { needs: boolean; reason: string | null; tier: TargetTier | null; rank: number; pendingAixAction: string | null };

/** 会話ごとの要対応（brainNeedsStaff）・ターゲットの段・並び（attentionRank） */
export async function loadAttentionMap(db: Db = supabase, opts: { sinceDays?: number; limit?: number; ids?: string[] } = {}): Promise<Record<string, AttentionInfo>> {
  let q = db.from("conversations")
    .select("id, customer_name, status, line_status, created_at, updated_at, last_sender, property_customer_id, status_manual_back_at, suggested_aix_meta")
    .not("status", "in", "(closed_won,closed_lost,lost,contract)");
  if (opts.ids) q = q.in("id", opts.ids);
  else q = q.gte("updated_at", new Date(Date.now() - (opts.sinceDays ?? 60) * 86_400_000).toISOString());
  const { data: convRows, error } = await q.order("updated_at", { ascending: false }).limit(opts.limit ?? 600);
  if (error) throw new Error(`loadAttentionMap: ${error.message}`);
  const due = await loadDueContacts(db);
  const convs = await withDueConversations(db, ((convRows ?? []) as ConvRow[]).filter((c) => !isAttentionExcluded(c.id, c.customer_name)), due, opts.ids);
  const inputs = await buildTargetInputs(db, convs, { contactDue: due });
  const out: Record<string, AttentionInfo> = {};
  for (const x of inputs) {
    const n = brainNeedsStaff({ meta: x.input.meta, pendingAixAction: x.pendingAixAction, lastSender: x.conv.last_sender ?? null, status: x.conv.status, contactDueYmd: x.input.contactDueYmd ?? null });
    const tier = classifyTarget(x.input)?.tier ?? null;
    out[x.conv.id] = { needs: n.needs, reason: n.reason, tier, rank: attentionRank({ pendingAixAction: x.pendingAixAction, tier }), pendingAixAction: x.pendingAixAction };
  }
  return out;
}
