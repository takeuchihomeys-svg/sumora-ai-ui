// app/lib/test-replay-floor.ts
// テスト用の会話（YUMA）に場面を入れて流す時だけ、その会話の「場面より前の記録」を読まないようにする（手元の開発サーバ・スクリプト専用）。
//
// 2026-10-01 竹内「一連の流れをYUMAにLINEでテストで繰り返して漏れなどをみつける…実際のLINEや、実際の返信のように」
//   YUMA は何か月もテストに使われ、送った物件 50件・見積書・内覧の予定・AIX の記録が積もっている。本番の会話から取った場面を入れても、
//   ブレインは「内覧予定（viewing_scheduled）・物件送付50件・見積送付済」と読み、初期費用の質問にも内覧の段階の判断をしていた
//   （scripts/yuma-replay-scenarios.ts の最初の試走: 段階の補正 customer_state:viewing_scheduled が全場面に出た）＝場面が本番の状況にならない。
//   YUMA の記録を消すと他の担当のテストが壊れるので、読む側で「線（floor）より前の行」を外す。
//
// 仕組み: app/lib/supabase.ts のクライアントの fetch を包み、PostgREST の GET の URL に「conversation_id=eq.<テスト用の会話>」がある時だけ
//   その表の時刻の列に `gte.<線>` を足す（TABLE_TIME_COLUMN の表だけ）。conversations の行（id=eq.<テスト用の会話>）は戦略・前回の判断・
//   方向・お客様の紐付けを空にして返す（YUMA の過去の判断・登録の条件を混ぜない）。書き込み（POST/PATCH/DELETE）は触らない。
// 動く条件（全部そろった時だけ）: 環境変数 REPLAY_FLOOR_FILE（線を書いたファイルの場所）があり、本番でない（isTestModeAllowed）、
//   ファイルの conversationId がテスト用の会話（isTestConversation）。本番（Vercel）には REPLAY_FLOOR_FILE を入れない＝何も変わらない。
// ファイルの形: {"conversationId":"<id>","floor":"<ISO>"}（スクリプトが場面ごとに書き換える。開発サーバとスクリプトが同じファイルを読む）
// テスト: app/lib/__tests__/test-replay-floor.test.ts
// ⚠ app/lib/supabase.ts は画面（"use client"）からも読まれる → ここで node:fs を import すると画面の束が壊れる（本番ビルドだけ落ちる）。
//   ファイルは process.getBuiltinModule で読む（サーバーの時だけ・画面では REPLAY_FLOOR_FILE が無いので呼ばれない）
import { isTestModeAllowed } from "./llm-test-mode";
import { isTestConversation } from "./test-conversations";

/** 線で切る表と時刻の列（conversation_id を持つ表のうち、ブレイン・返信生成・AIX が状況として読む物） */
export const TABLE_TIME_COLUMN: Readonly<Record<string, string>> = {
  messages: "created_at",
  aix_usage_logs: "created_at",
  sent_facts: "created_at",
  sent_properties: "sent_at",
  viewing_history: "created_at",
  viewings: "created_at",
  calendar_events: "created_at",
  line_tasks: "created_at",
  scheduled_messages: "created_at",
  brain_decision_logs: "created_at",
  estimate_records: "created_at",
  property_pickups: "created_at",
  property_pickup_completions: "created_at",
  sent_image_properties: "created_at",
  recommendation_snapshots: "created_at",
  aix_action_items: "created_at",
  ai_reply_examples: "created_at",
  template_selection_logs: "created_at",
  condition_scope_decisions: "created_at",
  conversation_checkpoints: "created_at",
  apply_period_summaries: "created_at",
  estimate_action_log: "created_at",
  // 2026-10-09 試験の担当の案（承認済み）: 結果の記録・段階の履歴も線で切る
  deal_outcomes: "computed_at",
  outcome_events: "at",
  conversation_stage_history: "changed_at",
  viewing_action_log: "created_at",
  property_recommendation_action_log: "created_at",
  application_action_log: "created_at",
  // 2026-10-08 お客様のメモ（1会話1行）: 場面より前に作った YUMA のメモを読まない
  customer_memos: "updated_at",
};

/** conversations の行で空にする列（YUMA の過去の判断・戦略・紐付けを混ぜない） */
export const CONVERSATION_BLANK_COLUMNS: readonly string[] = [
  "conversation_direction", "last_brain_meta", "suggested_aix_meta", "brain_strategy", "suggested_next_aix", "reply_mode_decision",
  "property_customer_id", "ai_draft", "ai_draft_check", "brain_analyzed_at", "brain_full_analyzed_at", "brain_full_msg_count",
  "brain_deep_analyzed_at", "brain_deep_msg_count", "has_viewed", "is_post_apply", "applying_text_received", "applying_image_received",
  "screening_last_status",
];

export type ReplayFloor = {
  conversationId: string; floor: string;
  /** お客様の条件の行の紐付けを残す（REPLAY_KEEP_PC=1・家賃の相場の材料を試す時だけ） */ keepPropertyCustomer?: boolean;
  /** 場面の状態（conversations.status の代わりに返す・無ければ proposing） */ status?: string;
  /** messages は line_message_id がこの頭の行だけ読む（同じ YUMA に他の担当が同時に入れた場面の通を混ぜない・2026-10-01 3回目の再生で混ざった） */ messageIdPrefix?: string;
};

/** URL を書き換える（純関数）。対象でなければ同じ文字列を返す */
export function rewriteRestUrl(url: string, method: string, f: ReplayFloor | null): string {
  if (!f || !/^(?:GET|HEAD)$/i.test(method || "GET")) return url;
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  const m = u.pathname.match(/\/rest\/v1\/([a-z_]+)$/);
  if (!m) return url;
  const col = TABLE_TIME_COLUMN[m[1]];
  if (!col) return url;
  const conv = u.searchParams.getAll("conversation_id");
  const only = conv.length > 0 && conv.every((v) => v === `eq.${f.conversationId}` || v === `in.(${f.conversationId})` || v === `in.("${f.conversationId}")`);
  // brain-core の送った物件は .or("property_customer_id.eq.X,conversation_id.eq.<会話>") で引く（会話と、その会話のお客様の行だけ）
  const orOnly = conv.length === 0 && u.searchParams.getAll("or").some((v) => {
    const clauses = v.replace(/^\(|\)$/g, "").split(",");
    return clauses.includes(`conversation_id.eq.${f.conversationId}`) && clauses.every((c) => c === `conversation_id.eq.${f.conversationId}` || /^property_customer_id\.eq\.[0-9a-f-]{36}$/.test(c));
  });
  if (!only && !orOnly) return url;
  u.searchParams.append(col, `gte.${f.floor}`);
  if (m[1] === "messages" && f.messageIdPrefix) u.searchParams.append("line_message_id", `like.${f.messageIdPrefix}*`);
  return u.toString();
}

/** conversations の行の読み取りか（id=eq.<テスト用の会話>） */
export function isConversationRowRead(url: string, method: string, f: ReplayFloor | null): boolean {
  if (!f || !/^GET$/i.test(method || "GET")) return false;
  try {
    const u = new URL(url);
    return /\/rest\/v1\/conversations$/.test(u.pathname) && u.searchParams.getAll("id").some((v) => v === `eq.${f.conversationId}`);
  } catch { return false; }
}

/** conversations の行（配列か1行）の列を空にする（純関数） */
// 2026-10-02 ⑫: keepPropertyCustomer＝お客様の条件の行（property_customer_id）だけは残す（家賃の相場の材料を試す再生・REPLAY_KEEP_PC=1）
export function blankConversationRow(body: unknown, status = "proposing", keepPropertyCustomer = false): unknown {
  const blank = (r: unknown) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) return r;
    const o = { ...(r as Record<string, unknown>) };
    for (const k of CONVERSATION_BLANK_COLUMNS) if (k in o && !(keepPropertyCustomer && k === "property_customer_id")) o[k] = k === "brain_full_msg_count" || k === "brain_deep_msg_count" ? 0 : k === "has_viewed" || k === "is_post_apply" || k.startsWith("applying_") ? false : null;
    if ("status" in o) o.status = status;
    return o;
  };
  return Array.isArray(body) ? body.map(blank) : blank(body);
}

let cache: { at: number; v: ReplayFloor | null } = { at: 0, v: null };
/** 線を読む（1秒だけ覚える）。動く条件がそろわなければ null */
export function currentReplayFloor(env: Record<string, string | undefined> = process.env): ReplayFloor | null {
  const file = env.REPLAY_FLOOR_FILE;
  if (!file || !isTestModeAllowed(env)) return null;
  const now = Date.now();
  if (now - cache.at < 1000) return cache.v;
  let v: ReplayFloor | null = null;
  try {
    const fsm = (globalThis.process as unknown as { getBuiltinModule?: (m: string) => { readFileSync: (p: string, e: string) => string } | undefined })?.getBuiltinModule?.("node:fs");
    if (!fsm) throw new Error("no fs");
    const j = JSON.parse(fsm.readFileSync(file, "utf8")) as Partial<ReplayFloor>;
    if (j && typeof j.conversationId === "string" && isTestConversation(j.conversationId) && typeof j.floor === "string" && Number.isFinite(Date.parse(j.floor))) {
      v = { conversationId: j.conversationId, floor: new Date(Date.parse(j.floor)).toISOString(), ...(j.keepPropertyCustomer === true ? { keepPropertyCustomer: true } : {}), ...(typeof j.status === "string" && /^[a-z_]{2,30}$/.test(j.status) ? { status: j.status } : {}), ...(typeof j.messageIdPrefix === "string" && /^[a-z0-9-]{3,30}$/.test(j.messageIdPrefix) ? { messageIdPrefix: j.messageIdPrefix } : {}) };
    }
  } catch { v = null; }
  cache = { at: now, v };
  return v;
}

/** Supabase のクライアントに渡す fetch（REPLAY_FLOOR_FILE が無い時は呼ばれない＝supabase.ts が包まない） */
export const replayFloorFetch: typeof fetch = async (input, init) => {
  const f = currentReplayFloor();
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  const method = (init?.method ?? (typeof input === "object" && !(input instanceof URL) ? (input as Request).method : "GET")) || "GET";
  if (!f) return globalThis.fetch(input, init);
  const next = rewriteRestUrl(url, method, f);
  const res = await globalThis.fetch(next === url ? input : next, init);
  if (!isConversationRowRead(url, method, f) || !res.ok) return res;
  try {
    const text = await res.text();
    const body = blankConversationRow(JSON.parse(text), f.status, f.keepPropertyCustomer === true);
    const headers = new Headers(res.headers);
    headers.delete("content-length"); headers.delete("content-encoding");
    return new Response(JSON.stringify(body), { status: res.status, statusText: res.statusText, headers });
  } catch {
    return res;
  }
};
