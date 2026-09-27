// scripts/customer-sim.ts
// お客様役（テスト・YUMA 専用）の往復を回す。2026-09-27 竹内「YUMA で自動的に YUMA から自動返信が来て、返信を繰り返せたら理想」。
//
// 1往復 = ①お客様役: 本番の /api/test/customer-sim が筋書きの段から DeepSeek でお客様の返事を作り、webhook と同じ関数で YUMA に入れる
//           （LINE は通らない＝YUMA の LINE には出ない・画面の会話にだけ入る。印は messages.line_message_id="sim-…"）
//         ②本番の流れのまま: 下書きの起動（bg-async）→ブレイン（Claude）→返信の生成（DeepSeek）を待つ
//         ③スタッフ役: ブレインが AIX（会話だけで作れる種類）を選んだら本番の /api/aix/action で作って送る／AIX なしなら下書きを送る
//           （送るのは本番の /api/send-line-message ＝ YUMA の LINE に実際に届く。記録は画面の送信と同じ形で messages・会話・判断の結果へ）
//           材料が要る AIX（見積書・物件確認した・物件ピックアップ/オススメ・内覧へ・待ち合わせ）は、保存済みの材料（YUMA の見積書・
//           ピックアップの画像/資料・会話の日時／固定の候補・「募集中」の設定）を app/lib/customer-sim-material.ts で選んで、
//           画面（AixModal・page.tsx）と同じ API・同じ引数・同じ順番（画像をまとめて→本文）・同じ記録（messages・log-aix-usage・mark_sent）で送る。
//           材料が揃わない AIX（管理会社の回答・保証会社・電話 等）だけ止めて理由を出す → 画面で送ってからもう一度動かすと続きから
//           画面が送った後に作るカレンダー（待ち合わせ後の内覧の予定・内覧へ！の時間確保）は作らない（お客様役の決まり）
//         ④記録: お客様役の文・ブレインの判断・下書き・送った文・トークの上の状況・送った事実の変化・費用・検査
//
// 使い方（本番の入口に CUSTOMER_SIM_ENABLED=1 が入っていること）:
//   npx tsx --env-file=.env.local scripts/customer-sim.ts --scenario=like_estimate_viewing            … 筋書きの終わりまで自動
//   npx tsx --env-file=.env.local scripts/customer-sim.ts --scenario=like_estimate_viewing --step     … 1往復だけ（続きはもう一度同じ命令）
//   npx tsx --env-file=.env.local scripts/customer-sim.ts --scenario=like_estimate_viewing --no-send  … スタッフの送信の直前で止める（送る文を見るだけ）
//   npx tsx --env-file=.env.local scripts/customer-sim.ts --list                                       … 筋書きの一覧
//   npx tsx --env-file=.env.local scripts/customer-sim.ts --dry                                        … お客様役の文を作るだけ（入れない・送らない）
//   その他: --rounds=N（往復の上限・既定12）／--reset（筋書きの最初から）／--text="…"（この1回はお客様役の文を固定）
//           --base=http://localhost:3000（入口の場所）／--force（直近30分に竹内さんの本物の発言があっても進める）
//           --at-step=N（筋書きの N 段目から始める・1始まり。途中の会話から続ける時）
//           --shadow（影の道: ブレインが選ばなかった方も作って突き合わせる・送らない。app/lib/customer-sim-shadow.ts）
//             --shadow-base=http://localhost:3000（影を作る入口・既定は手元＝LLM_TEST_MODE=deepseek-all の開発サーバ。本番の入口では作らない）
//             --shadow-images（画像を読む AIX〈見積書・物件確認した・ピックアップ/オススメ〉も影で作る・Vision は Claude のまま）
//   スタッフ役の送り方（2026-09-27 竹内「実際のスタッフが送ったようになるように／AIXを活用しながらテスト進めていく」・app/lib/staff-send-pattern.ts）:
//     ・押す AIX は画面に出ている AIX（resolveAixButtonView）。ブレインの判断と違えば「⚠ 画面:」のズレに出す
//     ・ピッカーは場面から（simPickerFor→pickerForScene）選び、AIX の生成と log-aix-usage に画面と同じ形で渡す（申込フォーマットは画面の固定文）
//     ・実送信の割合で: 返信→AIX（往復の番号で決める・乱数でない）／物件ピックアップした→物件オススメ（75%）／AIX の後の一言
//       （見積書送る・申込へ〈フォーマットの後〉・物件オススメ＝送信後のバナーのテンプレ→画面と同じ AI 最適化）
//     --staff-simple（旧の動き: ブレインの AIX をそのまま押す・一言なし・ピッカーは今まで通り）
//   送る物件の画像は pickSendImageUrl（trim_image_url＝元の資料の1ページ目だけ）。trim の無い物件は送らず理由を出す
//   内部認証の値は環境変数 INTERNAL_API_SECRET、無ければ .env.prod から読む（画面に出さない）
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";
import { isSimLineMessageId } from "../app/lib/customer-sim-guard";
import {
  getScenario, listScenarios, advanceCursor, planStaffAction, auditSimTurn, summarizeSimAudit, simAuditKindJa,
  type SimCursor, type SimAuditFinding, type SimHistoryItem,
} from "../app/lib/customer-sim";
import { draftToSendableText } from "../app/lib/draft-text";
import { getCustomerState } from "../app/lib/customer-state-server";
import {
  addressFromPdfText, alignEstimateText, buildMeetingPlaceText, describeSimMaterial, groundingOfMaterial, mustShowOfMaterial,
  type SimAixMaterial, type SimMaterialPool, type SimEstimateSource, type SimPickupSource,
} from "../app/lib/customer-sim-material";
import { sameBuilding } from "../app/lib/customer-sim-material";
import { judgeShadowTurn, summarizeShadow, type ShadowFinding } from "../app/lib/customer-sim-shadow";
import { runShadowTurn, generateReplyAcceptsShadow, isLocalBase, type ShadowTurnResult } from "../app/lib/customer-sim-shadow-run";
import { pickSendImageUrl } from "../app/lib/pickup-send-image";
import { pickSimMaterial } from "../app/lib/customer-sim-material";
import type { PickerChoice } from "../app/lib/aix-pickers";
import {
  decideSimStaffTurn, checkAfterReply, secondAixMaterial, simPickerFor, pickerLogFields, pickerAixBody, followupAllowed, followupPropertyLabel,
  pickupsWithoutSendImage, summarizeViewMismatch, simRowShape, REAL_SHAPE_RATE, STAFF_TURN_SHAPE_JA, SIM_AIX_VIEW_MISMATCH_JA,
  type SimBrainMetaLike, type SimViewMismatch, type StaffTurnShape,
} from "../app/lib/staff-send-pattern";
import { simAixView, draftForReplyFirst, makeFollowup, appFormatText, type FollowupResult } from "../app/lib/customer-sim-staff-run";

const CONV = YUMA_CONVERSATION_ID;
const args = process.argv.slice(2);
const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
const flag = (k: string) => args.includes(`--${k}`);
const BASE = (arg("base") ?? "https://sumora-ai-ui.vercel.app").replace(/\/$/, "");
const MAX_ROUNDS = Math.max(1, Number(arg("rounds") ?? 12) | 0);
const SETTLE_MS = Math.max(0, Number(arg("settle") ?? 15) * 1000);
const BRAIN_WAIT_MS = Math.max(30, Number(arg("wait") ?? 240)) * 1000;
const DIR = join(tmpdir(), "sumora-customer-sim");
const STATE_FILE = join(DIR, "state.json");
// 影の道（--shadow の時だけ）: 手元の開発サーバで作る。generate-reply が書かない呼び方を持つ時だけ影の下書きを作る
const SHADOW = flag("shadow");
const SHADOW_BASE = (arg("shadow-base") ?? "http://localhost:3000").replace(/\/$/, "");
// スタッフ役の送り方（staff-send-pattern.ts）。--staff-simple で旧の動き
const STAFF_SIMPLE = flag("staff-simple");
/** 元の資料の画像（trim）が無いので送らないピックアップ（loadMaterialPool が毎回入れ直す） */
let noSendImagePickups: string[] = [];
const SHADOW_DRAFT_OK = SHADOW && isLocalBase(SHADOW_BASE) && existsSync("app/api/generate-reply/route.ts")
  && generateReplyAcceptsShadow(readFileSync("app/api/generate-reply/route.ts", "utf8"));

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jst = (iso: string | null | undefined) => iso ? new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ") : "-";
const one = (s: string | null | undefined, n = 80) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// 単価（$/1M）: 入力・キャッシュ読み・5分書き・1時間書き・出力（scripts/peek-brain-cost-day.ts と同じ）
const PRICE: Record<string, [number, number, number, number, number]> = { haiku: [1, 0.1, 1.25, 2, 5], sonnet: [3, 0.3, 3.75, 6, 15], opus: [5, 0.5, 6.25, 10, 25], deepseek: [0.28, 0.028, 0, 0, 0.42] };
type UsageRow = { model: string | null; action: string | null; input_uncached: number; cache_read: number; cache_write: number; cache_write_5m: number; cache_write_1h: number; output_tokens: number; thinking_tokens: number };
function usd(r: UsageRow): number {
  const m = (r.model ?? "").toLowerCase();
  const p = PRICE[m.includes("deepseek") || m.includes("jev") ? "deepseek" : m.includes("haiku") ? "haiku" : m.includes("opus") ? "opus" : "sonnet"];
  const w5 = r.cache_write_5m || (r.cache_write_1h ? 0 : r.cache_write) || 0;
  return (r.input_uncached * p[0] + r.cache_read * p[1] + w5 * p[2] + (r.cache_write_1h || 0) * p[3] + (r.output_tokens + (r.thinking_tokens || 0)) * p[4]) / 1e6;
}

function internalSecret(): string {
  const env = (process.env.INTERNAL_API_SECRET ?? "").trim();
  if (env) return env;
  if (existsSync(".env.prod")) {
    const line = readFileSync(".env.prod", "utf8").split(/\r?\n/).find((l) => l.startsWith("INTERNAL_API_SECRET="));
    const v = (line ?? "").slice("INTERNAL_API_SECRET=".length).trim().replace(/^"(.*)"$/, "$1");
    if (v) return v;
  }
  throw new Error("内部認証の値がありません（INTERNAL_API_SECRET か .env.prod）");
}
const authHeaders = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${internalSecret()}` });

type State = { runId: string; scenarioId: string; cursor: SimCursor; round: number; startedAt: string; finished: boolean };
function loadState(scenarioId: string): State {
  mkdirSync(DIR, { recursive: true });
  if (!flag("reset") && existsSync(STATE_FILE)) {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
    if (s.scenarioId === scenarioId && !s.finished) {
      const at = Number(arg("at-step") ?? 0) | 0;
      if (at >= 1) s.cursor = { stepIndex: at - 1, turnsOnStep: 0 };
      return s;
    }
  }
  const now = new Date();
  const at = Number(arg("at-step") ?? 0) | 0;
  return { runId: `${scenarioId}-${now.toISOString().replace(/[:.]/g, "").slice(0, 15)}`, scenarioId, cursor: { stepIndex: at >= 1 ? at - 1 : 0, turnsOnStep: 0 }, round: 0, startedAt: now.toISOString(), finished: false };
}
const saveState = (s: State) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

type MsgRow = { id: string; sender: string; text: string | null; created_at: string; line_message_id: string | null; is_aix_generated: boolean | null; image_url: string | null };
async function recentMessages(limit = 30): Promise<MsgRow[]> {
  const { data, error } = await sb.from("messages").select("id, sender, text, created_at, line_message_id, is_aix_generated, image_url")
    .eq("conversation_id", CONV).order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error(`messages: ${error.message}`);
  return ((data ?? []) as MsgRow[]).reverse();
}
type ConvRow = { line_user_id: string; account: string | null; customer_name: string | null; status: string | null; ai_draft: string | null; suggested_aix_meta: Record<string, unknown> | null; property_customer_id: string | null };
async function conv(): Promise<ConvRow> {
  const { data, error } = await sb.from("conversations").select("line_user_id, account, customer_name, status, ai_draft, suggested_aix_meta, property_customer_id").eq("id", CONV).maybeSingle();
  if (error || !data) throw new Error(`conversations: ${error?.message ?? "なし"}`);
  return data as ConvRow;
}

async function callSim(body: Record<string, unknown>): Promise<{ ok: boolean; text?: string; goal_reached?: boolean | null; source?: string; usage?: { input: number; output: number; cacheHit: number; model: string } | null; injected?: { lineMessageId: string; messageId: string | null } | null; error?: string }> {
  const res = await fetch(`${BASE}/api/test/customer-sim`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ conversation_id: CONV, ...body }), signal: AbortSignal.timeout(120_000) });
  const j = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${j.error ?? ""}` };
  return j;
}

/** ブレインの判断（今のお客様の発言を見た物）と下書きを待つ */
async function waitForBrainAndDraft(customerAt: string): Promise<{ meta: Record<string, unknown> | null; draft: string | null; waitedMs: number }> {
  const t0 = Date.now();
  const since = Date.parse(customerAt) - 2000;
  let meta: Record<string, unknown> | null = null;
  while (Date.now() - t0 < BRAIN_WAIT_MS) {
    const c = await conv();
    const m = c.suggested_aix_meta;
    const at = m && typeof m.analyzed_msg_ts === "string" ? Date.parse(m.analyzed_msg_ts) : NaN;
    if (m && Number.isFinite(at) && at >= since) meta = m;
    // 画面で YUMA を開いていると表示の時に会話の判断が消えることがある → 判断の記録（brain_decision_logs）から読む
    if (!meta) {
      const { data: bl } = await sb.from("brain_decision_logs").select("suggested_action, suggested_reply_mode, suggested_check_pattern, analyzed_msg_ts")
        .eq("conversation_id", CONV).gte("analyzed_msg_ts", new Date(since).toISOString()).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (bl) meta = { action: bl.suggested_action ?? null, reply_mode: bl.suggested_reply_mode ?? null, check_pattern: bl.suggested_check_pattern ?? null, analyzed_msg_ts: bl.analyzed_msg_ts, _from: "brain_decision_logs" };
    }
    if (meta) {
      const plan = planStaffAction(meta as { action?: string | null; reply_mode?: string | null; check_pattern?: string | null });
      const draft = draftToSendableText(c.ai_draft);
      if (plan.kind !== "draft") return { meta, draft, waitedMs: Date.now() - t0 };
      if (draft) return { meta, draft, waitedMs: Date.now() - t0 };
    }
    await sleep(5000);
  }
  const c = await conv();
  return { meta, draft: draftToSendableText(c.ai_draft), waitedMs: Date.now() - t0 };
}

type AixGenResponse = { message_text?: string; notice?: string; error?: string; estimate_sent?: boolean; prop_cost_notes?: string[]; parsed_estimate?: unknown };
async function generateAixRaw(action: string, checkPattern: string | null, c: ConvRow, msgs: MsgRow[], extra: Record<string, unknown> = {}, conversationMatch = true): Promise<{ text: string | null; raw: AixGenResponse }> {
  const res = await fetch(`${BASE}/api/aix/action`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action, account: c.account ?? "sumora", conversation_id: CONV, customer_name: c.customer_name ?? "",
      ...(conversationMatch ? { conversation_match: true } : {}), ...(checkPattern ? { check_pattern: checkPattern } : {}),
      recent_messages: msgs.slice(-20).map((m) => ({ sender: m.sender, text: m.text ?? "", rawCreatedAt: m.created_at, isAix: !!m.is_aix_generated, imageUrl: m.image_url ?? undefined })),
      ...extra,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const j = await res.json().catch(() => ({})) as AixGenResponse;
  if (!res.ok) throw new Error(`AIX の生成に失敗: HTTP ${res.status} ${j.error ?? ""}`);
  return { text: draftToSendableText(j.message_text ?? null), raw: j };
}
async function generateAix(action: string, checkPattern: string | null, c: ConvRow, msgs: MsgRow[]): Promise<string | null> {
  return (await generateAixRaw(action, checkPattern, c, msgs)).text;
}

/** 画面の送信（page.tsx の handleSend / sendMessageText）と同じ記録で送る */
async function sendAsStaff(text: string, isAix: boolean, c: ConvRow, aixType: string | null, checkPattern: string | null, predicted: string | null, logExtra: Record<string, unknown> = {}): Promise<{ lineMessageId: string | null }> {
  const res = await fetch(`${BASE}/api/send-line-message`, {
    method: "POST", headers: authHeaders(),
    body: JSON.stringify({ line_user_id: c.line_user_id, message: text, account: c.account ?? "sumora", conversation_id: CONV, origin: isAix ? "aix" : "manual" }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await res.json().catch(() => ({})) as { sentMessageIds?: string[]; error?: string };
  if (!res.ok) throw new Error(`LINE 送信に失敗: HTTP ${res.status} ${j.error ?? ""}`);
  const lineMessageId = j.sentMessageIds?.[0] ?? null;
  const now = new Date().toISOString();
  const { error: insErr } = await sb.from("messages").insert({
    conversation_id: CONV, sender: "staff", text, created_at: now, is_aix_generated: isAix, ...(lineMessageId ? { line_message_id: lineMessageId } : {}),
  });
  if (insErr) throw new Error(`messages の記録に失敗（LINE には届いています）: ${insErr.message}`);
  const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: bl } = await sb.from("brain_decision_logs").select("id").eq("conversation_id", CONV).is("outcome", null).gt("created_at", cutoff).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (bl?.id) await sb.from("brain_decision_logs").update({ outcome: isAix ? "aix_followed" : "draft_followed", outcome_recorded_at: now }).eq("id", bl.id);
  await sb.from("conversations").update({ last_message: text, last_sender: "staff", updated_at: now, ai_draft: null, suggested_aix_meta: null }).eq("id", CONV);
  if (isAix && aixType) {
    await fetch(`${BASE}/api/log-aix-usage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: CONV, aix_type: aixType, conversation_status: c.status, suggested_action: predicted, line_message_id: lineMessageId, sent_at: now, check_pattern: checkPattern, generated_text: text, was_edited: false, ...logExtra }),
      signal: AbortSignal.timeout(30_000),
    }).catch((e) => console.warn("  log-aix-usage 失敗:", e instanceof Error ? e.message : e));
  }
  return { lineMessageId };
}

// ─── 材料の要る AIX（保存済みの材料で・画面と同じ経路で送る） ───

/** 材料の候補を DB から集める（YUMA の会話・YUMA のお客様の物だけ） */
async function loadMaterialPool(c: ConvRow, msgs: MsgRow[]): Promise<SimMaterialPool> {
  const [est, logs, imgs, pk, sp, st] = await Promise.all([
    sb.from("estimate_records").select("id, conversation_id, property_name, room_no, initial_cost_yen, discount_yen, aix_usage_log_id, estimated_at, created_at")
      .eq("conversation_id", CONV).order("created_at", { ascending: false }).limit(10),
    sb.from("aix_usage_logs").select("id, generated_text, sent_at, created_at").eq("conversation_id", CONV).eq("aix_type", "estimate_sheet").order("created_at", { ascending: false }).limit(10),
    sb.from("messages").select("image_url, created_at").eq("conversation_id", CONV).eq("sender", "staff").not("image_url", "is", null).order("created_at", { ascending: false }).limit(80),
    c.property_customer_id
      ? sb.from("property_pickups").select("id, batch_id, property_name, room_no, trim_image_url, page_image_url, pdf_blob_url, pdf_text, summary_text, rank, complete_rank, complete_group_id, status, sent_at, conversation_id")
        .eq("property_customer_id", c.property_customer_id).order("complete_rank", { ascending: true, nullsFirst: false }).order("rank", { ascending: true }).limit(60)
      : Promise.resolve({ data: [], error: null }),
    sb.from("sent_properties").select("property_name, room_no, sent_at, delivery").eq("conversation_id", CONV).order("sent_at", { ascending: false }).limit(40),
    getCustomerState(CONV).catch(() => null),
  ]);
  for (const [name, r] of [["estimate_records", est], ["aix_usage_logs", logs], ["messages", imgs], ["property_pickups", pk], ["sent_properties", sp]] as const) {
    if (r.error) throw new Error(`材料の読み込みに失敗（${name}）: ${r.error.message}`);
  }
  const logById = new Map(((logs.data ?? []) as Array<{ id: string; generated_text: string | null; sent_at: string | null; created_at: string }>).map((l) => [l.id, l]));
  const imgRows = (imgs.data ?? []) as Array<{ image_url: string; created_at: string }>;
  const estimates: SimEstimateSource[] = ((est.data ?? []) as Array<{ id: number; conversation_id: string; property_name: string; room_no: string | null; initial_cost_yen: number | null; discount_yen: number | null; aix_usage_log_id: string | null; estimated_at: string | null }>).map((e) => {
    const log = e.aix_usage_log_id ? logById.get(e.aix_usage_log_id) : undefined;
    // 送った時の見積書の画像: その AIX の送信時刻の前2分〜後5秒に、こちらが送った画像（画面は画像→本文の順で送る）
    const at = Date.parse(log?.sent_at ?? log?.created_at ?? e.estimated_at ?? "");
    const img = Number.isFinite(at) ? imgRows.filter((m) => { const t = Date.parse(m.created_at); return t >= at - 120_000 && t <= at + 5_000; }).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] : undefined;
    return { recordId: e.id, conversationId: e.conversation_id, propertyName: e.property_name, roomNo: e.room_no, initialCostYen: e.initial_cost_yen, discountYen: e.discount_yen, imageUrl: img?.image_url ?? null, sentText: log?.generated_text ?? null, estimatedAt: e.estimated_at };
  });
  const pickups: SimPickupSource[] = ((pk.data ?? []) as Array<{ id: number; batch_id: string | null; property_name: string; room_no: string | null; trim_image_url: string | null; page_image_url: string | null; pdf_blob_url: string | null; pdf_text: string | null; summary_text: string | null; rank: number | null; complete_rank: number | null; complete_group_id: string | null; status: string | null; sent_at: string | null; conversation_id: string | null }>)
    .filter((p) => !p.conversation_id || p.conversation_id === CONV)
    .map((p) => ({
      // 送る画像は元の資料の1ページ目そのまま（trim_image_url）だけ。page_image_url は書体を差し替えた画像＝送らない（app/lib/pickup-send-image.ts）
      id: p.id, propertyName: p.property_name, roomNo: p.room_no, imageUrl: pickSendImageUrl(p), pdfUrl: p.pdf_blob_url, summaryText: p.summary_text,
      address: addressFromPdfText(p.pdf_text), rank: p.complete_rank ?? p.rank, status: p.status, sentAt: p.sent_at, completeGroupId: p.complete_group_id, batchId: p.batch_id,
    }));
  noSendImagePickups = pickupsWithoutSendImage(((pk.data ?? []) as Array<{ property_name: string; room_no: string | null; trim_image_url: string | null; sent_at: string | null; status: string | null; conversation_id: string | null }>)
    .filter((p) => !p.conversation_id || p.conversation_id === CONV));
  const sentNames: string[] = [];
  for (const r of (sp.data ?? []) as Array<{ property_name: string | null; room_no: string | null; delivery: string | null }>) {
    if (r.delivery === "line_group") continue;
    const n = `${r.property_name ?? ""}${r.room_no ? ` ${r.room_no}` : ""}`.trim();
    if (n && !sentNames.includes(n)) sentNames.push(n);
  }
  const state = st as Awaited<ReturnType<typeof getCustomerState>>;
  const focus = state?.focusKey ? state.properties.find((r) => r.key === state.focusKey) ?? null : null;
  return {
    conversationId: CONV, estimates, pickups, sentPropertyNames: sentNames, focusPropertyName: focus?.name ?? null,
    history: msgs.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at })), nowMs: Date.now(),
  };
}

/** 画像をまとめて送る（page.tsx の sendImagesBatch と同じ: 1回の送信・届いた画像を1枚ずつ messages に・会話の行を更新） */
async function sendImagesAsStaff(urls: string[], c: ConvRow, aixType: string): Promise<string[]> {
  const res = await fetch(`${BASE}/api/send-line-message`, {
    method: "POST", headers: authHeaders(),
    body: JSON.stringify({ line_user_id: c.line_user_id, image_urls: urls, account: c.account ?? "sumora", conversation_id: CONV, origin: "aix", aix_type: aixType }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await res.json().catch(() => ({})) as { ok?: boolean; sentMessageIds?: string[]; error?: string };
  const ids = j.sentMessageIds ?? [];
  const delivered = res.ok && j.ok ? urls : urls.slice(0, ids.length);
  if (delivered.length === 0) throw new Error(`画像を送れませんでした: HTTP ${res.status} ${j.error ?? ""}`);
  for (let i = 0; i < delivered.length; i++) {
    const at = new Date(Date.now() + i).toISOString();
    const { error } = await sb.from("messages").insert({ conversation_id: CONV, sender: "staff", text: "[画像]", image_url: delivered[i], created_at: at, is_aix_generated: true, ...(ids[i] ? { line_message_id: ids[i] } : {}) });
    if (error) throw new Error(`messages（画像）の記録に失敗: ${error.message}`);
  }
  const upgrade = c.status === "hearing";
  await sb.from("conversations").update({ last_message: "[画像]", last_sender: "staff", updated_at: new Date().toISOString(), ai_draft: null, suggested_aix_meta: null, ...(upgrade ? { status: "proposing" } : {}) }).eq("id", CONV);
  return delivered;
}

type MaterialSendResult = { text: string | null; images: number; label: string; note?: string; skippedAfterSend: string[]; /** 見積書送るの2通目（AIX が作るカバー文・画面は送らない） */ coverLetter?: string | null };

/**
 * 材料の要る AIX を送る。生成・送信・記録は画面（AixModal・page.tsx）と同じ API・引数・順番（画像→本文→記録）。
 *   画面が送った後に作るカレンダー（待ち合わせ後の内覧の予定・内覧へ！の時間確保）は作らない（お客様役の決まり）
 */
/** opts.aixBody: ピッカーから /api/aix/action に足す欄 ／ opts.log: ピッカーの記録（log-aix-usage）／ opts.skipMark: 送った印を付けない（同じ番で送ったピックアップの1件をオススメで推す時） */
type SendOpts = { aixBody?: Record<string, unknown>; log?: Record<string, unknown>; skipMark?: boolean };
async function sendWithMaterial(action: string, checkPattern: string | null, material: SimAixMaterial, c: ConvRow, msgs: MsgRow[], predicted: string | null, noSend: boolean, opts: SendOpts = {}): Promise<MaterialSendResult> {
  const skippedAfterSend: string[] = [];
  const done = async (text: string, images: string[], logExtra: Record<string, unknown>, label: string): Promise<MaterialSendResult> => {
    if (noSend) return { text: null, images: 0, label: `${label}（--no-send: 送る直前で止めた）`, note: `送る予定: 画像${images.length}枚／${one(text, 300)}`, skippedAfterSend };
    const delivered = images.length ? await sendImagesAsStaff(images, c, action) : [];
    await sendAsStaff(text, true, c, action, checkPattern, predicted, { ...logExtra, ...(opts.log ?? {}) });
    return { text, images: delivered.length, label, skippedAfterSend };
  };
  switch (material.kind) {
    case "estimate": {
      // 画面の見積書送る（1件）: image_url（見積書）→ サーバーが画像を読んで金額文 → [見積書] をまとめて送る → 本文（AixModal 2503-2514・3311-3331）
      const g = await generateAixRaw(action, null, c, msgs, { image_url: material.imageUrl }, false);
      if (!g.text) throw new Error("見積書の生成が空");
      const aligned = alignEstimateText(g.text, material);
      if (!aligned) throw new Error(`生成の金額が保存済みの値（初期費用 ${material.initialCostYen}・割引 ${material.discountYen}）と食い違う → 送らない: ${one(g.text, 160)}`);
      const r = await done(aligned.text, [material.imageUrl], { was_edited: aligned.edited, conversation_match: false }, `AIX【estimate_sheet】を保存済みの見積書で送る${aligned.edited ? "（物件名を保存済みの名前に手直し）" : ""}`);
      return { ...r, coverLetter: (g.raw as { coverLetter?: string }).coverLetter ?? null };
    }
    case "check_result": {
      // 画面の物件確認した（available）: 物件ごとの資料と状態を渡す → [資料] → 本文（AixModal 2388-2485・3159-3261）
      const extra: Record<string, unknown> = {
        property_count: 1, sent_property_count: Math.max(1, await loadSentCount()), staff_note: "", prop_statuses: ["available"], property_names: [material.propertyName],
        property_vacancy_dates: [""], estimate_image_urls: [null], all_properties_available: true,
        ...(material.imageUrl ? { image_url: material.imageUrl, image_urls: [material.imageUrl] } : {}),
      };
      const g = await generateAixRaw(action, "available", c, msgs, extra, true);
      if (!g.text) throw new Error("物件確認した の生成が空");
      return done(g.text, material.imageUrl ? [material.imageUrl] : [], {
        conversation_match: true, property_names: [material.propertyName], prop_statuses: ["available"], estimate_sent: g.raw.estimate_sent === true, prop_cost_notes: g.raw.prop_cost_notes ?? null,
      }, `AIX【property_check_result/available】を設定「${material.setting}」で送る`);
    }
    case "pickups": {
      const items = material.items;
      const urls = items.map((p) => p.imageUrl).filter((u): u is string => !!u);
      if (action === "property_recommendation") {
        // 画面の物件オススメ: image_url（資料・必須）→ [資料] → 本文（AixModal 2179-2210・3271-3299）
        const g = await generateAixRaw(action, null, c, msgs, { image_url: urls[0], ...(opts.aixBody ?? {}) }, false);
        if (!g.text) throw new Error("物件オススメの生成が空");
        const r = await done(g.text, [urls[0]], { conversation_match: false }, `AIX【property_recommendation】をピックアップ#${items[0].id}で送る`);
        if (!noSend && !opts.skipMark) await markPickupsSent(items.slice(0, 1), null);
        return r;
      }
      // 画面の物件ピックアップした（売上サポから）: image_urls・pickup_ids → [画像まとめて] → 本文 → 送った印（mark_sent）
      const sendMode = typeof opts.aixBody?.send_mode === "string" ? opts.aixBody.send_mode : "normal";
      const g = await generateAixRaw(action, null, c, msgs, { image_urls: urls, pickup_ids: items.map((p) => p.id), ...(opts.aixBody ?? {}), send_mode: sendMode }, true);
      if (!g.text) throw new Error("物件ピックアップした の生成が空");
      const r = await done(g.text, urls, { conversation_match: true, send_mode: sendMode }, `AIX【property_send/${sendMode}】をピックアップ${items.length}件で送る`);
      if (!noSend) await markPickupsSent(items, urls);
      return r;
    }
    case "viewing_slots": {
      // 画面の内覧へ！（会話を合わせる）: calendar_info（候補の日時）・property_name → 本文だけ（AixModal 2601-2639）
      const calendarInfo = material.slots.map((s) => `${s.label} ${s.start}${s.end ? `〜${s.end}` : ""}`).join("\n");
      const g = await generateAixRaw(action, null, c, msgs, { calendar_info: calendarInfo, ...(material.propertyName ? { property_name: material.propertyName } : {}) }, true);
      if (!g.text) throw new Error("内覧へ！の生成が空");
      skippedAfterSend.push("内覧へ！の【時間確保】（calendar_events）は作らない");
      return done(g.text, [], { conversation_match: true }, `AIX【viewing_invite】を候補（${material.source === "conversation" ? "会話から" : "固定"}）で送る`);
    }
    case "meeting": {
      // 画面の待ち合わせ場所（時間あり）: API を呼ばずに画面の固定文 → 本文だけ（AixModal 2581-2592）。記録は meeting_*（sent_facts・viewing_history）
      const text = buildMeetingPlaceText(material);
      skippedAfterSend.push("待ち合わせ後の内覧の予定（calendar_events）は作らない");
      return done(text, [], {
        meeting_property_name: material.propertyName, meeting_property_address: material.address, meeting_date: material.date, meeting_time: material.time,
      }, `AIX【meeting_place】を ${material.date} ${material.time}（${material.source === "conversation" ? "会話から" : "固定"}）で送る`);
    }
  }
}

async function loadSentCount(): Promise<number> {
  const { data } = await sb.from("sent_properties").select("property_name").eq("conversation_id", CONV).limit(100);
  return new Set(((data ?? []) as Array<{ property_name: string | null }>).map((r) => r.property_name ?? "")).size;
}

/** 送った印（page.tsx の mark_sent と同じ /api/property-pickups/send・LINE には何も送らない） */
async function markPickupsSent(items: SimPickupSource[], imageUrls: string[] | null): Promise<void> {
  const batches = [...new Set(items.map((p) => p.batchId).filter(Boolean))].join(",");
  if (!batches) return;
  const res = await fetch(`${BASE}/api/property-pickups/send`, {
    method: "POST", headers: authHeaders(),
    body: JSON.stringify({ batch_id: batches, item_ids: items.map((p) => p.id), action: "mark_sent", sent_by: "aix", ...(imageUrls ? { image_urls: imageUrls } : {}), conversation_id: CONV }),
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => { console.warn("  mark_sent 失敗:", e instanceof Error ? e.message : e); return null; });
  if (res && !res.ok) console.warn(`  mark_sent 失敗: HTTP ${res.status}`);
}

async function changesSince(sinceIso: string): Promise<{ facts: string[]; props: string[]; tasks: string[]; aixItems: number; calendar: number }> {
  const [f, p, t, a, cal] = await Promise.all([
    sb.from("sent_facts").select("kind, status, origin, aix_type").eq("conversation_id", CONV).gte("sent_at", sinceIso),
    sb.from("sent_properties").select("property_name, room_no").eq("conversation_id", CONV).gte("sent_at", sinceIso),
    sb.from("line_tasks").select("task_type, status").eq("conversation_id", CONV).gte("created_at", sinceIso),
    sb.from("aix_action_items").select("id").eq("conversation_id", CONV).gte("created_at", sinceIso),
    sb.from("calendar_events").select("id").eq("conversation_id", CONV).gte("created_at", sinceIso),
  ]);
  return {
    facts: ((f.data ?? []) as Array<{ kind: string; status: string; origin: string | null; aix_type: string | null }>).map((x) => `${x.kind}:${x.status}${x.aix_type ? `(${x.aix_type})` : ""}`),
    props: ((p.data ?? []) as Array<{ property_name: string; room_no: string | null }>).map((x) => `${x.property_name}${x.room_no ? ` ${x.room_no}` : ""}`),
    tasks: ((t.data ?? []) as Array<{ task_type: string; status: string }>).map((x) => `${x.task_type}:${x.status}`),
    aixItems: (a.data ?? []).length,
    calendar: cal.error ? -1 : (cal.data ?? []).length,
  };
}

async function costSince(sinceIso: string): Promise<{ usd: number; byModel: Record<string, { n: number; usd: number }> }> {
  const { data } = await sb.from("llm_usage_logs")
    .select("model, action, input_uncached, cache_read, cache_write, cache_write_5m, cache_write_1h, output_tokens, thinking_tokens")
    .eq("conversation_id", CONV).gte("created_at", sinceIso).limit(2000);
  const byModel: Record<string, { n: number; usd: number }> = {};
  let total = 0;
  for (const r of (data ?? []) as UsageRow[]) {
    const k = `${(r.model ?? "?").replace(/^claude-/, "")}${r.action ? `/${r.action}` : ""}`;
    const c = usd(r); total += c;
    byModel[k] = { n: (byModel[k]?.n ?? 0) + 1, usd: (byModel[k]?.usd ?? 0) + c };
  }
  return { usd: total, byModel };
}

async function stateLine(): Promise<{ headline: string; conflicts: number }> {
  try {
    const s = await getCustomerState(CONV);
    return { headline: s?.headline ?? "（読めない）", conflicts: s?.conflicts?.length ?? 0 };
  } catch { return { headline: "（読めない）", conflicts: 0 }; }
}

type Row = {
  round: number; step: string; at: string; customer: string; customerSource: string; goalReached: boolean | null;
  brain: { action: string | null; reply_mode: string | null; direction: string | null; parallel_search: boolean | null; stage: string | null } | null;
  plan: string; draft: string | null; sent: string | null; sentKind: string | null; headline: string; conflicts: number;
  changes: Awaited<ReturnType<typeof changesSince>> | null; usd: number; simUsd: number; waitedSec: number; findings: SimAuditFinding[]; note?: string;
  /** 使った材料（材料の要る AIX を送った時）・送った画像の枚数・画面では作るが作らなかった物 */
  material?: string | null; images?: number; skippedAfterSend?: string[];
  /** 影の道（--shadow）: 選ばなかった方（送らない）と突き合わせのズレ */
  shadow?: (Omit<ShadowTurnResult, "findings"> & { coverLetter?: string | null }) | null; shadowFindings?: ShadowFinding[];
  /** スタッフ役の送り方（staff-send-pattern.ts）: 画面の AIX・押した AIX・ピッカー・先の返信・2つ目の AIX・一言・画面のズレ・形 */
  aixView?: { shown: string | null; channel: string; source: string } | null;
  pressed?: { aix: string | null; second: string | null; replyFirst: boolean; followup: boolean; reasons: string[] } | null;
  picker?: (PickerChoice & { note?: string }) | null;
  replyFirstText?: string | null; secondAixText?: string | null; followupText?: string | null;
  followup?: Omit<FollowupResult, "text"> | null;
  viewMismatches?: SimViewMismatch[]; shape?: StaffTurnShape;
};

function printRow(r: Row) {
  console.log(`\n━━ 往復 ${r.round}（${r.step}）${r.at}`);
  console.log(`  お客様役[${r.customerSource}${r.goalReached === null ? "" : r.goalReached ? "・目的○" : "・目的×"}]: ${one(r.customer, 200)}`);
  if (r.brain) console.log(`  ブレイン: AIX=${r.brain.action ?? "なし"} reply_mode=${r.brain.reply_mode ?? "-"} 段階=${r.brain.stage ?? "-"} 並行検索=${r.brain.parallel_search ? "ON" : "OFF"} 方向=${one(r.brain.direction, 60)}（${r.waitedSec}秒）`);
  else console.log(`  ブレイン: 判断が来なかった（${r.waitedSec}秒）`);
  console.log(`  スタッフ役: ${r.plan}`);
  if (r.aixView) console.log(`  画面の AIX: ${r.aixView.shown ?? "なし"}（${r.aixView.channel}・${r.aixView.source}）／押した: ${r.pressed?.aix ?? "なし"}${r.pressed?.second ? ` → ${r.pressed.second}` : ""}${r.pressed?.replyFirst ? "（返信を先に）" : ""}`);
  if (r.pressed?.reasons.length) console.log(`    決め方: ${r.pressed.reasons.join("／")}`);
  if (r.picker) console.log(`  ピッカー: ${r.picker.label}（${r.picker.field}=${r.picker.value}）… ${r.picker.reason}${r.picker.note ? `／${r.picker.note}` : ""}`);
  if (r.replyFirstText) console.log(`  先に送った返信: ${one(r.replyFirstText, 200)}`);
  if (r.draft && r.draft !== r.sent) console.log(`  下書き: ${one(r.draft, 200)}`);
  if (r.material) console.log(`  使った材料: ${r.material}${r.images ? `・画像${r.images}枚` : ""}`);
  console.log(`  送った文${r.sentKind ? `（${r.sentKind}）` : ""}: ${r.sent ? one(r.sent, 300) : "（送っていない）"}`);
  if (r.secondAixText) console.log(`  2つ目の AIX: ${one(r.secondAixText, 200)}`);
  if (r.followup) console.log(`  AIX の後の一言${r.followup.label ? `（テンプレ「${r.followup.label}」・${r.followup.how ?? "送らない"}）` : ""}: ${r.followupText ? one(r.followupText, 200) : `送っていない（${r.followup.skipped ?? "-"}）`}`);
  if (r.viewMismatches?.length) console.log(`  ⚠ 画面: ${r.viewMismatches.map((x) => `${SIM_AIX_VIEW_MISMATCH_JA[x.kind]}（${x.detail}）`).join(" ／ ")}`);
  if (r.skippedAfterSend?.length) console.log(`  作らなかった物: ${r.skippedAfterSend.join("／")}`);
  console.log(`  状況の表示: ${r.headline}${r.conflicts ? `（⚠ずれ ${r.conflicts}）` : ""}`);
  if (r.changes) console.log(`  変化: 送った事実[${r.changes.facts.join(", ") || "-"}] 送った物件[${r.changes.props.join(", ") || "-"}] タスク[${r.changes.tasks.join(", ") || "-"}] AIX要対応+${r.changes.aixItems} カレンダー+${r.changes.calendar < 0 ? "?" : r.changes.calendar}`);
  console.log(`  費用: この往復 $${r.usd.toFixed(4)}（うちお客様役 $${r.simUsd.toFixed(5)}）`);
  if (r.shadow) {
    if (r.shadow.chosen === "aix") console.log(`  影の下書き（送らない）: ${r.shadow.draft ? one(r.shadow.draft, 200) : `作らなかった（${r.shadow.draftSkipped ?? r.shadow.draftError ?? "-"}）`}`);
    if (r.shadow.coverLetter) console.log(`  影の AIX の後の一言（AIX が作った2通目・送らない）: ${one(r.shadow.coverLetter, 160)}`);
    for (const c of r.shadow.candidates) console.log(`  影の AIX【${c.action}${c.checkPattern ? `/${c.checkPattern}` : ""}】（${c.source}）: ${c.text ? one(c.text, 160) : `作らなかった（${c.skipped ?? c.error ?? "-"}）`}`);
  }
  if (r.findings.length) console.log(`  ⚠ 検査: ${r.findings.map((f) => `${simAuditKindJa(f.kind)}（${f.detail}）`).join(" ／ ")}`);
  if (r.note) console.log(`  メモ: ${r.note}`);
}

async function main() {
  if (flag("list")) {
    for (const s of listScenarios()) console.log(`${s.id}: ${s.title}\n${s.steps.map((st, i) => `   ${i + 1}. ${st.fixed ? `［固定］${st.fixed}` : st.goal}`).join("\n")}`);
    return;
  }
  const scenario = getScenario(arg("scenario") ?? "like_estimate_viewing");
  if (!scenario) throw new Error(`筋書きが分かりません: ${arg("scenario")}（--list で一覧）`);
  const state = loadState(scenario.id);
  const logFile = join(DIR, `${state.runId}.jsonl`);
  console.log(`筋書き: ${scenario.title}／段 ${state.cursor.stepIndex + 1}/${scenario.steps.length}／入口 ${BASE}／記録 ${logFile}`);

  if (flag("dry")) {
    const r = await callSim({ mode: "generate", scenario_id: scenario.id, step_index: state.cursor.stepIndex, turns_on_step: state.cursor.turnsOnStep });
    console.log(r.ok ? `お客様役[${r.source}・目的${r.goal_reached ? "○" : "×"}]: ${r.text}` : `失敗: ${r.error}`);
    if (r.usage) console.log(`  DeepSeek ${r.usage.model}: 入力${r.usage.input}（キャッシュ${r.usage.cacheHit}）出力${r.usage.output}`);
    return;
  }

  const rows: Row[] = [];
  for (let n = 0; n < (flag("step") || flag("no-send") ? 1 : MAX_ROUNDS) && !state.finished; n++) {
    const roundStart = new Date().toISOString();
    let msgs = await recentMessages();
    const last = msgs[msgs.length - 1];
    let customerText = "", customerSource = "", goalReached: boolean | null = null, customerAt = "", simUsd = 0;
    let usedStepIndex: number | null = null; // この発言を作った段（状況の取り違えの検査に使う）

    // 竹内さんの本物の発言（手動のテスト）が直近にある時は割り込まない
    const lastRealCustomer = [...msgs].reverse().find((m) => m.sender === "customer" && !isSimLineMessageId(m.line_message_id));
    if (!flag("force") && lastRealCustomer && Date.now() - Date.parse(lastRealCustomer.created_at) < 30 * 60_000) {
      console.log(`\n止めました: ${jst(lastRealCustomer.created_at)} に竹内さんの本物の発言があります（手動のテスト中かも）。進めるなら --force`);
      break;
    }

    if (last && last.sender === "customer" && isSimLineMessageId(last.line_message_id)) {
      // 前回お客様役の発言を入れたまま止まっている（--no-send・判断待ちで止めた等）→ その発言の返事から続ける
      customerText = last.text ?? ""; customerSource = "前回の続き"; customerAt = last.created_at;
    } else {
      const given = arg("text");
      const r = given
        ? await callSim({ mode: "inject", text: given })
        : await callSim({ mode: "generate_and_inject", scenario_id: scenario.id, step_index: state.cursor.stepIndex, turns_on_step: state.cursor.turnsOnStep });
      if (!r.ok || !r.text) { console.log(`\nお客様役で止まりました: ${r.error ?? "不明"}`); break; }
      customerText = r.text; customerSource = given ? "固定(--text)" : (r.source ?? "?"); goalReached = given ? true : (r.goal_reached ?? null);
      if (r.usage) simUsd = usd({ model: r.usage.model, action: null, input_uncached: Math.max(0, r.usage.input - r.usage.cacheHit), cache_read: r.usage.cacheHit, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0, output_tokens: r.usage.output, thinking_tokens: 0 });
      msgs = await recentMessages();
      customerAt = msgs.filter((m) => m.line_message_id === r.injected?.lineMessageId)[0]?.created_at ?? new Date().toISOString();
      usedStepIndex = given ? null : state.cursor.stepIndex;
      const next = advanceCursor(scenario, state.cursor, goalReached === true);
      state.cursor = { stepIndex: next.stepIndex, turnsOnStep: next.turnsOnStep };
      state.finished = next.finished;
    }
    state.round++;
    saveState(state);
    const stepLabel = usedStepIndex === null ? "続き" : `${usedStepIndex + 1}/${scenario.steps.length}段`;

    const { meta, draft, waitedMs } = await waitForBrainAndDraft(customerAt);
    const c = await conv();
    const m = (meta ?? {}) as Record<string, unknown>;
    const brain = meta ? {
      action: (m.action as string | null) ?? null, reply_mode: (m.reply_mode as string | null) ?? null,
      direction: (m.reply_direction_label as string | null) ?? (m.reply_direction as string | null) ?? null,
      parallel_search: (m.parallel_search as { on?: boolean } | undefined)?.on ?? null, stage: (m.checkpoint_stage as string | null) ?? null,
    } : null;
    let poolMsgs = await recentMessages();
    const pool = await loadMaterialPool(c, poolMsgs);
    // ── スタッフ役の送り方（staff-send-pattern.ts）: 画面に出ている AIX を押す・ブレインと違えばズレ（⚠ 画面:） ──
    const aixView = simAixView(meta, poolMsgs);
    const staffTurn = meta && !STAFF_SIMPLE ? decideSimStaffTurn({ round: state.round, meta: meta as SimBrainMetaLike, view: aixView }) : null;
    const viewMismatches: SimViewMismatch[] = [...aixView.mismatches];
    const effMeta = !meta ? null : !staffTurn ? meta
      : staffTurn.pressAix ? { ...meta, action: staffTurn.pressAix, reply_mode: "aix", check_pattern: staffTurn.checkPattern }
      : { ...meta, reply_mode: "draft" };
    const plan = planStaffAction(effMeta as { action?: string | null; reply_mode?: string | null; check_pattern?: string | null } | null, pool);
    // ピッカー（場面から・画面と同じ記録の形。null の欄は渡さない＝材料の send_mode・check_pattern を消さない）
    const turnMsgs: MsgRow[] = [];
    for (let i = poolMsgs.length - 1; i >= 0 && poolMsgs[i].sender === "customer"; i--) turnMsgs.unshift(poolMsgs[i]);
    const turnText = turnMsgs.map((x) => x.text ?? "").filter((x) => x && x !== "[画像]").join("\n");
    const recentStaffTexts = poolMsgs.filter((x) => x.sender === "staff" && x.text && x.text !== "[画像]").map((x) => x.text as string).slice(-6);
    const pickFor = (action: string, usedCp: string | null): { choice: Row["picker"]; aix: ReturnType<typeof pickerAixBody>; log: Record<string, unknown> } => {
      if (STAFF_SIMPLE) return { choice: null, aix: { body: {} }, log: {} };
      const choice = simPickerFor({ aixType: action, turnText, hasImage: turnMsgs.some((x) => !!x.image_url || /https?:\/\//.test(x.text ?? "")), sentPropertyCount: pool.sentPropertyNames.length, recentStaffTexts, roomStatus: "unknown" });
      // 物件確認した の結果は材料の設定（募集中）で送る → 場面のピッカーと違えばメモだけ（記録は送った方）
      const cpDiff = action === "property_check_result" && choice?.field === "check_pattern" && choice.value !== usedCp;
      const extraChoices = action === "application_push" && choice?.value === "format" ? { living_type: "single", guarantor_kind: "emergency" } : null;
      const fields = cpDiff ? pickerLogFields(action, null, { checkPattern: usedCp }) : pickerLogFields(action, choice, { checkPattern: usedCp, extraChoices });
      const log = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null));
      return { choice: choice ? { ...choice, ...(cpDiff ? { note: `送ったのは ${usedCp ?? "空"}（材料の設定）` } : {}) } : null, aix: cpDiff ? { body: {} } : pickerAixBody(action, choice), log };
    };
    const historyBefore: SimHistoryItem[] = (await recentMessages()).map((x) => ({ sender: x.sender, text: x.text, isAix: x.is_aix_generated, hasImage: !!x.image_url, createdAt: x.created_at }));

    // ── 影の道（--shadow）: 送る前に、ブレインが見たのと同じ会話で「選ばなかった方」を作る（送らない・送った記録を作らない） ──
    const focusSentByUs = !!pool.focusPropertyName && pool.sentPropertyNames.some((n) => sameBuilding(n, pool.focusPropertyName));
    let shadow: ShadowTurnResult | null = null;
    if (SHADOW && plan.kind !== "wait") {
      const chosen = plan.kind === "draft" ? "draft" as const : "aix" as const;
      shadow = await runShadowTurn(
        { base: SHADOW_BASE, conversationId: CONV, draftAccepted: SHADOW_DRAFT_OK, withImages: flag("shadow-images") },
        {
          chosen, meta: meta as Parameters<typeof runShadowTurn>[1]["meta"],
          aix: plan.kind !== "draft" ? { action: plan.action, checkPattern: plan.kind === "aix_needs_material" ? null : plan.checkPattern } : null,
          draftText: chosen === "draft" ? draft : null, conv: c, msgs: poolMsgs, pool, sentPropertyCount: pool.sentPropertyNames.length, focusSentByUs,
        },
      ).catch((e): ShadowTurnResult => ({ chosen, candidates: [], findings: [], draftError: e instanceof Error ? e.message : String(e) }));
    }

    let sent: string | null = null, sentKind: string | null = null, planLabel = "", note: string | undefined;
    let stop = false;
    let materialLabel: string | null = null, images = 0, skippedAfterSend: string[] = [], material: SimAixMaterial | null = null;
    let shadowCover: string | null = null;
    let replyFirstText: string | null = null, secondAixText: string | null = null, followupText: string | null = null;
    let followup: Omit<FollowupResult, "text"> | null = null;
    let picker: Row["picker"] = null;
    // 画面の lastPickerModeByConvRef と同じ値（checkPattern ?? appSubMode ?? sendMode・物件オススメは pickup_type）。AIX の後の一言の AI 最適化に aixPickerMode で渡す
    let lastPickerLog: Record<string, unknown> = {};
    const pickerModeOf = (log: Record<string, unknown>): string | null => {
      const v = log.check_pattern ?? log.app_sub_mode ?? log.send_mode ?? (log.picker_choices as Record<string, unknown> | undefined)?.pickup_type;
      return typeof v === "string" && v ? v : null;
    };
    const noSend = flag("no-send");
    try {
      // 返信→AIX（実送信 15%・往復の番号で決まる）: 返信を先に送ってから同じ番で AIX。送った後の画面にその AIX が残るかも見る
      if ((plan.kind === "aix" || plan.kind === "aix_material") && staffTurn?.replyFirst) {
        if (noSend) note = "返信→AIX の番（--no-send: 先の返信も送らない）";
        else {
          const r0 = await draftForReplyFirst(BASE, CONV, c, poolMsgs, draft);
          if (r0.text) {
            await sendAsStaff(r0.text, false, c, null, null, brain?.action ?? null);
            replyFirstText = r0.text;
            await sleep(2000);
            const c2 = await conv();
            poolMsgs = await recentMessages();
            const gone = checkAfterReply(plan.action, simAixView(c2.suggested_aix_meta, poolMsgs));
            if (gone) viewMismatches.push(gone);
          } else note = `返信→AIX の番だが先の返信を作れない（${r0.error ?? "-"}）→ AIX から`;
        }
      }
      if (plan.kind === "wait") { planLabel = "判断が来ないので止める"; stop = true; }
      else if (plan.kind === "aix_needs_material") {
        const noImg = (plan.action === "property_send" || plan.action === "property_recommendation") && noSendImagePickups.length
          ? `・元の資料の画像（trim）が無いので送らない: ${noSendImagePickups.slice(0, 5).join("・")}` : "";
        planLabel = `AIX【${plan.action}】は材料が揃わない（${plan.reason}${noImg}）→ 送らずに止める`;
        note = "画面で AIX を送ってから、もう一度同じ命令で続きから進みます"; stop = true;
      } else if (plan.kind === "aix_material") {
        material = plan.material;
        materialLabel = describeSimMaterial(plan.material);
        const pk = pickFor(plan.action, plan.checkPattern);
        picker = pk.choice; lastPickerLog = pk.log;
        const r = await sendWithMaterial(plan.action, plan.checkPattern, plan.material, c, poolMsgs, brain?.action ?? null, noSend, { aixBody: pk.aix.body, log: pk.log });
        planLabel = r.label; images = r.images; skippedAfterSend = r.skippedAfterSend; shadowCover = r.coverLetter ?? null;
        if (r.note) note = r.note;
        if (r.text) { sent = r.text; sentKind = `AIX ${plan.action}${plan.checkPattern ? `/${plan.checkPattern}` : ""}`; } else stop = true;
      } else if (plan.kind === "aix") {
        const pk = pickFor(plan.action, plan.checkPattern);
        picker = pk.choice; lastPickerLog = pk.log;
        let text: string | null;
        if (pk.aix.screenOnly === "application_format") {
          // 申込フォーマットは画面が API を呼ばずに固定文（AixModal の APP_FORMAT_SECTIONS）を作る → 同じ文を読む
          const f = appFormatText();
          text = f.text;
          planLabel = `AIX【${plan.action}/format】申込フォーマット（画面の固定文・単独・緊急連絡先）${f.text ? "" : ` → ${f.reason}`}`;
        } else {
          text = (await generateAixRaw(plan.action, plan.checkPattern, c, poolMsgs, pk.aix.body)).text;
          planLabel = `AIX【${plan.action}】を本番の生成で作って送る`;
        }
        if (!text) { planLabel += " → 生成が空"; stop = true; }
        else if (noSend) { planLabel += "（--no-send: 送る直前で止めた）"; sent = null; note = `送る予定の文: ${one(text, 300)}`; stop = true; }
        else { await sendAsStaff(text, true, c, plan.action, plan.checkPattern, brain?.action ?? null, pk.log); sent = text; sentKind = `AIX ${plan.action}`; }
      } else {
        planLabel = "AIX なし → 下書きをそのまま送る";
        let text = draft;
        // 画面に AIX が無く下書きも無い（ブレインは AIX の番）→ 画面の下書き作成と同じ生成（実際のスタッフは手打ちする所）
        if (!text && staffTurn && !noSend) {
          const r0 = await draftForReplyFirst(BASE, CONV, c, poolMsgs, null);
          if (r0.text) { text = r0.text; planLabel = "画面に AIX が無く下書きも無い → 画面の下書き作成と同じ生成で送る"; }
        }
        if (!text) { planLabel += " → 下書きが来なかった"; stop = true; }
        else if (noSend) { planLabel += "（--no-send: 送る直前で止めた）"; stop = true; }
        else { await sendAsStaff(text, false, c, null, null, brain?.action ?? null); sent = text; sentKind = "下書き"; }
      }
      // 2つ目の AIX（実送信で過半数の組だけ: 物件ピックアップした → 物件オススメ 75%。オススメは今送った1件目を推す）
      let lastAction: string | null = sent && sentKind?.startsWith("AIX ") && (plan.kind === "aix" || plan.kind === "aix_material") ? plan.action : null;
      let lastText = sent, lastMaterial = material;
      if (lastAction && !noSend && staffTurn?.secondAix) {
        const second = staffTurn.secondAix;
        const m2 = secondAixMaterial(material, second);
        const pick2 = m2 ? { ok: true as const, material: m2 } : pickSimMaterial(second, null, await loadMaterialPool(c, await recentMessages()));
        if (pick2.ok) {
          const pk2 = pickFor(second, null);
          const r2 = await sendWithMaterial(second, null, pick2.material, c, await recentMessages(), brain?.action ?? null, false, { aixBody: pk2.aix.body, log: pk2.log, skipMark: !!m2 });
          if (r2.text) { secondAixText = r2.text; images += r2.images; lastAction = second; lastText = r2.text; lastMaterial = pick2.material; lastPickerLog = pk2.log; planLabel += ` → 続けて ${r2.label}`; }
        } else planLabel += ` → 続けて AIX【${second}】は材料が無い（${pick2.reason}）`;
      }
      // AIX の後の一言（送信後のバナーのテンプレ → 画面と同じ AI 最適化）。過半数が添える型だけ
      if (lastAction && lastText && !noSend && staffTurn?.followup) {
        const allow = followupAllowed(lastAction, (plan.kind === "aix" || plan.kind === "aix_material") && lastAction === plan.action ? (picker?.value ?? null) : null);
        if (!allow.ok) followup = { templateId: null, label: null, how: null, skipped: allow.reason };
        else {
          const f = await makeFollowup(sb, BASE, { action: lastAction, aixText: lastText, conversationId: CONV, conv: c, msgs: await recentMessages(), propertyLabel: followupPropertyLabel(lastMaterial), pickerMode: pickerModeOf(lastPickerLog) });
          const { text: fuText, ...rest } = f;
          followup = rest;
          if (fuText) { await sendAsStaff(fuText, false, c, null, null, brain?.action ?? null); followupText = fuText; }
        }
      }
    } catch (e) {
      planLabel += ` → 失敗: ${e instanceof Error ? e.message : e}`; stop = true;
    }

    // 影: AIX を送った番は「AIX の後の一言」（お客様役は一言を送らない＝followupSent=false）
    const shadowFindings: ShadowFinding[] = [...(shadow?.findings ?? [])];
    if (shadow && sent && sentKind?.startsWith("AIX ") && plan.kind !== "draft" && plan.kind !== "wait") {
      shadowFindings.push(...judgeShadowTurn({ chosen: "aix", aix: { action: plan.action, checkPattern: plan.kind === "aix_needs_material" ? null : plan.checkPattern, text: sent }, draftText: null, followupSent: !!followupText }));
    }
    if (replyFirstText && (plan.kind === "aix" || plan.kind === "aix_material")) {
      shadowFindings.push(...judgeShadowTurn({ chosen: "aix", aix: { action: plan.action, checkPattern: plan.checkPattern, text: null }, draftText: replyFirstText, focusSentByUs })
        .map((f) => ({ ...f, detail: `先に送った返信: ${f.detail}` })));
    }
    if (sent) await sleep(SETTLE_MS); // 送った後の記録（送った事実・ブレインの再分析）が落ち着くのを待つ
    const st = await stateLine();
    const changes = await changesSince(roundStart);
    const cost = await costSince(roundStart);
    const findings = auditSimTurn({
      sentText: sent, historyBefore, brainStage: brain?.stage ?? null, expectStage: usedStepIndex === null ? null : (scenario.steps[usedStepIndex]?.expect_stage ?? null), stateConflicts: st.conflicts,
      groundingExtra: [...changes.props, ...(material ? groundingOfMaterial(material) : [])],
      materialMustShow: material && sent ? mustShowOfMaterial(material) : undefined,
    });
    for (const f of shadowFindings) findings.push({ kind: f.kind, detail: f.detail });
    for (const [label, t] of [["先の返信", replyFirstText], ["2つ目の AIX", secondAixText], ["一言", followupText]] as const) {
      if (!t) continue;
      for (const f of auditSimTurn({ sentText: t, historyBefore, groundingExtra: [...changes.props, ...(material ? groundingOfMaterial(material) : []), ...(sent ? [sent] : []), ...(secondAixText ? [secondAixText] : [])] })) {
        findings.push({ kind: f.kind, detail: `（${label}）${f.detail}` });
      }
    }
    const row: Row = {
      round: state.round, step: stepLabel, at: jst(customerAt), customer: customerText, customerSource, goalReached, brain, plan: planLabel,
      draft, sent, sentKind, headline: st.headline, conflicts: st.conflicts, changes, usd: cost.usd, simUsd, waitedSec: Math.round(waitedMs / 1000), findings, note,
      material: materialLabel, images, skippedAfterSend,
      shadow: shadow ? { chosen: shadow.chosen, draft: shadow.draft, draftSkipped: shadow.draftSkipped, draftError: shadow.draftError, candidates: shadow.candidates, coverLetter: shadowCover } : null,
      shadowFindings,
      aixView: { shown: aixView.shown, channel: aixView.channel, source: aixView.source },
      pressed: staffTurn ? { aix: staffTurn.pressAix, second: staffTurn.secondAix, replyFirst: staffTurn.replyFirst, followup: staffTurn.followup, reasons: staffTurn.reasons } : null,
      picker, replyFirstText, secondAixText, followupText, followup, viewMismatches,
    };
    row.shape = simRowShape(row);
    rows.push(row);
    appendFileSync(logFile, JSON.stringify({ ...row, costByModel: cost.byModel }) + "\n");
    printRow(row);
    if (changes.aixItems > 0) console.log("  ⚠ AIX要対応が作られています（お客様役の番では作らない決まり）— 片付けてください");
    if (stop) break;
    if (!state.finished) await sleep(3000);
  }
  saveState(state);

  // ── 要約 ──
  if (rows.length) {
    const sum = summarizeSimAudit(rows);
    const total = rows.reduce((a, r) => a + r.usd, 0), simTotal = rows.reduce((a, r) => a + r.simUsd, 0);
    console.log(`\n══ 要約（${rows.length}往復・${state.finished ? "筋書きの終わり" : `段 ${state.cursor.stepIndex + 1}/${scenario.steps.length} で停止`}）`);
    console.log(`  送った: ${rows.filter((r) => r.sent).length}（AIX ${rows.filter((r) => r.sentKind?.startsWith("AIX")).length}・下書き ${rows.filter((r) => r.sentKind === "下書き").length}）`);
    console.log(`  検査: ${sum.map((s) => `${s.label} ${s.count}`).join("／")}`);
    console.log(`  画面の AIX: ${summarizeViewMismatch(rows).map((x) => `${x.label} ${x.count}`).join("／")}`);
    {
      const cnt = new Map<StaffTurnShape, number>();
      for (const r of rows) cnt.set(r.shape ?? "none", (cnt.get(r.shape ?? "none") ?? 0) + 1);
      const keys = Object.keys(REAL_SHAPE_RATE) as Array<keyof typeof REAL_SHAPE_RATE>;
      console.log(`  送り方: ${keys.map((k) => `${STAFF_TURN_SHAPE_JA[k]} ${cnt.get(k) ?? 0}（実送信 ${Math.round(REAL_SHAPE_RATE[k] * 100)}%）`).join("・")}${cnt.get("none") ? `・送らない ${cnt.get("none")}` : ""}`);
    }
    if (SHADOW) console.log(`  影の道: ${summarizeShadow(rows).map((s) => `${s.label} ${s.count}`).join("／")}（影の下書き: ${SHADOW_DRAFT_OK ? "作る" : "作らない＝generate-reply に書かない呼び方がまだ無い"}・入口 ${SHADOW_BASE}）`);
    console.log(`  費用: 合計 $${total.toFixed(4)}（1往復あたり $${(total / rows.length).toFixed(4)}・うちお客様役の DeepSeek $${simTotal.toFixed(5)}）`);
    console.log(`  記録: ${logFile}`);
    if (state.finished) console.log("  筋書きの最後まで進みました（次に同じ筋書きを動かすと最初から）");
  }
}

main().catch((e) => { console.error("失敗:", e instanceof Error ? e.message : e); process.exit(1); });
