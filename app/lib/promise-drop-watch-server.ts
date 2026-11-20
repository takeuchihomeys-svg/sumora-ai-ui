// app/lib/promise-drop-watch-server.ts — 約束の取りこぼしの見張りを DB から組み立てる
//
// 2026-11-21 作業員L。新しい cron は足さない:
//   数える … 朝の rag-watch-daily（JST 5:25・営業時間の外＝DB の重さを避ける）から recordPromiseDrops を1回。
//            cron_run_logs（cron_name=promise-drop-watch）に 件数・会話の頭8字・日数・文を残し、文を hanbancyo_settings に控える。
//   送る   … PROMISE_DROP_WATCH=on の時だけ、営業時間の最初の便（cron/staff-todo-list・10:30）がその朝の控えを1回 売上番長グループへ（竹内さんの OK の後）。
//   既定（未設定）は記録だけ（shadow）。off は何もしない。
//   読み: 30日以内にこちらが手打ちで約束の言葉を送った会話（messages を1回）→ 会話ごとに messages・aix_usage_logs・sent_properties・
//   aix_action_items・property_pickups・conversations（最大 300会話）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { promiseDropOf, buildPromiseDropPost, promiseDropDue, promiseDropWatchMode, PROMISE_DROP_KEY, PROMISE_DROP_TEXT_KEY, PROMISE_DROP_MAX_DAYS, type PromiseDrop, type PdInput, overduePromisesOf, type OverduePromise } from "./promise-drop-watch";
import { isTestConversation, isNoLineTestConversation, STAFF_INTERNAL_CONVERSATION_IDS } from "./test-conversations";

const MAX_CONVS = 300; // 朝 5:25（営業時間の外）に1回だけ。80 では古い約束（29日）の会話が入らなかった（11/21 の試し）

// 2026-11-21 作業員H の注意: rag-watch-daily の maxDuration は 120秒で、H の本番に近い問いの測りが最悪 70〜80秒使う。
//   こちらは 30秒の上限（budgetMs）を持ち、5会話ずつ並べて読み、時間が来たら途中で打ち切る（partial を記録に残す）。
export const PROMISE_DROP_BUDGET_MS = 30_000;
const BATCH = 5;

/** 1つの会話の材料（会話・発言・AIX・要対応・候補・お客様に届いた送付）。見張りと統括の材料（overduePromisesFor）で同じ読み */
export async function loadPdInput(sb: SupabaseClient, c: string, since: string): Promise<PdInput> {
  const [cv, m, a, i, p] = await Promise.all([
    sb.from("conversations").select("customer_name, call_name, status, line_user_id").eq("id", c).maybeSingle(),
    sb.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", c).gte("created_at", since).order("created_at").limit(1000),
    sb.from("aix_usage_logs").select("aix_type, sent_at, created_at").eq("conversation_id", c).gte("created_at", since).limit(300),
    sb.from("aix_action_items").select("action, status, created_at").eq("conversation_id", c).gte("created_at", since).limit(200),
    sb.from("property_pickups").select("created_at, status, sent_at, expired_at").eq("conversation_id", c).gte("created_at", since).limit(300),
  ]);
  const conv = cv.data as { customer_name?: string | null; call_name?: string | null; status?: string | null; line_user_id?: string | null } | null;
  // 送った物件は会話か、お客様（物件出しの台帳 property_customers）のどちらかで結ぶ。売上番長グループへの物件出し（source=line_group）はお客様に届いた送付ではないので数えない（brain-core と同じ線・11/21 の試しで確かめた）
  const { data: pcs } = conv?.line_user_id ? await sb.from("property_customers").select("id").eq("line_user_id", conv.line_user_id).limit(5) : { data: [] };
  const pcIds = ((pcs ?? []) as Array<{ id: string }>).map((x) => x.id);
  const s = await sb.from("sent_properties").select("sent_at").or(pcIds.length ? `conversation_id.eq.${c},${pcIds.map((id) => `property_customer_id.eq.${id}`).join(",")}` : `conversation_id.eq.${c}`).or("source.is.null,source.neq.line_group").gte("sent_at", since).limit(300);
  return {
    conversationId: c, customerName: conv?.call_name || conv?.customer_name || null, status: conv?.status ?? null,
    msgs: (m.data ?? []) as PdInput["msgs"], aix: (a.data ?? []) as PdInput["aix"], sent: (s.data ?? []) as PdInput["sent"],
    items: (i.data ?? []) as PdInput["items"], picks: (p.data ?? []) as PdInput["picks"],
  };
}

export async function loadPromiseDrops(sb: SupabaseClient, nowMs = Date.now(), o: { budgetMs?: number } = {}): Promise<PromiseDrop[] & { partial?: boolean; scanned?: number; total?: number }> {
  const deadline = Date.now() + (o.budgetMs ?? PROMISE_DROP_BUDGET_MS);
  const since = new Date(nowMs - PROMISE_DROP_MAX_DAYS * 86_400_000).toISOString();
  const { data: hits, error } = await sb.from("messages").select("conversation_id, created_at")
    .eq("sender", "staff").eq("is_aix_generated", false).gte("created_at", since)
    .or("text.ilike.%ピックアップ%,text.ilike.%確認させて頂き%")
    .order("created_at", { ascending: false }).limit(2000);
  if (error) throw new Error(`promise-drop: ${error.message}`);
  const internal = new Set<string>(STAFF_INTERNAL_CONVERSATION_IDS as readonly string[]);
  const convs = [...new Set(((hits ?? []) as Array<{ conversation_id: string }>).map((r) => r.conversation_id))]
    .filter((c) => !isTestConversation(c) && !isNoLineTestConversation(c) && !internal.has(c)).slice(0, MAX_CONVS);
  const out: PromiseDrop[] & { partial?: boolean; scanned?: number; total?: number } = [];
  let scanned = 0;
  const one = async (c: string) => {
    const input = await loadPdInput(sb, c, since);
    const d = promiseDropOf(input, nowMs);
    if (d) out.push(d);
  };
  for (let k = 0; k < convs.length; k += BATCH) {
    if (Date.now() > deadline) { out.partial = true; break; }
    await Promise.all(convs.slice(k, k + BATCH).map(one));
    scanned = Math.min(convs.length, k + BATCH);
  }
  out.scanned = scanned; out.total = convs.length;
  return out;
}

/**
 * 今の会話の、期限を過ぎて果たしていない約束（事実だけ・道の言葉なし）。作業員N の統括の材料（CONDUCTOR_OVERDUE_PROMISES・既定 off）が呼ぶ。
 *   読みは1会話分（loadPdInput）。失敗は呼ぶ側で空に。
 */
export async function overduePromisesFor(sb: SupabaseClient, conversationId: string, nowMs = Date.now()): Promise<OverduePromise[]> {
  const since = new Date(nowMs - PROMISE_DROP_MAX_DAYS * 86_400_000).toISOString();
  const input = await loadPdInput(sb, conversationId, since);
  return overduePromisesOf(input, nowMs);
}

/** 朝に1回: 数えて cron_run_logs に残し、文を控える（off は何もしない）。LINE には出さない */
export async function recordPromiseDrops(sb: SupabaseClient, nowMs = Date.now()): Promise<{ mode: string; count: number } | null> {
  const mode = promiseDropWatchMode();
  if (mode === "off") return null;
  const drops = await loadPromiseDrops(sb, nowMs);
  const text = buildPromiseDropPost(drops, nowMs);
  const nowIso = new Date(nowMs).toISOString();
  await sb.from("hanbancyo_settings").upsert({ key: PROMISE_DROP_TEXT_KEY, value: JSON.stringify({ at: nowIso, text }) }, { onConflict: "key" });
  await sb.from("cron_run_logs").insert({
    cron_name: "promise-drop-watch", started_at: nowIso, finished_at: new Date().toISOString(), ok: true,
    result_json: { mode, count: drops.length, partial: !!drops.partial, scanned: drops.scanned ?? null, total: drops.total ?? null, rows: drops.map((d) => ({ conv: d.conversationId.slice(0, 8), kind: d.kind, days: d.days, spoke: d.customerSpokeAfter, dismissed: d.dismissedAfter, picks: d.readyPicksAfter })), text },
  });
  console.log(JSON.stringify({ tag: "promise-drop-watch:record", mode, count: drops.length }));
  return { mode, count: drops.length };
}

/** 営業時間の最初の便から: on の時だけ、その日の朝に控えた文を1回送る */
export async function sendPromiseDropOnce(sb: SupabaseClient, push: (text: string) => Promise<{ ok: boolean }>, nowMs = Date.now()): Promise<{ sent: boolean } | null> {
  if (promiseDropWatchMode() !== "on") return null;
  const { data: last } = await sb.from("hanbancyo_settings").select("value").eq("key", PROMISE_DROP_KEY).maybeSingle();
  if (!promiseDropDue(last?.value as string | null | undefined, nowMs)) return null;
  const { data: stored } = await sb.from("hanbancyo_settings").select("value").eq("key", PROMISE_DROP_TEXT_KEY).maybeSingle();
  let rec: { at?: string; text?: string | null } = {};
  try { rec = JSON.parse(String(stored?.value ?? "{}")); } catch { rec = {}; }
  // 今日の朝に数えた物だけ（古い控えは送らない）
  if (!rec.at || promiseDropDue(rec.at, nowMs) || !rec.text) return { sent: false };
  const r = await push(rec.text);
  if (r.ok) await sb.from("hanbancyo_settings").upsert({ key: PROMISE_DROP_KEY, value: new Date(nowMs).toISOString() }, { onConflict: "key" });
  return { sent: r.ok };
}
