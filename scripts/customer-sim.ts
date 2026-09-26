// scripts/customer-sim.ts
// お客様役（テスト・YUMA 専用）の往復を回す。2026-09-27 竹内「YUMA で自動的に YUMA から自動返信が来て、返信を繰り返せたら理想」。
//
// 1往復 = ①お客様役: 本番の /api/test/customer-sim が筋書きの段から DeepSeek でお客様の返事を作り、webhook と同じ関数で YUMA に入れる
//           （LINE は通らない＝YUMA の LINE には出ない・画面の会話にだけ入る。印は messages.line_message_id="sim-…"）
//         ②本番の流れのまま: 下書きの起動（bg-async）→ブレイン（Claude）→返信の生成（DeepSeek）を待つ
//         ③スタッフ役: ブレインが AIX（会話だけで作れる種類）を選んだら本番の /api/aix/action で作って送る／AIX なしなら下書きを送る
//           （送るのは本番の /api/send-line-message ＝ YUMA の LINE に実際に届く。記録は画面の送信と同じ形で messages・会話・判断の結果へ）
//           材料が要る AIX（物件・見積書・管理会社の回答・日程）は送らずに止める → 画面で送ってから、もう一度このスクリプトを動かすと続きから
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
    if (s.scenarioId === scenarioId && !s.finished) return s;
  }
  const now = new Date();
  return { runId: `${scenarioId}-${now.toISOString().replace(/[:.]/g, "").slice(0, 15)}`, scenarioId, cursor: { stepIndex: 0, turnsOnStep: 0 }, round: 0, startedAt: now.toISOString(), finished: false };
}
const saveState = (s: State) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

type MsgRow = { id: string; sender: string; text: string | null; created_at: string; line_message_id: string | null; is_aix_generated: boolean | null; image_url: string | null };
async function recentMessages(limit = 30): Promise<MsgRow[]> {
  const { data, error } = await sb.from("messages").select("id, sender, text, created_at, line_message_id, is_aix_generated, image_url")
    .eq("conversation_id", CONV).order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error(`messages: ${error.message}`);
  return ((data ?? []) as MsgRow[]).reverse();
}
type ConvRow = { line_user_id: string; account: string | null; customer_name: string | null; status: string | null; ai_draft: string | null; suggested_aix_meta: Record<string, unknown> | null };
async function conv(): Promise<ConvRow> {
  const { data, error } = await sb.from("conversations").select("line_user_id, account, customer_name, status, ai_draft, suggested_aix_meta").eq("id", CONV).maybeSingle();
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

async function generateAix(action: string, checkPattern: string | null, c: ConvRow, msgs: MsgRow[]): Promise<string | null> {
  const res = await fetch(`${BASE}/api/aix/action`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action, account: c.account ?? "sumora", conversation_id: CONV, customer_name: c.customer_name ?? "",
      conversation_match: true, ...(checkPattern ? { check_pattern: checkPattern } : {}),
      recent_messages: msgs.slice(-20).map((m) => ({ sender: m.sender, text: m.text ?? "", rawCreatedAt: m.created_at, isAix: !!m.is_aix_generated, imageUrl: m.image_url ?? undefined })),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const j = await res.json().catch(() => ({})) as { message_text?: string; notice?: string; error?: string };
  if (!res.ok) throw new Error(`AIX の生成に失敗: HTTP ${res.status} ${j.error ?? ""}`);
  return draftToSendableText(j.message_text ?? null);
}

/** 画面の送信（page.tsx の handleSend / sendMessageText）と同じ記録で送る */
async function sendAsStaff(text: string, isAix: boolean, c: ConvRow, aixType: string | null, checkPattern: string | null, predicted: string | null): Promise<{ lineMessageId: string | null }> {
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
      body: JSON.stringify({ conversation_id: CONV, aix_type: aixType, conversation_status: c.status, suggested_action: predicted, line_message_id: lineMessageId, sent_at: now, check_pattern: checkPattern, generated_text: text, was_edited: false }),
      signal: AbortSignal.timeout(30_000),
    }).catch((e) => console.warn("  log-aix-usage 失敗:", e instanceof Error ? e.message : e));
  }
  return { lineMessageId };
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
};

function printRow(r: Row) {
  console.log(`\n━━ 往復 ${r.round}（${r.step}）${r.at}`);
  console.log(`  お客様役[${r.customerSource}${r.goalReached === null ? "" : r.goalReached ? "・目的○" : "・目的×"}]: ${one(r.customer, 200)}`);
  if (r.brain) console.log(`  ブレイン: AIX=${r.brain.action ?? "なし"} reply_mode=${r.brain.reply_mode ?? "-"} 段階=${r.brain.stage ?? "-"} 並行検索=${r.brain.parallel_search ? "ON" : "OFF"} 方向=${one(r.brain.direction, 60)}（${r.waitedSec}秒）`);
  else console.log(`  ブレイン: 判断が来なかった（${r.waitedSec}秒）`);
  console.log(`  スタッフ役: ${r.plan}`);
  if (r.draft && r.draft !== r.sent) console.log(`  下書き: ${one(r.draft, 200)}`);
  console.log(`  送った文${r.sentKind ? `（${r.sentKind}）` : ""}: ${r.sent ? one(r.sent, 300) : "（送っていない）"}`);
  console.log(`  状況の表示: ${r.headline}${r.conflicts ? `（⚠ずれ ${r.conflicts}）` : ""}`);
  if (r.changes) console.log(`  変化: 送った事実[${r.changes.facts.join(", ") || "-"}] 送った物件[${r.changes.props.join(", ") || "-"}] タスク[${r.changes.tasks.join(", ") || "-"}] AIX要対応+${r.changes.aixItems} カレンダー+${r.changes.calendar < 0 ? "?" : r.changes.calendar}`);
  console.log(`  費用: この往復 $${r.usd.toFixed(4)}（うちお客様役 $${r.simUsd.toFixed(5)}）`);
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
    const plan = planStaffAction(meta as { action?: string | null; reply_mode?: string | null; check_pattern?: string | null } | null);
    const historyBefore: SimHistoryItem[] = (await recentMessages()).map((x) => ({ sender: x.sender, text: x.text, isAix: x.is_aix_generated, hasImage: !!x.image_url, createdAt: x.created_at }));

    let sent: string | null = null, sentKind: string | null = null, planLabel = "", note: string | undefined;
    let stop = false;
    try {
      if (plan.kind === "wait") { planLabel = "判断が来ないので止める"; stop = true; }
      else if (plan.kind === "aix_needs_material") {
        planLabel = `AIX【${plan.action}】は材料（物件・見積書・回答・日程）が要る → 送らずに止める`;
        note = "画面で AIX を送ってから、もう一度同じ命令で続きから進みます"; stop = true;
      } else if (plan.kind === "aix") {
        const text = await generateAix(plan.action, plan.checkPattern, c, msgs);
        planLabel = `AIX【${plan.action}】を本番の生成で作って送る`;
        if (!text) { planLabel += " → 生成が空"; stop = true; }
        else if (flag("no-send")) { planLabel += "（--no-send: 送る直前で止めた）"; sent = null; note = `送る予定の文: ${one(text, 300)}`; stop = true; }
        else { await sendAsStaff(text, true, c, plan.action, plan.checkPattern, brain?.action ?? null); sent = text; sentKind = `AIX ${plan.action}`; }
      } else {
        planLabel = "AIX なし → 下書きをそのまま送る";
        if (!draft) { planLabel += " → 下書きが来なかった"; stop = true; }
        else if (flag("no-send")) { planLabel += "（--no-send: 送る直前で止めた）"; stop = true; }
        else { await sendAsStaff(draft, false, c, null, null, brain?.action ?? null); sent = draft; sentKind = "下書き"; }
      }
    } catch (e) {
      planLabel += ` → 失敗: ${e instanceof Error ? e.message : e}`; stop = true;
    }

    if (sent) await sleep(SETTLE_MS); // 送った後の記録（送った事実・ブレインの再分析）が落ち着くのを待つ
    const st = await stateLine();
    const changes = await changesSince(roundStart);
    const cost = await costSince(roundStart);
    const findings = auditSimTurn({
      sentText: sent, historyBefore, brainStage: brain?.stage ?? null, expectStage: usedStepIndex === null ? null : (scenario.steps[usedStepIndex]?.expect_stage ?? null), stateConflicts: st.conflicts,
      groundingExtra: [...changes.props],
    });
    const row: Row = {
      round: state.round, step: stepLabel, at: jst(customerAt), customer: customerText, customerSource, goalReached, brain, plan: planLabel,
      draft, sent, sentKind, headline: st.headline, conflicts: st.conflicts, changes, usd: cost.usd, simUsd, waitedSec: Math.round(waitedMs / 1000), findings, note,
    };
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
    console.log(`  費用: 合計 $${total.toFixed(4)}（1往復あたり $${(total / rows.length).toFixed(4)}・うちお客様役の DeepSeek $${simTotal.toFixed(5)}）`);
    console.log(`  記録: ${logFile}`);
    if (state.finished) console.log("  筋書きの最後まで進みました（次に同じ筋書きを動かすと最初から）");
  }
}

main().catch((e) => { console.error("失敗:", e instanceof Error ? e.message : e); process.exit(1); });
