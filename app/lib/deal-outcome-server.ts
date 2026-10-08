// app/lib/deal-outcome-server.ts — 結果の台帳の材料を DB から読み、deal_outcomes / outcome_events に書く（サーバー専用・LLM なし）。
//   決まりは deal-outcome.ts（純関数）。ここは読む・書くだけ。計画: memory/plan_outcome_ledger.md
//   ⚠ 画面から import しない（supabase を読む）。
//   書くのは新しい2つの表だけ（元の表は1行も書き換えない）。outcome_events は会話ごとに消して作り直す（派生・元の表が正）。
//   deal_outcomes は locked=true の行（スタッフが手で付けた結果・いずれ申込のツールから受けた結果）を上書きしない。
import { createHash } from "node:crypto";
import { supabase } from "@/app/lib/supabase";
import { loadCustomerStateInput } from "@/app/lib/customer-state-server";
import { resolveCustomerState } from "@/app/lib/customer-state";
import { isTestConversation } from "@/app/lib/test-conversations";
import {
  resolveDealOutcomes, buildOutcomeEventRows, toDealOutcomeRow,
  type DealInput, type DealPropertyClue, type RawOutcomeEvent, type DealEpisode, type OutcomeEventRow, type DealOutcomeRow, type StageHistoryRow,
} from "@/app/lib/deal-outcome";
import { turnSceneAt, stageBucketAt } from "@/app/lib/application-reach";

type Sb = typeof supabase;
const shortHash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

/** 申込の物件の手がかりにする AIX（物件ピックアップの束は名前が多く手がかりにならない） */
const CLUE_AIX_TYPES = new Set(["estimate_sheet", "property_check_result", "meeting_place", "application_push", "viewing_invite"]);
/** 物件を送った AIX（段階「物件送付」） */
const PROPERTY_SENT_AIX_TYPES = new Set(["property_send", "property_recommendation", "new_arrival"]);
/** 出来事に写す sent_facts の種類（properties_sent・estimate_sent は他の表と重なるので写さない） */
const FACT_KINDS_TO_EVENTS = new Set(["viewing_invited", "meeting_place_sent", "application_guided", "confirmation_reported", "confirmation_promised", "pickup_declared", "estimate_declared", "condition_asked", "call_requested", "followup_sent", "question_asked", "cost_explained", "cost_breakdown_explained"]);

export type ComputedOutcome = { conversationId: string; episodes: DealEpisode[]; rows: DealOutcomeRow[]; events: OutcomeEventRow[] };

async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const r = await p;
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return (r.data ?? ([] as unknown)) as T;
}

/** 1会話の台帳を計算する（書かない）。会話が無い・テスト用は null */
export async function computeConversationOutcome(conversationId: string, opts: { nowMs?: number; db?: Sb } = {}): Promise<ComputedOutcome | null> {
  if (isTestConversation(conversationId)) return null;
  const db = opts.db ?? supabase;
  const nowMs = opts.nowMs ?? Date.now();
  const [conv, csInput, first, hist, decisions, aix, est, recs, imgs, facts] = await Promise.all([
    must(db.from("conversations").select("id, status, line_status, created_at, updated_at, status_manual_back_at, is_post_apply, screening_last_status").eq("id", conversationId).maybeSingle(), "conversations"),
    loadCustomerStateInput(conversationId, { now: nowMs }),
    must(db.from("messages").select("created_at").eq("conversation_id", conversationId).order("created_at", { ascending: true }).limit(1), "messages:first"),
    must(db.from("conversation_stage_history").select("id, from_status, to_status, changed_at, trigger").eq("conversation_id", conversationId).order("changed_at").limit(500), "stage_history"),
    must(db.from("brain_decision_logs").select("id, created_at, suggested_action, decision_source, actual_aix_type, actual_at, analyzed_msg_ts, scene_key, prop:digest->>prop").eq("conversation_id", conversationId).order("created_at").limit(3000), "brain_decision_logs"),
    must(db.from("aix_usage_logs").select("id, aix_type, check_pattern, created_at, sent_at, property_names").eq("conversation_id", conversationId).not("sent_at", "is", null).order("created_at").limit(2000), "aix_usage_logs"),
    must(db.from("estimate_records").select("id, created_at, property_name, room_no").eq("conversation_id", conversationId).order("created_at").limit(1000), "estimate_records"),
    must(db.from("recommendation_snapshots").select("id, created_at, sent_at, star_name, star_room").eq("conversation_id", conversationId).order("created_at").limit(1000), "recommendation_snapshots"),
    must(db.from("sent_image_properties").select("image_url, created_at, property_name, room_no, source, channel").eq("conversation_id", conversationId).order("created_at").limit(3000), "sent_image_properties"),
    must(db.from("sent_facts").select("id, sent_at, kind").eq("conversation_id", conversationId).order("sent_at").limit(3000), "sent_facts"),
  ]);
  const c = conv as { status: string | null; line_status: string | null; created_at: string | null; updated_at: string | null; status_manual_back_at: string | null; is_post_apply: boolean | null; screening_last_status: string | null } | null;
  if (!c || !csInput) return null;
  const state = resolveCustomerState(csInput);

  type H = StageHistoryRow & { id: string };
  type D = { id: string; created_at: string; suggested_action: string | null; decision_source: string | null; actual_aix_type: string | null; actual_at: string | null; analyzed_msg_ts: string | null; scene_key: string | null; prop: string | null };
  type A = { id: string; aix_type: string; check_pattern: string | null; created_at: string; sent_at: string | null; property_names: string[] | null };
  type E = { id: number; created_at: string; property_name: string | null; room_no: string | null };
  type R = { id: number; created_at: string; sent_at: string | null; star_name: string | null; star_room: string | null };
  type I = { image_url: string; created_at: string; property_name: string | null; room_no: string | null; source: string | null; channel: string | null };
  type F = { id: string; sent_at: string; kind: string };
  const histRows = hist as H[]; const dRows = decisions as D[]; const aRows = aix as A[]; const eRows = est as E[]; const rRows = recs as R[]; const iRows = imgs as I[]; const fRows = facts as F[];

  const clues: DealPropertyClue[] = [];
  const raw: RawOutcomeEvent[] = [];
  const propertySentAts: string[] = [];
  const conditionAts: string[] = [];

  // 申込の物件（本文の「〇〇の申込を進め…」・customer-state のお部屋の出来事 application）
  for (const r of state.properties) for (const ev of r.events) if (ev.kind === "application") clues.push({ kind: "application_text", at: ev.at, name: r.name, room: r.room, sourceTable: "customer_state", sourceId: `${r.key}:${ev.at}` });
  for (const v of state.viewings) {
    if (v.name) clues.push({ kind: "viewing", at: v.thankedAt ?? `${v.ymd}T12:00:00+09:00`, name: v.name, sourceTable: "customer_state", sourceId: `viewing:${v.ymd}` });
    if (v.status !== "cancelled") raw.push({ at: `${v.ymd}T${(v.time ?? "12:00").slice(0, 5)}:00+09:00`, kind: "viewing_scheduled", sourceTable: "customer_state", sourceId: `viewing:${v.ymd}`, propertyName: v.name, detail: { status: v.status } });
    if (v.status === "done") raw.push({ at: v.thankedAt ?? `${v.ymd}T20:00:00+09:00`, kind: "viewing_held", sourceTable: "customer_state", sourceId: `viewing:${v.ymd}`, propertyName: v.name, detail: { by: v.thankedAt ? "thanks" : "record" } });
  }
  for (const e of eRows) {
    if (e.property_name) clues.push({ kind: "estimate", at: e.created_at, name: e.property_name, room: e.room_no, sourceTable: "estimate_records", sourceId: String(e.id) });
    raw.push({ at: e.created_at, kind: "estimate", sourceTable: "estimate_records", sourceId: String(e.id), propertyName: e.property_name, room: e.room_no });
  }
  // AIX と判断の対: brain-aix-eval が判断の行に actual_at を書いている → 同じ種類で2分以内の判断。無ければ24時間以内の直前の判断
  const decisionFor = (a: A): string | null => {
    const t = Date.parse(a.sent_at ?? a.created_at);
    const paired = dRows.find((d) => d.actual_aix_type === a.aix_type && d.actual_at && Math.abs(Date.parse(d.actual_at) - t) <= 120_000);
    if (paired) return paired.id;
    let prev: D | null = null;
    for (const d of dRows) { const dt = Date.parse(d.created_at); if (dt <= t && t - dt <= 86_400_000) prev = d; }
    return prev?.id ?? null;
  };
  for (const a of aRows) {
    const at = a.sent_at ?? a.created_at;
    const names = (a.property_names ?? []).filter(Boolean);
    if (CLUE_AIX_TYPES.has(a.aix_type) && names.length >= 1 && names.length <= 2) clues.push({ kind: "aix", at, name: names[0], sourceTable: "aix_usage_logs", sourceId: a.id });
    if (PROPERTY_SENT_AIX_TYPES.has(a.aix_type)) propertySentAts.push(at);
    if (a.aix_type === "condition_hearing") conditionAts.push(at);
    raw.push({ at, kind: "aix_sent", sourceTable: "aix_usage_logs", sourceId: a.id, propertyName: names.length === 1 ? names[0] : null, decisionId: decisionFor(a),
      detail: { aix_type: a.aix_type, ...(a.check_pattern ? { check_pattern: a.check_pattern } : {}), ...(names.length ? { n_props: names.length } : {}) } });
  }
  // 2026-10-08 ⑥: 判断の場面（reply-scene・ブレインの brainScene と同じ形）と段階（内覧前／内覧後）を出来事に残す＝申込到達率（application-reach.ts）の材料。
  //   判断の行に scene_key があればそれ（10/08 以降）・無ければ読んだお客様の番の文から作る
  const msgsOldest = [...csInput.messages].map((m) => ({ sender: m.sender, text: m.text, createdAt: m.createdAt })).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const viewingAts = state.viewings.filter((v) => v.status !== "cancelled").map((v) => v.thankedAt ?? `${v.ymd}T12:00:00+09:00`);
  for (const d of dRows) {
    const readAt = Date.parse(d.analyzed_msg_ts ?? d.created_at);
    const scene = d.scene_key ?? (Number.isFinite(readAt) ? turnSceneAt(msgsOldest, readAt) : null);
    const bucket = stageBucketAt(viewingAts, Date.parse(d.created_at));
    if (d.prop) clues.push({ kind: "brain", at: d.created_at, name: d.prop, sourceTable: "brain_decision_logs", sourceId: d.id });
    raw.push({ at: d.created_at, kind: "brain_decision", sourceTable: "brain_decision_logs", sourceId: d.id, propertyName: d.prop, decisionId: d.id,
      detail: { action: d.suggested_action || null, src: d.decision_source, ...(scene ? { scene } : {}), vb: bucket } });
  }
  for (const r of rRows) {
    const at = r.sent_at ?? r.created_at;
    propertySentAts.push(at);
    raw.push({ at, kind: "recommendation", sourceTable: "recommendation_snapshots", sourceId: String(r.id), propertyName: r.star_name, room: r.star_room });
  }
  for (const i of iRows) {
    if (i.property_name) clues.push({ kind: "image", at: i.created_at, name: i.property_name, room: i.room_no, sourceTable: "sent_image_properties", sourceId: shortHash(i.image_url) });
    raw.push({ at: i.created_at, kind: "image_sent", sourceTable: "sent_image_properties", sourceId: `${shortHash(i.image_url)}:${shortHash(`${i.property_name ?? ""}|${i.room_no ?? ""}`)}`, propertyName: i.property_name, room: i.room_no,
      detail: { source: i.source, channel: i.channel } });
  }
  for (const f of fRows) {
    if (f.kind === "properties_sent") propertySentAts.push(f.sent_at);
    if (f.kind === "condition_asked") conditionAts.push(f.sent_at);
    if (FACT_KINDS_TO_EVENTS.has(f.kind)) raw.push({ at: f.sent_at, kind: "fact", sourceTable: "sent_facts", sourceId: f.id, detail: { kind: f.kind } });
  }
  for (const h of histRows) {
    if (h.to_status === "condition_hearing") conditionAts.push(h.changed_at);
    raw.push({ at: h.changed_at, kind: "stage_change", sourceTable: "conversation_stage_history", sourceId: h.id, detail: { from: h.from_status, to: h.to_status, trigger: h.trigger } });
  }

  const input: DealInput = {
    conversationId, nowMs,
    status: c.status, lineStatus: c.line_status, createdAt: c.created_at, updatedAt: c.updated_at,
    statusManualBackAt: c.status_manual_back_at, isPostApply: c.is_post_apply, screeningLastStatus: c.screening_last_status,
    stageHistory: histRows,
    messages: csInput.messages.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.createdAt })),
    firstMessageAt: (first as Array<{ created_at: string }>)[0]?.created_at ?? null,
    viewings: state.viewings.map((v) => ({ ymd: v.ymd, status: v.status, thankedAt: v.thankedAt, name: v.name })),
    propertySentAts, conditionAts, clues,
  };
  const episodes = resolveDealOutcomes(input);
  const computedAt = new Date(nowMs).toISOString();
  return {
    conversationId, episodes,
    rows: episodes.map((e) => toDealOutcomeRow(conversationId, e, computedAt)),
    events: buildOutcomeEventRows(conversationId, raw, episodes),
  };
}

/** 計算した台帳を書く（deal_outcomes は locked の行を残す・outcome_events は会話ごとに作り直す） */
export async function writeConversationOutcome(o: ComputedOutcome, opts: { db?: Sb } = {}): Promise<{ rows: number; events: number; lockedKept: number }> {
  const db = opts.db ?? supabase;
  const existing = await must(db.from("deal_outcomes").select("episode_no, locked, lost_type, lost_reason, lost_reason_source").eq("conversation_id", o.conversationId), "deal_outcomes:read") as Array<{ episode_no: number; locked: boolean | null; lost_type: string | null; lost_reason: string | null; lost_reason_source: string | null }>;
  const locked = new Set(existing.filter((r) => r.locked).map((r) => r.episode_no));
  // 段4 で DeepSeek が読んだ理由は、失注の型が同じ間は残す（毎日の作り直しで型の理由に戻さない）
  const llmReason = new Map(existing.filter((r) => r.lost_reason_source === "deepseek").map((r) => [r.episode_no, r]));
  const rows = o.rows.filter((r) => !locked.has(r.episode_no)).map((r) => {
    const kept = llmReason.get(r.episode_no);
    const keep = kept && kept.lost_type === r.lost_type ? { lost_reason: kept.lost_reason as typeof r.lost_reason, lost_reason_source: "deepseek" as const } : null;
    return { ...r, ...(keep ?? {}), updated_at: new Date().toISOString() };
  });
  if (rows.length) {
    const { error } = await db.from("deal_outcomes").upsert(rows, { onConflict: "conversation_id,episode_no" });
    if (error) throw new Error(`deal_outcomes upsert: ${error.message}`);
  }
  const maxNo = o.rows.length;
  const stale = existing.filter((r) => r.episode_no > maxNo && !r.locked).map((r) => r.episode_no);
  if (stale.length) {
    const { error } = await db.from("deal_outcomes").delete().eq("conversation_id", o.conversationId).in("episode_no", stale);
    if (error) throw new Error(`deal_outcomes delete stale: ${error.message}`);
  }
  const { error: delErr } = await db.from("outcome_events").delete().eq("conversation_id", o.conversationId);
  if (delErr) throw new Error(`outcome_events delete: ${delErr.message}`);
  for (let i = 0; i < o.events.length; i += 500) {
    const { error } = await db.from("outcome_events").insert(o.events.slice(i, i + 500));
    if (error) throw new Error(`outcome_events insert: ${error.message}`);
  }
  return { rows: rows.length, events: o.events.length, lockedKept: locked.size };
}

/** 台帳を作る会話の一覧（テスト用・身内を除く・新しい順）。since は会話の作成日 */
export async function listOutcomeConversations(opts: { db?: Sb; sinceCreated?: string | null; activeSince?: string | null; limit?: number } = {}): Promise<string[]> {
  const db = opts.db ?? supabase;
  const out: string[] = [];
  for (let from = 0; from < 20_000; from += 1000) {
    let q = db.from("conversations").select("id").order("updated_at", { ascending: false }).range(from, from + 999);
    if (opts.sinceCreated) q = q.gte("created_at", opts.sinceCreated);
    if (opts.activeSince) q = q.gte("updated_at", opts.activeSince);
    const { data, error } = await q;
    if (error) throw new Error(`conversations list: ${error.message}`);
    for (const r of (data ?? []) as Array<{ id: string }>) if (!isTestConversation(r.id)) out.push(r.id);
    if ((data ?? []).length < 1000) break;
  }
  return opts.limit ? out.slice(0, opts.limit) : out;
}
