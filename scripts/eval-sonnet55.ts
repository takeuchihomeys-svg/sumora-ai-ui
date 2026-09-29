// scripts/eval-sonnet55.ts — Sonnet 5 と Sonnet 5.5 に「本番と同じ入力」を送り比べる（読むだけ・DB に書かない・LINE に送らない）
//
// 2026-09-29 竹内「Sonnet を Sonnet 5.5 に置き換えたら費用高くなるか。費用も抑えて質が上がるなら置き換える。費用と性能が上がるようにする」。
//   出口の置き換え（app/lib/claude-model-map.ts）を入れる前に、置き換え候補の action ごとに実物で比べる:
//     ①最終チェック context_check（Sonnet 段）: 過去の下書き（スタッフが直して送った物・そのまま送った物）。誤検知（そのまま送られた下書きへの指摘）と
//       見逃し（スタッフが直した文を指摘できたか）・JSON の形（structured outputs）
//     ②最終チェック revision（書き直し）: 直された下書きに同じ指摘を渡し、書き直しがスタッフの送信に近づくか
//     ③ブレイン（brain_fresh）: 本番の analyzeConversation をそのまま動かして Claude への本文を横取りし（送らない）、その本文を両方に送る。
//       会話は「スタッフが動いた直前」まで巻き戻す（messages・aix_usage_logs を created_at で切る）。次の手（AIX の種類・返信か AIX か）がスタッフの実際の行動と合うか
//     ④customer-summary: 本番の POST をそのまま動かして本文を横取りし、両方に送る（property_customers への書き込みは下の関所で止まる）
//   5.5 側の本文は出口と同じ純関数 mapClaudeModelRequest で作る（＝本番で送る形そのもの。thinking disabled→between_tools）。
//
// 【安全の関所】globalThis.fetch をこのファイルの先頭で包む（アプリのモジュールは後から動的 import＝全部この包みを通る）:
//   ・Supabase への書き込み（GET/HEAD 以外。rpc の検索は通す）は 403 を返して止める ・LINE 等、許可していない宛先は例外
//   ・Anthropic への本物の呼び出しは「横取り」（本文を控えて 400 を返す）か、比べる時だけ自分で送る
// 実行: npx tsx --env-file=.env.local scripts/eval-sonnet55.ts [--fc=9] [--brain=8] [--summary=8] [--rev=5] [--days=21] [--out=<json のパス>] [--budget=3]
//   --out の JSON は個人情報を含むのでリポジトリの外（scratchpad 等）に置く。画面の表示は maskPII で伏せる
//   鍵は本番と同じ ANTHROPIC_API_KEY（feedback_test_api_cost_ok）。合計が --budget（$）を超えそうなら残りを飛ばす

const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SB_HOST = SB_URL ? new URL(SB_URL).host : "";
const API_KEY = (process.env.ANTHROPIC_API_KEY ?? "").replace(/\s/g, "");

type Captured = { action: string | null; body: string };
const guard = { blockedWrites: 0, blockedHosts: [] as string[], passAnthropic: 0, passAnthropicUsd: 0 };
let capture: { want: (action: string | null, body: string) => boolean; got: Captured[] } | null = null;
let timeTravel: { cutoffIso: string } | null = null;

function urlOf(input: RequestInfo | URL): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL((input as Request).url);
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = urlOf(input);
  const method = String(init?.method ?? (typeof input === "object" && "method" in (input as Request) ? (input as Request).method : "GET")).toUpperCase();
  if (url.host === SB_HOST) {
    if (method !== "GET" && method !== "HEAD" && !url.pathname.startsWith("/rest/v1/rpc/")) {
      guard.blockedWrites++;
      return new Response(JSON.stringify({ message: "eval-sonnet55: write blocked", code: "EVAL" }), { status: 403, headers: { "content-type": "application/json" } });
    }
    // 巻き戻し: 会話の発言・AIX の記録は「スタッフが動いた直前」まで
    if (timeTravel && method === "GET" && /\/rest\/v1\/(messages|aix_usage_logs)$/.test(url.pathname)) {
      url.searchParams.append("created_at", `lte.${timeTravel.cutoffIso}`);
      return realFetch(url.toString(), init);
    }
    return realFetch(input, init);
  }
  if (url.host === "api.anthropic.com") {
    const h = new Headers(init?.headers);
    const action = h.get("x-sumora-llm-action");
    const body = typeof init?.body === "string" ? init.body : "";
    if (capture && url.pathname === "/v1/messages" && capture.want(action, body)) {
      capture.got.push({ action, body });
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "eval-sonnet55 capture" } }), { status: 400, headers: { "content-type": "application/json" } });
    }
    // 横取りしない Claude の呼び出し（前処理の Haiku 等）は本物に送る。印のヘッダは Anthropic に送らない（本番の出口と同じ）
    for (const k of [...h.keys()]) if (k.startsWith("x-sumora-")) h.delete(k);
    guard.passAnthropic++;
    const res = await realFetch(input, { ...init, headers: h });
    try {
      const j = JSON.parse(await res.clone().text()) as { model?: string; usage?: Record<string, unknown> };
      if (j.model) guard.passAnthropicUsd += claudeUsageUsd(usageFromAnthropic(j.model, j.usage));
    } catch { /* SSE 等は数えない */ }
    return res;
  }
  if (url.host === "api.openai.com") return realFetch(input, init); // 埋め込み（検索の材料）
  guard.blockedHosts.push(url.host);
  throw new Error(`eval-sonnet55: blocked host ${url.host}`);
}) as typeof fetch;

import * as fs from "fs";
import { mapClaudeModelRequest, SONNET_55_MODEL } from "@/app/lib/claude-model-map";
import { claudeUsageUsd, usageFromAnthropic } from "@/app/lib/llm-price";
import { maskPII } from "@/app/lib/pii-mask";

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); if (m) args.set(m[1], m[2] ?? "true"); }
const N_FC = Number(args.get("fc") ?? "9");
const N_REV = Number(args.get("rev") ?? "5");
const N_BRAIN = Number(args.get("brain") ?? "8");
const N_SUM = Number(args.get("summary") ?? "8");
const DAYS = Number(args.get("days") ?? "21");
const OUT = args.get("out") ?? null;
const BUDGET = Number(args.get("budget") ?? "3");
const ONLY = (args.get("only") ?? "fc,rev,brain,summary").split(",");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

// ── 送る・測る ─────────────────────────────────────────────────────────────
type CallResult = {
  model: string; status: number; ms: number; usd: number; stop: string | null; text: string; error: string | null;
  usage: { unc: number; read: number; w5: number; w1: number; out: number };
};
let spent = 0;
async function send(body: string): Promise<CallResult> {
  const t0 = Date.now();
  const j0 = JSON.parse(body) as Record<string, unknown>;
  delete j0.stream; // 比べやすさのため非ストリーミングにそろえる（キャッシュの鍵に入らない）
  const res = await realFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31" },
    body: JSON.stringify(j0),
    signal: AbortSignal.timeout(180_000),
  });
  const ms = Date.now() - t0;
  const raw = await res.text();
  let j: { model?: string; stop_reason?: string; content?: Array<{ type: string; text?: string }>; usage?: Record<string, unknown>; error?: { message?: string } } = {};
  try { j = JSON.parse(raw); } catch { /* */ }
  const model = String(j.model ?? j0.model);
  const u = usageFromAnthropic(model, j.usage);
  const usd = claudeUsageUsd(u);
  spent += usd;
  return {
    model, status: res.status, ms, usd, stop: j.stop_reason ?? null, error: res.ok ? null : (j.error?.message ?? raw.slice(0, 200)),
    text: (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join(""),
    usage: { unc: u.input_uncached ?? 0, read: u.cache_read ?? 0, w5: u.cache_write_5m ?? 0, w1: u.cache_write_1h ?? 0, out: u.output_tokens ?? 0 },
  };
}
/** 同じ本文を Sonnet 5（そのまま）と Sonnet 5.5（出口の写し）に送る */
async function sendBoth(body: string, action: string | null): Promise<{ a: CallResult; b: CallResult; edits: string[] }> {
  const m = mapClaudeModelRequest(body, { CLAUDE_SONNET_MODEL: SONNET_55_MODEL, CLAUDE_SONNET55_ACTIONS: "*" }, action);
  if (!m.changed) throw new Error(`写せない本文（${m.reason}）`);
  const a = await send(body);
  const b = await send(m.body);
  return { a, b, edits: m.edits };
}
const overBudget = () => spent >= BUDGET * 0.92;
// 時計を過去に合わせる（プロンプトの【現在時刻】・経過日数を「その時」にする。jstParts 等は既定引数で Date.now() を読む）。new Date() 無引数は合わない（注記）
const realNow = Date.now;
function withClock<T>(atMs: number, fn: () => T): T { const base = realNow(); Date.now = () => atMs + (realNow() - base); try { return fn(); } finally { Date.now = realNow; } }
async function withClockAsync<T>(atMs: number, fn: () => Promise<T>): Promise<T> { const base = realNow(); Date.now = () => atMs + (realNow() - base); try { return await fn(); } finally { Date.now = realNow; } }

const norm = (s: string) => (s ?? "").replace(/\s+/g, "");
function bigrams(s: string): Set<string> { const t = norm(s); const out = new Set<string>(); for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2)); return out; }
function dice(a: string, b: string): number { const A = bigrams(a), B = bigrams(b); if (!A.size && !B.size) return 1; let n = 0; for (const x of A) if (B.has(x)) n++; return (2 * n) / (A.size + B.size || 1); }
const sentences = (s: string) => (s ?? "").split(/(?<=[。！!？?\n])/).map((x) => x.trim()).filter((x) => norm(x).length >= 4);
const show = (s: string, names: string[] = [], n = 160) => maskPII((s ?? "").replace(/\s+/g, " "), names).slice(0, n);
const med = (a: number[]) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

type Row = Record<string, unknown>;
const report: Record<string, unknown> = { startedAt: new Date().toISOString() };

async function main() {
  if (!API_KEY) throw new Error("ANTHROPIC_API_KEY が未設定（--env-file=.env.local）");
  // アプリのモジュールは fetch を包んだ後に読む（Supabase・Anthropic の client が包んだ fetch を掴む）
  const { supabase } = await import("@/app/lib/supabase");
  const { getCachedPromptRules } = await import("@/app/lib/prompt-cache");
  const fc = await import("@/app/lib/final-check");
  const { buildActionLedger } = await import("@/app/lib/action-ledger");
  const rc = await import("@/app/lib/reply-context");
  const { resolveAddressName } = await import("@/app/lib/validate-reply");
  const { isConditionFormMessage } = await import("@/app/lib/line-reply-prompts");
  const { isUsableExampleText } = await import("@/app/lib/example-hygiene");
  const { isTestConversation } = await import("@/app/lib/test-conversations");
  const { normalizeAixActionKey } = await import("@/app/lib/aix-taxonomy");

  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const [dbRules, finalCheckRules] = await Promise.all([
    getCachedPromptRules("generate_reply", { conversation_state: "proposing", is_first_reply: "false" }),
    getCachedPromptRules("final_check", {}, false),
  ]);

  type Msg = { sender: string; text: string; created_at: string; is_aix_generated: boolean | null };
  const convCache = new Map<string, { status: string | null; name: string | null; pcName: string | null; msgs: Msg[]; aix: Row[]; tasks: Row[] }>();
  async function loadConv(cid: string) {
    const hit = convCache.get(cid); if (hit) return hit;
    const [c, m, a, t] = await Promise.all([
      supabase.from("conversations").select("status, customer_name, property_customer_id").eq("id", cid).maybeSingle(),
      supabase.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", cid).order("created_at", { ascending: false }).limit(300),
      supabase.from("aix_usage_logs").select("aix_type, check_pattern, created_at, sent_at, line_message_id, generated_text, property_names, estimate_sent, template_name").eq("conversation_id", cid).order("created_at", { ascending: false }).limit(300),
      supabase.from("line_tasks").select("task_type, status, created_at, completed_at, result").eq("conversation_id", cid).limit(300),
    ]);
    const conv = c.data as Row | null;
    let pcName: string | null = null;
    if (conv?.property_customer_id) {
      const { data: pc } = await supabase.from("property_customers").select("customer_name").eq("id", conv.property_customer_id as string).maybeSingle();
      pcName = (pc as Row | null)?.customer_name as string | null ?? null;
    }
    const v = {
      status: (conv?.status as string | null) ?? null, name: (conv?.customer_name as string | null) ?? null, pcName,
      msgs: ((m.data ?? []) as Msg[]).reverse().filter((x) => typeof x.text === "string"), aix: (a.data ?? []) as Row[], tasks: (t.data ?? []) as Row[],
    };
    convCache.set(cid, v);
    return v;
  }

  /** scripts/audit-final-check-vs-staff.ts と同じ組み立て（本番 page.tsx / generate-draft-bg-async と同じ「未返信の顧客発言を MSG_SEP でつなぐ」）＋会社ルール */
  async function buildCtx(e: { conversation_id: string; sent_reply: string; sent_at: string | null; created_at: string }) {
    const conv = await loadConv(e.conversation_id);
    const msgs = conv.msgs;
    const head = norm(e.sent_reply).slice(0, 60);
    let idx = msgs.findIndex((x) => x.sender === "staff" && head.length >= 8 && (norm(x.text).startsWith(head) || (head.startsWith(norm(x.text).slice(0, 60)) && norm(x.text).length >= 20)));
    if (idx < 0) {
      const t = Date.parse(e.sent_at ?? e.created_at); let best = -1, bd = 10 * 60 * 1000;
      msgs.forEach((x, i) => { if (x.sender !== "staff") return; const d = Math.abs(Date.parse(x.created_at) - t); if (d <= bd) { bd = d; best = i; } });
      idx = best;
    }
    if (idx < 0) return null;
    let start = idx;
    while (start > 0 && msgs[start - 1].sender === "staff" && Date.parse(msgs[start].created_at) - Date.parse(msgs[start - 1].created_at) <= 10 * 60 * 1000) start--;
    const before = msgs.slice(0, start);
    const custUnits: string[] = [];
    for (let j = before.length - 1; j >= 0 && before[j].sender !== "staff"; j--) if (before[j].sender === "customer") custUnits.unshift(before[j].text);
    if (custUnits.length === 0) return null;
    const cust = custUnits.join(rc.MSG_SEP);
    const sendAt = Date.parse(msgs[idx].created_at);
    const recent = before.slice(-10).map((x) => ({ sender: x.sender, text: x.text, createdAt: x.created_at, isAix: !!x.is_aix_generated }));
    const lastStaffMsg = [...before].reverse().find((x) => x.sender === "staff");
    const aixRows = conv.aix.filter((r) => Date.parse(String(r.created_at ?? "")) < sendAt - 1000) as never[];
    const ledgerTasks = conv.tasks.filter((t) => Date.parse(String(t.created_at ?? "")) < sendAt) as never[];
    const ledger = buildActionLedger({ recentAixRows: aixRows, messages: before.slice(-30).map((x) => ({ sender: x.sender, text: x.text, createdAt: x.created_at, isAix: !!x.is_aix_generated })), lineTasks: ledgerTasks, lastCustomerAt: before[before.length - 1]?.created_at ?? null, now: sendAt });
    const staff = rc.classifyLastStaffTurn(lastStaffMsg?.text ?? "", { recentAixRows: aixRows, lastStaffAt: lastStaffMsg?.created_at ?? null, ledger });
    const sub = rc.analyzeSubstance(cust, custUnits, { staffAskedQuestion: staff.kind === "question_to_customer" });
    const customer = rc.classifyCustomerResponse(sub, staff, { ledger, isConditionPresented: isConditionFormMessage(cust) });
    const lastStaffIdx = before.map((x) => x.sender).lastIndexOf("staff");
    const priorCustomerText = lastStaffIdx < 0 ? "" : [...before.slice(0, lastStaffIdx)].reverse().find((x) => x.sender === "customer")?.text ?? "";
    const addr = resolveAddressName({ messages: before.map((x) => ({ sender: x.sender, text: x.text, createdAt: x.created_at })), displayName: conv.name ?? "", pcName: conv.pcName ?? "" });
    const pair = rc.resolveTurnPair(staff, customer, sub, lastStaffMsg?.text ?? "", { ledger, customerName: addr.name, priorCustomerText });
    const ctx = {
      lastCustomerMessage: cust, recentMessages: recent, customerName: addr.name, nameAliases: addr.aliases, ledger, ledgerStrict: true,
      substance: sub, pairContext: pair, now: sendAt, dbRules, finalCheckRules, conversationStage: conv.status ?? undefined,
    } as unknown as Parameters<typeof fc.buildContextCheckPrompt>[1];
    return { ctx, names: [conv.name ?? "", conv.pcName ?? "", addr.name ?? ""].filter(Boolean), cust, sendAt };
  }

  // ═══ ①② 最終チェック ═══
  type Issue = { code?: string; message?: string; evidence?: string; suggestion?: string };
  const parseIssues = (t: string): Issue[] | null => { try { const j = JSON.parse(t) as { issues?: Issue[] }; return Array.isArray(j.issues) ? j.issues : null; } catch { return null; } };
  const fcRows: Row[] = [];
  const revRows: Row[] = [];
  if (ONLY.includes("fc") || ONLY.includes("rev")) {
    const { data: exs, error } = await supabase.from("ai_reply_examples")
      .select("id, conversation_id, sent_reply, ai_draft, created_at, sent_at")
      .eq("entry_source", "line_reply").not("ai_draft", "is", null).not("conversation_id", "is", null).gte("created_at", since)
      .order("created_at", { ascending: false }).limit(600);
    if (error) throw error;
    const pool = ((exs ?? []) as Array<{ id: string; conversation_id: string; sent_reply: string; ai_draft: string; created_at: string; sent_at: string | null }>)
      .filter((e) => e.conversation_id !== YUMA && !isTestConversation(e.conversation_id) && isUsableExampleText(e.sent_reply) && isUsableExampleText(e.ai_draft) && norm(e.ai_draft).length >= 20);
    const same = pool.filter((e) => norm(e.ai_draft) === norm(e.sent_reply));
    // 直した物: 一部だけ直した（全面書き換えでない）＝指摘できたかを文で見られる物
    const modified = pool.filter((e) => norm(e.ai_draft) !== norm(e.sent_reply) && dice(e.ai_draft, e.sent_reply) >= 0.35);
    // 会話がかぶらないように選ぶ
    const pick = (arr: typeof pool, n: number) => { const seen = new Set<string>(); const out: typeof pool = []; for (const e of arr) { if (out.length >= n) break; if (seen.has(e.conversation_id)) continue; seen.add(e.conversation_id); out.push(e); } return out; };
    const cases = [...pick(same, N_FC).map((e) => ({ e, kind: "as_is" as const })), ...pick(modified, N_FC).map((e) => ({ e, kind: "edited" as const }))];
    console.log(`\n■ 最終チェック context_check: そのまま送った ${cases.filter((c) => c.kind === "as_is").length} 件・直して送った ${cases.filter((c) => c.kind === "edited").length} 件（候補 ${same.length} / ${modified.length}）`);
    for (const { e, kind } of cases) {
      if (overBudget()) { console.log("  （予算に近いので残りを飛ばす）"); break; }
      const built = await buildCtx(e);
      if (!built) continue;
      const body = withClock(built.sendAt, () => JSON.stringify(fc.buildFinalCheckRequestBody(fc.buildContextCheckPrompt(e.ai_draft, built.ctx), "claude-sonnet-5", 2400, { structured: true })));
      let r: Awaited<ReturnType<typeof sendBoth>>;
      try { r = await sendBoth(body, "final_check_context_check"); } catch (err) { console.log("  送信失敗", err instanceof Error ? err.message : err); continue; }
      const ia = parseIssues(r.a.text), ib = parseIssues(r.b.text);
      const changed = kind === "edited" ? sentences(e.ai_draft).filter((s) => !norm(e.sent_reply).includes(norm(s))) : [];
      const hits = (iss: Issue[] | null) => (iss ?? []).some((i) => { const ev = norm(i.evidence ?? ""); return ev.length >= 4 && changed.some((s) => norm(s).includes(ev) || ev.includes(norm(s))); });
      const row = {
        id: e.id, kind, cid: e.conversation_id,
        a: { ...r.a, issues: ia, hit: hits(ia) }, b: { ...r.b, issues: ib, hit: hits(ib) }, edits: r.edits,
        draft: e.ai_draft, sent: e.sent_reply, cust: built.cust, changed, names: built.names,
      };
      fcRows.push(row);
      const codes = (x: Issue[] | null) => x === null ? "（JSON 不可）" : x.map((i) => i.code).join(",") || "なし";
      console.log(`  ${kind === "as_is" ? "そのまま" : "直した  "} ${e.id.slice(0, 8)}  5: ${codes(ia).padEnd(28)} ${r.a.ms}ms $${r.a.usd.toFixed(4)} | 5.5: ${codes(ib).padEnd(28)} ${r.b.ms}ms $${r.b.usd.toFixed(4)}${kind === "edited" ? `  指摘できた 5:${row.a.hit ? "○" : "×"} 5.5:${row.b.hit ? "○" : "×"}` : ""}${r.b.stop === "refusal" ? " ⚠5.5断り" : ""}`);
    }

    // ② 書き直し: 直された下書きで、どちらかが指摘を出した物。同じ指摘（両方の和）を両モデルに渡す
    if (ONLY.includes("rev")) {
      const revCases = fcRows.filter((x) => x.kind === "edited" && (((x.a as Row).issues as Issue[] | null)?.length || ((x.b as Row).issues as Issue[] | null)?.length)).slice(0, N_REV);
      console.log(`\n■ 最終チェック revision（書き直し）: ${revCases.length} 件（直された下書き・両モデルの指摘の和を渡す）`);
      for (const x of revCases) {
        if (overBudget()) { console.log("  （予算に近いので残りを飛ばす）"); break; }
        const e = { conversation_id: x.cid as string, sent_reply: x.sent as string, sent_at: null, created_at: new Date().toISOString() };
        const exRow = (exs ?? []).find((y) => (y as Row).id === x.id) as Row | undefined;
        const built = await buildCtx({ ...e, sent_at: (exRow?.sent_at as string | null) ?? null, created_at: String(exRow?.created_at ?? e.created_at) });
        if (!built) continue;
        const seen = new Set<string>();
        const issues = [...(((x.a as Row).issues as Issue[] | null) ?? []), ...(((x.b as Row).issues as Issue[] | null) ?? [])]
          .filter((i) => { const k = `${i.code}|${i.evidence}`; if (seen.has(k)) return false; seen.add(k); return true; })
          .map((i) => ({ pass: "context_check", severity: "warning", code: i.code ?? "UNKNOWN", message: i.message ?? "", evidence: i.evidence ?? "", suggestion: i.suggestion ?? "" })) as never[];
        const draft = x.draft as string;
        const body = withClock(built.sendAt, () => JSON.stringify(fc.buildFinalCheckRequestBody(fc.buildSonnetRevisionPrompt(draft, issues, built.ctx), "claude-sonnet-5", Math.max(2000, Math.ceil(draft.length * 2.5)), { structured: false })));
        let r: Awaited<ReturnType<typeof sendBoth>>;
        try { r = await sendBoth(body, "final_check_revision"); } catch (err) { console.log("  送信失敗", err instanceof Error ? err.message : err); continue; }
        const sent = x.sent as string;
        const row = { id: x.id, issues, a: { ...r.a, simToSent: dice(r.a.text, sent) }, b: { ...r.b, simToSent: dice(r.b.text, sent) }, draftSimToSent: dice(draft, sent), draft, sent, names: x.names };
        revRows.push(row);
        console.log(`  ${String(x.id).slice(0, 8)} 下書き→送信 ${row.draftSimToSent.toFixed(2)} | 5: ${row.a.simToSent.toFixed(2)} ${r.a.ms}ms $${r.a.usd.toFixed(4)} | 5.5: ${row.b.simToSent.toFixed(2)} ${r.b.ms}ms $${r.b.usd.toFixed(4)}${r.b.stop === "refusal" ? " ⚠5.5断り" : ""}`);
      }
    }
  }

  // ═══ ③ ブレイン（brain_fresh）═══
  const brainRows: Row[] = [];
  if (ONLY.includes("brain") && !overBudget()) {
    const bc = await import("@/app/lib/brain-core");
    // スタッフの行動（AIX を送った／普通の返信をした）の直前の時点。申込以降は対象外（project_post_apply_out_of_scope）
    const POST_APPLY = new Set(["applying", "application", "screening", "contract", "approved", "closed", "lost"]);
    const { data: aixSent } = await supabase.from("aix_usage_logs").select("conversation_id, aix_type, sent_at, created_at").not("sent_at", "is", null).gte("sent_at", since).order("sent_at", { ascending: false }).limit(400);
    const { data: plain } = await supabase.from("ai_reply_examples").select("conversation_id, sent_at, created_at, sent_reply").eq("entry_source", "line_reply").not("sent_at", "is", null).gte("sent_at", since).order("sent_at", { ascending: false }).limit(400);
    type Turn = { cid: string; at: string; staff: string; staffAix: string | null };
    const turns: Turn[] = [];
    const aixBy = new Map<string, Row[]>();
    for (const r of (aixSent ?? []) as Row[]) aixBy.set(r.conversation_id as string, [...(aixBy.get(r.conversation_id as string) ?? []), r]);
    for (const r of (aixSent ?? []) as Row[]) turns.push({ cid: r.conversation_id as string, at: r.sent_at as string, staff: `AIX ${r.aix_type}`, staffAix: r.aix_type as string });
    for (const r of (plain ?? []) as Row[]) {
      const t = Date.parse(r.sent_at as string);
      // ±15分に AIX を送っていれば普通の返信の手とは数えない
      if ((aixBy.get(r.conversation_id as string) ?? []).some((a) => Math.abs(Date.parse(a.sent_at as string) - t) < 15 * 60 * 1000)) continue;
      turns.push({ cid: r.conversation_id as string, at: r.sent_at as string, staff: "返信", staffAix: null });
    }
    // 会話の状態・戦略で絞り、AIX と返信を半々に
    const convInfo = new Map<string, Row | null>();
    const infoOf = async (cid: string) => {
      if (convInfo.has(cid)) return convInfo.get(cid)!;
      const { data } = await supabase.from("conversations").select("id, status, property_customer_id, brain_strategy, suggested_aix_meta, conversation_direction, auto_send_enabled, is_hot, is_flagged, customer_name").eq("id", cid).maybeSingle();
      convInfo.set(cid, (data as Row | null) ?? null);
      return (data as Row | null) ?? null;
    };
    const chosen: Array<Turn & { conv: Row }> = [];
    const usedConv = new Set<string>();
    const wantAix = Math.ceil(N_BRAIN / 2), wantPlain = N_BRAIN - wantAix;
    for (const t of turns.sort((x, y) => (x.at < y.at ? 1 : -1))) {
      if (chosen.length >= N_BRAIN) break;
      if (usedConv.has(t.cid) || t.cid === YUMA || isTestConversation(t.cid)) continue;
      const isAix = !!t.staffAix;
      if (isAix && chosen.filter((c) => c.staffAix).length >= wantAix) continue;
      if (!isAix && chosen.filter((c) => !c.staffAix).length >= wantPlain) continue;
      const conv = await infoOf(t.cid);
      if (!conv || !conv.brain_strategy || POST_APPLY.has(String(conv.status))) continue;
      // 直前の発言がお客様であること（スタッフの手がお客様への応答）
      const cut = new Date(Date.parse(t.at) - 1000).toISOString();
      const { data: last } = await supabase.from("messages").select("sender, created_at").eq("conversation_id", t.cid).lte("created_at", cut).order("created_at", { ascending: false }).limit(1);
      if ((last?.[0] as Row | undefined)?.sender !== "customer") continue;
      usedConv.add(t.cid);
      chosen.push({ ...t, conv });
    }
    console.log(`\n■ ブレイン（brain_fresh・本番の analyzeConversation の本文を横取り）: ${chosen.length} 件（AIX ${chosen.filter((c) => c.staffAix).length}・返信 ${chosen.filter((c) => !c.staffAix).length}）`);
    for (const t of chosen) {
      if (overBudget()) { console.log("  （予算に近いので残りを飛ばす）"); break; }
      const conv = t.conv;
      timeTravel = { cutoffIso: new Date(Date.parse(t.at) - 1000).toISOString() };
      capture = { want: (a) => a === "brain_fresh" || a === "brain_full", got: [] };
      const prevDir = (conv.conversation_direction ?? null) as Row | null;
      try {
        await withClockAsync(Date.parse(t.at) - 1000, () => bc.analyzeConversation(t.cid, false, (conv.status as string | null) ?? null, (conv.property_customer_id as string | null) ?? null, "brain", {
          autoSendEnabled: conv.auto_send_enabled === false ? false : undefined,
          isHot: (conv.is_hot as boolean | null) ?? false, isFlagged: (conv.is_flagged as boolean | null) ?? false,
          prevPhase: typeof prevDir?.current_phase === "string" ? (prevDir.current_phase as string) : null,
          prevAix: typeof prevDir?.suggested_aix_button === "string" ? (prevDir.suggested_aix_button as string) : null,
          customerName: (conv.customer_name as string | undefined) ?? undefined,
          // 今の suggested_aix_meta はスタッフが動いた後の判断（未来の情報）なので渡さない。戦略（brain_strategy）は今の物しか無い＝少し未来を含む（注記）
          prevMeta: undefined,
          mode: "incremental", layer: "fresh", strategy: conv.brain_strategy as never, totalMsgCount: 0,
        }));
      } catch (err) { /* 横取りの 400 で止まる */ void err; }
      const got = capture.got[0];
      capture = null; timeTravel = null;
      if (!got) { console.log(`  ${t.cid.slice(0, 8)} 本文を横取りできなかった`); continue; }
      let r: Awaited<ReturnType<typeof sendBoth>>;
      try { r = await sendBoth(got.body, got.action); } catch (err) { console.log("  送信失敗", err instanceof Error ? err.message : err); continue; }
      const parse = (s: string): Row | null => { const a = s.indexOf("{"), b = s.lastIndexOf("}"); if (a < 0 || b <= a) return null; try { return JSON.parse(s.slice(a, b + 1)) as Row; } catch { return null; } };
      const pa = parse(r.a.text), pb = parse(r.b.text);
      const pick = (p: Row | null) => p ? { aix: normalizeAixActionKey(p.aix as string | null) ?? null, reply_mode: (p.reply_mode as string) ?? null, two_choice: !!p.two_choice_mode, intent: (p.customer_intent as string) ?? null, direction: String(p.reply_direction ?? ""), label: (p.reply_direction_label as string) ?? null, reason: String(p.reason ?? "") } : null;
      const A = pick(pa), B = pick(pb);
      const agreeStaff = (x: ReturnType<typeof pick>) => !x ? null : t.staffAix ? x.aix === t.staffAix : (!x.aix || x.reply_mode === "auto_reply");
      const row = { cid: t.cid, at: t.at, staff: t.staff, staffAix: t.staffAix, action: got.action, a: { ...r.a, out: A, agree: agreeStaff(A) }, b: { ...r.b, out: B, agree: agreeStaff(B) }, same: !!A && !!B && A.aix === B.aix && A.reply_mode === B.reply_mode, names: [String(conv.customer_name ?? "")] };
      brainRows.push(row);
      console.log(`  ${t.cid.slice(0, 8)} スタッフ: ${t.staff.padEnd(26)} | 5: ${String(A?.aix ?? "-")}/${A?.reply_mode ?? "JSON不可"} ${row.a.agree ? "○" : "×"} ${r.a.ms}ms $${r.a.usd.toFixed(4)} | 5.5: ${String(B?.aix ?? "-")}/${B?.reply_mode ?? "JSON不可"} ${row.b.agree ? "○" : "×"} ${r.b.ms}ms $${r.b.usd.toFixed(4)}${r.b.stop === "refusal" ? " ⚠5.5断り" : ""}`);
    }
  }

  // ═══ ④ customer-summary ═══
  const sumRows: Row[] = [];
  if (ONLY.includes("summary") && !overBudget()) {
    const route = await import("@/app/api/customer-summary/route");
    const { NextRequest } = await import("next/server");
    const { data: convs } = await supabase.from("conversations").select("id, property_customer_id, status, last_message, last_sender, customer_name")
      .not("property_customer_id", "is", null).gte("updated_at", since).order("updated_at", { ascending: false }).limit(80);
    const POST_APPLY = new Set(["applying", "application", "screening", "contract", "approved", "closed", "lost"]);
    const picks = ((convs ?? []) as Row[]).filter((c) => c.id !== YUMA && !isTestConversation(c.id as string) && !POST_APPLY.has(String(c.status))).slice(0, N_SUM);
    console.log(`\n■ customer-summary（本番の POST の本文を横取り）: ${picks.length} 件`);
    for (const c of picks) {
      if (overBudget()) { console.log("  （予算に近いので残りを飛ばす）"); break; }
      const { data: pc } = await supabase.from("property_customers").select("customer_name, status, desired_area, floor_plan, floor_area_min, rent_min, rent_max, walk_minutes, move_in_time, building_age, initial_cost_limit, preferences, ng_points, other_requests, property_memo, property_send_count, additional_conditions").eq("id", c.property_customer_id as string).maybeSingle();
      if (!pc) continue;
      capture = { want: (a) => a === "customer_summary", got: [] };
      const req = new NextRequest("http://localhost/api/customer-summary", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(pc as Row), customer_id: c.property_customer_id, conversation_id: c.id, last_message: c.last_message, last_message_sender: c.last_sender }) });
      try { await route.POST(req); } catch { /* 横取りの 400 */ }
      const got = capture.got[0];
      capture = null;
      if (!got) { console.log(`  ${String(c.id).slice(0, 8)} 本文を横取りできなかった`); continue; }
      let r: Awaited<ReturnType<typeof sendBoth>>;
      try { r = await sendBoth(got.body, got.action); } catch (err) { console.log("  送信失敗", err instanceof Error ? err.message : err); continue; }
      const parse = (s: string): Row | null => { const m = s.match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]) as Row; } catch { return null; } };
      const pa = parse(r.a.text), pb = parse(r.b.text);
      const ka = pa ? Object.keys(pa).sort() : [], kb = pb ? Object.keys(pb).sort() : [];
      const row = { cid: c.id, a: { ...r.a, json: pa }, b: { ...r.b, json: pb }, sameKeys: JSON.stringify(ka) === JSON.stringify(kb), keysA: ka, keysB: kb, names: [String(c.customer_name ?? ""), String((pc as Row).customer_name ?? "")] };
      sumRows.push(row);
      console.log(`  ${String(c.id).slice(0, 8)} 5: ${pa ? `${ka.length}項目` : "JSON不可"} ${r.a.usage.out}tok ${r.a.ms}ms $${r.a.usd.toFixed(4)} | 5.5: ${pb ? `${kb.length}項目` : "JSON不可"} ${r.b.usage.out}tok ${r.b.ms}ms $${r.b.usd.toFixed(4)} ${row.sameKeys ? "形一致" : "形が違う"}${r.b.stop === "refusal" ? " ⚠5.5断り" : ""}`);
    }
  }

  // ═══ まとめ ═══
  const agg = (rows: Row[], label: string) => {
    if (!rows.length) return;
    const A = rows.map((r) => r.a as CallResult), B = rows.map((r) => r.b as CallResult);
    const line = (xs: CallResult[]) => `$${(sum(xs.map((x) => x.usd)) / xs.length).toFixed(4)}/回・中央 ${med(xs.map((x) => x.ms))}ms・出力中央 ${med(xs.map((x) => x.usage.out))}tok・断り ${xs.filter((x) => x.stop === "refusal").length}・失敗 ${xs.filter((x) => x.status !== 200).length}`;
    console.log(`  [${label}] 5: ${line(A)}\n  ${" ".repeat(label.length + 2)} 5.5: ${line(B)}`);
    // キャッシュの書き込み（初回）を除いた1回あたり（本番は温まっている）
    const warm = (xs: CallResult[]) => { const w = xs.filter((x) => x.usage.w1 + x.usage.w5 === 0); return w.length ? `$${(sum(w.map((x) => x.usd)) / w.length).toFixed(4)}/回（書き込みなしの ${w.length} 回）` : "（全部書き込みあり）"; };
    console.log(`  ${" ".repeat(label.length + 2)} 温まった時: 5 ${warm(A)} ／ 5.5 ${warm(B)}`);
  };
  console.log("\n══════ まとめ ══════");
  if (fcRows.length) {
    const asIs = fcRows.filter((r) => r.kind === "as_is"), ed = fcRows.filter((r) => r.kind === "edited");
    const nIss = (r: Row, k: "a" | "b") => (((r[k] as Row).issues as Issue[] | null) ?? []).length;
    const jsonOk = (k: "a" | "b") => fcRows.filter((r) => (r[k] as Row).issues !== null).length;
    const codeSet = (r: Row, k: "a" | "b") => new Set((((r[k] as Row).issues as Issue[] | null) ?? []).map((i) => i.code));
    const agree = fcRows.filter((r) => { const x = codeSet(r, "a"), y = codeSet(r, "b"); return x.size === y.size && [...x].every((c) => y.has(c)); }).length;
    console.log(`■ context_check: JSON の形 5: ${jsonOk("a")}/${fcRows.length}・5.5: ${jsonOk("b")}/${fcRows.length} ／ 指摘コードの集合が一致 ${agree}/${fcRows.length}`);
    console.log(`  誤検知（そのまま送った下書きに指摘を出した件数）5: ${asIs.filter((r) => nIss(r, "a") > 0).length}/${asIs.length}（指摘 ${sum(asIs.map((r) => nIss(r, "a")))}）・5.5: ${asIs.filter((r) => nIss(r, "b") > 0).length}/${asIs.length}（指摘 ${sum(asIs.map((r) => nIss(r, "b")))}）`);
    console.log(`  見逃し（直された下書きで、直された文を指摘できなかった）5: ${ed.filter((r) => !(r.a as Row).hit).length}/${ed.length}・5.5: ${ed.filter((r) => !(r.b as Row).hit).length}/${ed.length}`);
    agg(fcRows, "context_check");
  }
  if (revRows.length) {
    console.log(`■ revision: 送信への近さ（bigram Dice・中央）下書き ${med(revRows.map((r) => r.draftSimToSent as number)).toFixed(2)} → 5: ${med(revRows.map((r) => (r.a as Row).simToSent as number)).toFixed(2)}・5.5: ${med(revRows.map((r) => (r.b as Row).simToSent as number)).toFixed(2)}`);
    agg(revRows, "revision");
  }
  if (brainRows.length) {
    const ok = (k: "a" | "b") => brainRows.filter((r) => ((r[k] as Row).out) !== null).length;
    const ag = (k: "a" | "b") => brainRows.filter((r) => (r[k] as Row).agree === true).length;
    console.log(`■ brain_fresh: JSON 5: ${ok("a")}/${brainRows.length}・5.5: ${ok("b")}/${brainRows.length} ／ スタッフの手と一致 5: ${ag("a")}/${brainRows.length}・5.5: ${ag("b")}/${brainRows.length} ／ 5 と 5.5 の手が同じ ${brainRows.filter((r) => r.same).length}/${brainRows.length}`);
    agg(brainRows, "brain_fresh");
  }
  if (sumRows.length) {
    console.log(`■ customer-summary: JSON 5: ${sumRows.filter((r) => (r.a as Row).json).length}/${sumRows.length}・5.5: ${sumRows.filter((r) => (r.b as Row).json).length}/${sumRows.length} ／ 項目の形が一致 ${sumRows.filter((r) => r.sameKeys).length}/${sumRows.length}`);
    agg(sumRows, "customer_summary");
  }
  console.log(`\n合計 $${spent.toFixed(3)}（比べた呼び出し）＋ 前処理の Claude $${guard.passAnthropicUsd.toFixed(3)}（${guard.passAnthropic} 回）／ 止めた DB 書き込み ${guard.blockedWrites} 回／ 止めた宛先 ${[...new Set(guard.blockedHosts)].join(",") || "なし"}`);

  // 違いの出た出力を読むための抜粋（伏せ字）
  console.log("\n══════ 違いが出た例（伏せ字・先頭のみ）══════");
  for (const r of fcRows) {
    const ia = ((r.a as Row).issues as Issue[] | null) ?? [], ib = ((r.b as Row).issues as Issue[] | null) ?? [];
    if (JSON.stringify(ia.map((i) => i.code).sort()) === JSON.stringify(ib.map((i) => i.code).sort())) continue;
    const names = r.names as string[];
    console.log(`\n[context_check ${r.kind} ${String(r.id).slice(0, 8)}] お客様「${show(r.cust as string, names, 120)}」\n  下書き「${show(r.draft as string, names, 220)}」\n  送信  「${show(r.sent as string, names, 220)}」`);
    for (const [k, iss] of [["5  ", ia], ["5.5", ib]] as const) for (const i of iss) console.log(`  ${k} [${i.code}] ${show(i.message ?? "", names, 90)} ／「${show(i.evidence ?? "", names, 60)}」`);
  }
  for (const r of revRows) {
    const names = r.names as string[];
    console.log(`\n[revision ${String(r.id).slice(0, 8)}]\n  下書き「${show(r.draft as string, names, 220)}」\n  送信  「${show(r.sent as string, names, 220)}」\n  5     「${show((r.a as CallResult).text, names, 220)}」\n  5.5   「${show((r.b as CallResult).text, names, 220)}」`);
  }
  for (const r of brainRows) {
    const A = (r.a as Row).out as Row | null, B = (r.b as Row).out as Row | null;
    if (r.same && A && B && A.two_choice === B.two_choice) continue;
    const names = r.names as string[];
    console.log(`\n[brain ${String(r.cid).slice(0, 8)} スタッフ=${r.staff}]\n  5  : ${A?.aix ?? "-"} / ${A?.reply_mode ?? "-"} / ${A?.label ?? ""} ／ ${show(String(A?.direction ?? ""), names, 160)}\n  5.5: ${B?.aix ?? "-"} / ${B?.reply_mode ?? "-"} / ${B?.label ?? ""} ／ ${show(String(B?.direction ?? ""), names, 160)}`);
  }
  for (const r of sumRows.slice(0, 3)) {
    const names = r.names as string[];
    const ja = (r.a as Row).json as Row | null, jb = (r.b as Row).json as Row | null;
    console.log(`\n[summary ${String(r.cid).slice(0, 8)}]\n  5   next_action: ${show(String(ja?.next_action ?? ""), names, 140)}\n  5.5 next_action: ${show(String(jb?.next_action ?? ""), names, 140)}\n  5   personality: ${show(String(ja?.personality_profile ?? ""), names, 140)}\n  5.5 personality: ${show(String(jb?.personality_profile ?? ""), names, 140)}`);
  }

  if (OUT) {
    Object.assign(report, { spent, guard, fcRows, revRows, brainRows, sumRows, finishedAt: new Date().toISOString() });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
    console.log(`\n詳細（個人情報を含む）: ${OUT}`);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
