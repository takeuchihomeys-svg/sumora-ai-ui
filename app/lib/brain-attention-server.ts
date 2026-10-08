// app/lib/brain-attention-server.ts
// ブレインの判断 → やること（line_tasks）・hot・今日のターゲットの読み出し（サーバー専用。画面から import しない）
// 判定はすべて app/lib/brain-attention.ts（純関数）。ここは DB の読み書きだけ。
//
// 2026-10-08 竹内さんの決定（原文は brain-attention.ts の頭）: ブレイン以外が「次にやる事」を決めている所をブレインに寄せる。
import { supabase } from "@/app/lib/supabase";
import { runBrainAndNotify } from "@/app/lib/brain-core";
import { isSimulatedCustomerTurn } from "@/app/lib/customer-sim-guard";
import { isTestConversation } from "@/app/lib/test-conversations";
import {
  BRAIN_TASK_NOTE, brainHotDecision, brainTaskTypes, brainTaskTypesToCancel, classifyTarget, compareTargets, flagOn,
  POST_APPLY_STATUSES, targetSummary,
  type AttentionMeta, type TargetInput, type TargetTier,
} from "@/app/lib/brain-attention";

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
    .select("id, status, line_status, created_at, updated_at, last_sender, property_customer_id, status_manual_back_at")
    .eq("id", conversationId).maybeSingle();
  if (!conv?.property_customer_id) return;
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
  opts: { metaOverride?: Record<string, AttentionMeta> } = {},
): Promise<Array<{ conv: ConvRow; input: TargetInput; pendingAixAction: string | null; pendingCheckPattern: string | null }>> {
  if (convs.length === 0) return [];
  const ids = convs.map((c) => c.id);
  const since = new Date(Date.now() - 45 * 86_400_000).toISOString();
  const [{ data: items }, { data: views }, { data: metas }, { data: custMsgs }] = await Promise.all([
    db.from("aix_action_items").select("conversation_id, action, check_pattern").eq("status", "pending").in("conversation_id", ids),
    db.from("viewing_history").select("conversation_id, status, scheduled_date, actual_date").in("status", ["done", "lapsed"]).in("conversation_id", ids),
    // 返信を送ると suggested_aix_meta は消える（判断は last_brain_meta に残る）→ 無い時は last_brain_meta（ブレインの最後の判断）を読む
    db.from("conversations").select("id, suggested_aix_meta, last_brain_meta").in("id", ids),
    // お客様の最後の発言の時刻（スタッフが返した後は会話行からは分からない）
    db.from("messages").select("conversation_id, created_at").eq("sender", "customer").in("conversation_id", ids).gte("created_at", since)
      .order("created_at", { ascending: false }).limit(8000),
  ]);
  const lastCustBy = new Map<string, string>();
  for (const m of (custMsgs ?? []) as Array<{ conversation_id: string; created_at: string }>) if (!lastCustBy.has(m.conversation_id)) lastCustBy.set(m.conversation_id, m.created_at);
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
    const input: TargetInput = {
      status, lineStatus: conv.line_status ?? null, createdAt: conv.created_at ?? null, lastCustomerAt,
      meta, pendingAixAction: item?.action ?? null, lastViewedAt: viewedBy.get(conv.id) ?? null,
      screeningFailedAt: latestIso(backAt, brainFailAt), staffNeverReplied: status === "first_reply" || status === "new_inquiry", nowMs: now,
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
  const convs = ((convRows ?? []) as ConvRow[]).filter((c) => !isTestConversation(c.id));
  const inputs = await buildTargetInputs(db, convs);
  const picked = inputs.map((x) => ({ x, t: classifyTarget(x.input) })).filter((r): r is { x: typeof inputs[number]; t: NonNullable<ReturnType<typeof classifyTarget>> } => !!r.t);
  const pcIds = [...new Set(picked.map((r) => r.x.conv.property_customer_id).filter(Boolean) as string[])];
  const { data: pcs } = pcIds.length
    ? await db.from("property_customers").select("id, desired_area, commute_station, commute_minutes, rent_max, floor_plan, other_requests").in("id", pcIds)
    : { data: [] as Array<Record<string, unknown>> };
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
      lastCustomerAt: x.input.lastCustomerAt ?? null,
      lastSender: x.conv.last_sender ?? null,
      updatedAt: x.conv.updated_at ?? null,
      createdAt: x.conv.created_at ?? null,
      lastMessage: x.conv.last_message ?? null,
      pendingAixAction: x.pendingAixAction,
      propertyCustomerId: x.conv.property_customer_id ?? null,
    };
  });
  return out.sort(compareTargets);
}
