// app/lib/llm-usage-recorder.ts
// Anthropic への全リクエストの使用量（キャッシュの読み・書き・割引なし・出力・思考）を出口（fetch）で1行ずつ DB に残す
//
// 2026-09-14 竹内（API の漏れ調査）: 使用量は console の llm:usage だけで、
//   ①約30の経路はそもそも出していない（customer-summary・suggest-next-action・save-reply-example・cron の多く）
//   ②返信生成はストリーミングのため出力トークンが常に0
//   ③Vercel ログの全文検索は広い範囲だと時間切れで、1日分のキャッシュの効き・費用を集計できない
//   → 呼び出し箇所（77ファイル）を1つずつ直すのではなく、全経路が通る出口で応答の usage を読む（設計知見「LLM 呼び出しの出口の型」）。
//   SDK の再試行・429/529/5xx もそれぞれ1行になるので「エラーで漏れ続けていないか」も数えられる。
//   どの呼び出しかは route（Next のリクエストの経路）と sys_head（system プロンプトの先頭80字）で見分ける（同じ route に複数の呼び出しがあるため）。
//   集計は llm_usage_daily ビュー（migrate-schema）。
// 2026-09-17 竹内（AIX キャッシュ点検）: sys_key は system 先頭400字のハッシュなので、AIX の共通 prefix を最初のブロックに分けると
//   「会話を合わせる」系 11 経路が1つの sys_key に潰れ、AIX の種類ごと・会話ごとの費用が読めない。
//   → 呼び出し側がリクエストの headers に x-sumora-llm-action / x-sumora-llm-conversation を付け、出口で読んで action / conversation_id に残す。
//   この2つは Anthropic に送らない（送る前に取り除く）。sys_key_full は system 全ブロックを "\n\n" で結合した全文のハッシュ（プロンプト変更の検出用）。

/** 呼び出し側が付ける印（Anthropic には送らない）。AIX の種類・LINE の会話 ID */
export const LLM_ACTION_HEADER = "x-sumora-llm-action";
export const LLM_CONVERSATION_HEADER = "x-sumora-llm-conversation";
/**
 * 2026-09-19 竹内「自動返信モードのお客さんの返信はクロードのAPI使う形でいく」:
 * 自動返信オンの会話の下書きに付ける印。**この印がある呼び出しは別のクラウドに回さない**
 * （人の目を通さずに送るので、モデルを替えて品質を賭けない）。llm-alt-provider が読む。
 */
export const LLM_AUTO_SEND_HEADER = "x-sumora-llm-auto-send";

/**
 * 2026-09-19 竹内「申込以降は渡さなくて大丈夫、申込までのツールなので」:
 * 申込フェーズ以降の会話に付ける印。**この印がある呼び出しは別のクラウドに回さない**
 * （個人情報が集中するうえ、このツールの仕事は申込まで）。llm-alt-provider が読む。
 */
export const LLM_POST_APPLY_HEADER = "x-sumora-llm-post-apply";

export type LlmUsageRow = {
  route: string | null;
  model: string | null;
  status: number;
  error_type: string | null;
  stream: boolean;
  stop_reason: string | null;
  input_uncached: number;
  cache_read: number;
  cache_write: number;
  cache_write_5m: number;
  cache_write_1h: number;
  output_tokens: number;
  thinking_tokens: number;
  max_tokens: number | null;
  thinking_mode: string | null;
  cache_breakpoints: number;
  sys_key: string | null;
  sys_head: string | null;
  duration_ms: number;
  request_id: string | null;
  env: string | null;
  action: string | null;
  conversation_id: string | null;
  sys_key_full: string | null;
};

type ReqInfo = Pick<LlmUsageRow, "model" | "stream" | "max_tokens" | "thinking_mode" | "cache_breakpoints" | "sys_key" | "sys_head" | "sys_key_full">;
type UsageInfo = Pick<LlmUsageRow, "error_type" | "stop_reason" | "input_uncached" | "cache_read" | "cache_write" | "cache_write_5m" | "cache_write_1h" | "output_tokens" | "thinking_tokens"> & { model: string | null };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** 同じ system プロンプトの呼び出しを同じ値にまとめる短いハッシュ（FNV-1a 32bit） */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function systemText(system: unknown): string | null {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    const first = system.find((b) => b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string") as { text: string } | undefined;
    return first?.text ?? null;
  }
  return null;
}

/** system の全ブロックを "\n\n" で結合した全文（ブロックの区切り位置を変えても、文面が同じなら同じ値になる） */
function systemFullText(system: unknown): string | null {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    const texts = system
      .filter((b) => b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string")
      .map((b) => (b as { text: string }).text);
    return texts.length > 0 ? texts.join("\n\n") : null;
  }
  return null;
}

/** リクエスト本文から、どの呼び出しか・どう呼んだかを読む（お客様の発言は保存しない＝system の先頭だけ） */
export function parseAnthropicRequest(body: string): ReqInfo {
  const info: ReqInfo = { model: null, stream: false, max_tokens: null, thinking_mode: null, cache_breakpoints: 0, sys_key: null, sys_head: null, sys_key_full: null };
  info.cache_breakpoints = (body.match(/"cache_control"/g) ?? []).length;
  try {
    const j = JSON.parse(body) as { model?: unknown; stream?: unknown; max_tokens?: unknown; thinking?: { type?: unknown } | null; system?: unknown };
    info.model = typeof j.model === "string" ? j.model : null;
    info.stream = j.stream === true;
    info.max_tokens = typeof j.max_tokens === "number" ? j.max_tokens : null;
    info.thinking_mode = j.thinking && typeof j.thinking.type === "string" ? j.thinking.type : "unset";
    const sys = systemText(j.system);
    if (sys) {
      const flat = sys.replace(/\s+/g, " ").trim();
      info.sys_head = flat.slice(0, 80);
      info.sys_key = shortHash(flat.slice(0, 400));
    }
    // 2026-09-17 竹内（AIX キャッシュ点検）: 先頭400字だけでは経路を見分けられなくなるので、全文のハッシュも残す
    const full = systemFullText(j.system);
    if (full) info.sys_key_full = shortHash(full);
  } catch { /* JSON でない本文は数だけ */ }
  return info;
}

type SumoraMarks = { action: string | null; conversationId: string | null; init: RequestInit | undefined };

/**
 * 2026-09-17 竹内（AIX キャッシュ点検）: 呼び出し側が付けた印（x-sumora-llm-action / x-sumora-llm-conversation）を headers から読み、
 * Anthropic に送る前に取り除く。headers は Headers / 配列 / Record のどの形でも動く。元の init は壊さず、印がある時だけ新しい headers を作る
 */
export function extractSumoraMarks(init: RequestInit | undefined): SumoraMarks {
  const none: SumoraMarks = { action: null, conversationId: null, init };
  const h = init?.headers;
  if (!h) return none;
  // 2026-09-19 竹内: 自動返信の印（x-sumora-llm-auto-send）も Anthropic に送らずここで取り除く
  const isMark = (k: string) => { const l = k.toLowerCase(); return l === LLM_ACTION_HEADER || l === LLM_CONVERSATION_HEADER || l === LLM_AUTO_SEND_HEADER || l === LLM_POST_APPLY_HEADER; };
  const pick = (k: string, v: unknown, out: SumoraMarks) => {
    let s = typeof v === "string" ? v.trim() : "";
    if (!s) return;
    // 2026-09-17 竹内（AIX キャッシュ点検）: 付ける側（aix-system-blocks の llmMetaHeaderValue）は非 ASCII を encodeURIComponent 済みで送るので戻す（失敗したらそのまま）
    if (s.includes("%")) { try { s = decodeURIComponent(s); } catch { /* 素の値 */ } }
    const l = k.toLowerCase();
    if (l === LLM_ACTION_HEADER) out.action = s;
    else if (l === LLM_AUTO_SEND_HEADER || l === LLM_POST_APPLY_HEADER) { /* 記録には使わない（llm-alt-provider が読む） */ }
    else out.conversationId = s;
  };
  const out: SumoraMarks = { action: null, conversationId: null, init };
  if (typeof Headers !== "undefined" && h instanceof Headers) {
    let found = false;
    h.forEach((v, k) => { if (isMark(k)) { found = true; pick(k, v, out); } });
    if (!found) return none;
    const copy = new Headers(h);
    copy.delete(LLM_ACTION_HEADER);
    copy.delete(LLM_CONVERSATION_HEADER);
    copy.delete(LLM_AUTO_SEND_HEADER);
    copy.delete(LLM_POST_APPLY_HEADER);
    out.init = { ...init, headers: copy };
    return out;
  }
  if (Array.isArray(h)) {
    const rest: [string, string][] = [];
    for (const pair of h as [string, string][]) {
      if (Array.isArray(pair) && typeof pair[0] === "string" && isMark(pair[0])) pick(pair[0], pair[1], out);
      else rest.push(pair);
    }
    if (rest.length === h.length) return none;
    out.init = { ...init, headers: rest };
    return out;
  }
  if (typeof h === "object") {
    const rec = h as Record<string, unknown>;
    const rest: Record<string, string> = {};
    let found = false;
    for (const k of Object.keys(rec)) {
      if (isMark(k)) { found = true; pick(k, rec[k], out); }
      else rest[k] = rec[k] as string;
    }
    if (!found) return none;
    out.init = { ...init, headers: rest };
    return out;
  }
  return none;
}

function emptyUsage(): UsageInfo {
  return { model: null, error_type: null, stop_reason: null, input_uncached: 0, cache_read: 0, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0, output_tokens: 0, thinking_tokens: 0 };
}

function applyUsage(u: UsageInfo, usage: Record<string, unknown> | null | undefined): void {
  if (!usage) return;
  // message_delta の usage は累計。0 や欠けている項目で上書きしない
  if (usage.input_tokens != null) u.input_uncached = Math.max(u.input_uncached, num(usage.input_tokens));
  if (usage.cache_read_input_tokens != null) u.cache_read = Math.max(u.cache_read, num(usage.cache_read_input_tokens));
  if (usage.cache_creation_input_tokens != null) u.cache_write = Math.max(u.cache_write, num(usage.cache_creation_input_tokens));
  const cc = usage.cache_creation as Record<string, unknown> | undefined;
  if (cc) {
    u.cache_write_5m = Math.max(u.cache_write_5m, num(cc.ephemeral_5m_input_tokens));
    u.cache_write_1h = Math.max(u.cache_write_1h, num(cc.ephemeral_1h_input_tokens));
  }
  if (usage.output_tokens != null) u.output_tokens = Math.max(u.output_tokens, num(usage.output_tokens));
  const od = usage.output_tokens_details as Record<string, unknown> | undefined;
  if (od?.thinking_tokens != null) u.thinking_tokens = Math.max(u.thinking_tokens, num(od.thinking_tokens));
}

/** 通常の JSON 応答（成功・エラー）から usage を読む */
export function parseUsageFromJson(text: string): UsageInfo {
  const u = emptyUsage();
  try {
    const j = JSON.parse(text) as { model?: unknown; usage?: Record<string, unknown>; stop_reason?: unknown; type?: unknown; error?: { type?: unknown } };
    if (j.type === "error") { u.error_type = typeof j.error?.type === "string" ? j.error.type : "error"; return u; }
    u.model = typeof j.model === "string" ? j.model : null;
    u.stop_reason = typeof j.stop_reason === "string" ? j.stop_reason : null;
    applyUsage(u, j.usage);
  } catch { u.error_type = "unparsable_response"; }
  return u;
}

/** ストリーミング（SSE）の応答から usage を読む（message_start に入力、message_delta に出力の累計） */
export function parseUsageFromSse(text: string): UsageInfo {
  const u = emptyUsage();
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let ev: { type?: unknown; message?: { model?: unknown; usage?: Record<string, unknown> }; usage?: Record<string, unknown>; delta?: { stop_reason?: unknown }; error?: { type?: unknown } };
    try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
    if (ev.type === "message_start") {
      u.model = typeof ev.message?.model === "string" ? ev.message.model : u.model;
      applyUsage(u, ev.message?.usage);
    } else if (ev.type === "message_delta") {
      applyUsage(u, ev.usage);
      if (typeof ev.delta?.stop_reason === "string") u.stop_reason = ev.delta.stop_reason;
    } else if (ev.type === "error") {
      u.error_type = typeof ev.error?.type === "string" ? ev.error.type : "stream_error";
    }
  }
  return u;
}

function requestUrl(input: unknown): URL | null {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return input;
    if (input && typeof input === "object" && "url" in input && typeof (input as { url: unknown }).url === "string") return new URL((input as { url: string }).url);
  } catch { /* 相対 URL */ }
  return null;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type RecorderDeps = {
  insert: (row: LlmUsageRow) => Promise<void>;
  keepAlive: (p: Promise<unknown>) => void;
  route: () => string | null;
  now?: () => number;
  env?: string | null;
};

/** Anthropic の /v1/messages だけを記録する。記録の失敗・遅れで本来の応答を止めない（応答は元の Response をそのまま返す） */
export function wrapFetchWithLlmUsageRecorder(original: FetchLike, deps: RecorderDeps): FetchLike {
  const now = deps.now ?? Date.now;
  return async (input, initArg) => {
    const url = requestUrl(input);
    const isAnthropic = !!url && url.hostname === "api.anthropic.com";
    // 2026-09-17 竹内（AIX キャッシュ点検）: 印のヘッダは Anthropic 宛の全リクエストから取り除く（count_tokens 等に SDK の既定ヘッダで付いても漏らさない）
    const marks = isAnthropic ? extractSumoraMarks(initArg) : { action: null, conversationId: null, init: initArg };
    const init = marks.init;
    const isMessages = isAnthropic && url.pathname === "/v1/messages" && (init?.method ?? "POST").toUpperCase() === "POST";
    if (!isMessages) return original(input, init);
    const started = now();
    let route: string | null = null;
    try { route = deps.route(); } catch { route = null; }
    const req = typeof init?.body === "string" ? parseAnthropicRequest(init.body) : parseAnthropicRequest("");
    const withMarks = (row: LlmUsageRow): LlmUsageRow => ({ ...row, action: marks.action, conversation_id: marks.conversationId });
    let res: Response;
    try {
      res = await original(input, init);
    } catch (e) {
      // 通信の失敗・中断（タイムアウトで abort 等）も1行にする（SDK の再試行の数が分かる）
      const name = e instanceof Error ? e.name : "fetch_error";
      deps.keepAlive(deps.insert(withMarks(buildRow(route, req, emptyUsage(), 0, name === "AbortError" ? "aborted" : "fetch_error", now() - started, null, deps.env ?? null))).catch(() => {}));
      throw e;
    }
    try {
      const clone = res.clone();
      const isSse = (res.headers.get("content-type") ?? "").includes("text/event-stream");
      const requestId = res.headers.get("request-id");
      const status = res.status;
      deps.keepAlive(
        clone.text()
          .then((text) => {
            const usage = isSse ? parseUsageFromSse(text) : parseUsageFromJson(text);
            return deps.insert(withMarks(buildRow(route, req, usage, status, usage.error_type ?? (status >= 400 ? `http_${status}` : null), now() - started, requestId, deps.env ?? null)));
          })
          .catch(() => deps.insert(withMarks(buildRow(route, req, emptyUsage(), status, "stream_aborted", now() - started, requestId, deps.env ?? null))).catch(() => {})),
      );
    } catch { /* clone できない応答は記録しない */ }
    return res;
  };
}

function buildRow(route: string | null, req: ReqInfo, u: UsageInfo, status: number, errorType: string | null, durationMs: number, requestId: string | null, env: string | null): LlmUsageRow {
  return {
    route, model: u.model ?? req.model, status, error_type: errorType, stream: req.stream, stop_reason: u.stop_reason,
    input_uncached: u.input_uncached, cache_read: u.cache_read, cache_write: u.cache_write, cache_write_5m: u.cache_write_5m, cache_write_1h: u.cache_write_1h,
    output_tokens: u.output_tokens, thinking_tokens: u.thinking_tokens,
    max_tokens: req.max_tokens, thinking_mode: req.thinking_mode, cache_breakpoints: req.cache_breakpoints, sys_key: req.sys_key, sys_head: req.sys_head,
    duration_ms: Math.max(0, Math.round(durationMs)), request_id: requestId, env,
    action: null, conversation_id: null, sys_key_full: req.sys_key_full,
  };
}

const INSTALLED = Symbol.for("sumora.llmUsageRecorder");

/**
 * 2026-09-17 竹内（AIX キャッシュ点検）: 記録を止めている時（LLM_USAGE_RECORD=off・Supabase の env なし）でも、
 * 印のヘッダ（x-sumora-llm-*）だけは Anthropic 宛のリクエストから取り除く（呼び出し側は recorder の有無を知らずに付けるため）
 */
export function wrapFetchStripSumoraMarks(original: FetchLike): FetchLike {
  return (input, init) => {
    const url = requestUrl(input);
    return original(input, url && url.hostname === "api.anthropic.com" ? extractSumoraMarks(init).init : init);
  };
}

function installWrapped(g: { fetch: FetchLike & Record<PropertyKey, unknown> }, original: FetchLike & Record<PropertyKey, unknown>, wrapped: FetchLike): void {
  const w = wrapped as FetchLike & Record<PropertyKey, unknown>;
  Object.assign(w, original);
  w[INSTALLED] = true;
  g.fetch = w;
}

// ── 別クラウド（DeepSeek 等）の記録 ──────────────────────────────────────────
// 2026-09-19 本番の検証で見つけた穴:
//   fetch の出口の記録は **api.anthropic.com 宛てだけ**を見ている。
//   llm-alt-provider は Anthropic 宛てを横取りして DeepSeek の URL を叩くので、
//   切り替わった呼び出しは1行も残らなかった（費用も質も後から追えない＝静かに壊れる）。
//   記録の仕組みを2か所に分けないため、書き込みの口はここに置き、alt-provider から呼ぶ。
type AltRecorder = { insert: (row: LlmUsageRow) => Promise<void>; keepAlive: (p: Promise<unknown>) => void; route: () => string | null; env: string | null };
let altRecorder: AltRecorder | null = null;

function lazyAltRecorder(): AltRecorder | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (process.env.LLM_USAGE_RECORD === "off" || !url || !key) return null;
  let warned = false;
  return {
    insert: async (row: LlmUsageRow) => {
      const { createClient } = await import("@supabase/supabase-js");
      const { error } = await createClient(url, key, { auth: { persistSession: false } }).from("llm_usage_logs").insert(row);
      if (error && !warned) { warned = true; console.warn("[llm-usage-recorder] insert failed (lazy):", error.message); }
    },
    keepAlive: (p: Promise<unknown>) => { import("@vercel/functions").then((m) => m.waitUntil(p)).catch(() => { /* Vercel 以外 */ }); },
    route: () => null,
    env: process.env.VERCEL_ENV ?? "local",
  };
}

/** 別クラウドの呼び出しを llm_usage_logs に1行残す（記録が使えない時は何もしない） */
export function recordAltUsage(input: {
  model: string;
  action: string | null;
  conversationId: string | null;
  /** Anthropic の形に変換済みの usage */
  usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  status: number;
  errorType: string | null;
  durationMs: number;
  /** 元の Anthropic リクエストの system 先頭（どの経路かを後から読むため） */
  sysHead: string | null;
  sysKeyFull: string | null;
  maxTokens: number | null;
  /** 1文字ずつの形（DeepSeek の streaming）か。2026-09-23 から記録（旧は常に false） */
  stream?: boolean;
}): void {
  // 2026-09-24: 開発サーバの HMR で llm-alt-provider が包み直した時（willRouteAlt）は、この module が instrumentation の物と別になり
  //   altRecorder が null のまま＝DeepSeek に回った呼び出しが1行も残らなかった（テストで model を確かめられない）→ その場で書き込みの口を作る
  const r = altRecorder ?? (altRecorder = lazyAltRecorder());
  if (!r) return;
  // 2026-09-25: 呼んだ場面ごとの action の読み替え（llm-action-scope.ts の runWithActionRename。器は globalThis に置き、ここでは node の部品を import しない）
  const scope = (globalThis as { __sumoraLlmActionScope?: { getStore(): { rename?: Record<string, string> } | undefined } }).__sumoraLlmActionScope?.getStore();
  const action = input.action && scope?.rename?.[input.action] ? scope.rename[input.action] : input.action;
  const row: LlmUsageRow = {
    route: r.route(), model: input.model, status: input.status, error_type: input.errorType,
    stream: input.stream ?? false, stop_reason: null,
    input_uncached: num(input.usage.input_tokens), cache_read: num(input.usage.cache_read_input_tokens),
    cache_write: 0, cache_write_5m: 0, cache_write_1h: 0,
    output_tokens: num(input.usage.output_tokens), thinking_tokens: 0,
    max_tokens: input.maxTokens, thinking_mode: null, cache_breakpoints: 0,
    sys_key: input.sysHead ? shortHash(input.sysHead.slice(0, 400)) : null,
    sys_head: input.sysHead ? input.sysHead.slice(0, 200) : null,
    duration_ms: Math.max(0, Math.round(input.durationMs)), request_id: null, env: r.env,
    action, conversation_id: input.conversationId, sys_key_full: input.sysKeyFull,
  };
  try { r.keepAlive(r.insert(row).catch(() => {})); } catch { /* 記録の失敗で本来の応答を止めない */ }
}

/** globalThis.fetch を1回だけ包む（instrumentation.ts から。Vercel ではレスポンス後も waitUntil で記録を書き終える） */
export async function installLlmUsageRecorder(): Promise<boolean> {
  const g = globalThis as unknown as { fetch: FetchLike & Record<PropertyKey, unknown> };
  if (typeof g.fetch !== "function" || g.fetch[INSTALLED]) return false;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (process.env.LLM_USAGE_RECORD === "off" || !url || !key) {
    installWrapped(g, g.fetch, wrapFetchStripSumoraMarks(g.fetch.bind(globalThis)));
    return false;
  }

  const { createClient } = await import("@supabase/supabase-js");
  const { waitUntil } = await import("@vercel/functions");
  const db = createClient(url, key, { auth: { persistSession: false } });
  type WorkStore = { getStore(): { route?: string } | undefined };
  let workStore: WorkStore | null = null;
  try {
    // Next がリクエストごとに持つ作業情報（route = "/api/generate-reply" 等）。after() の中でも同じリクエストの物が見える
    const mod = await import("next/dist/server/app-render/work-async-storage.external");
    workStore = (mod as unknown as { workAsyncStorage?: WorkStore }).workAsyncStorage ?? null;
  } catch { workStore = null; }

  let warned = false;
  const original = g.fetch;
  const deps = {
    insert: async (row: LlmUsageRow) => {
      const { error } = await db.from("llm_usage_logs").insert(row);
      if (error && !warned) { warned = true; console.warn("[llm-usage-recorder] insert failed:", error.message); }
    },
    keepAlive: (p: Promise<unknown>) => { try { waitUntil(p); } catch { /* Vercel 以外 */ } },
    route: () => workStore?.getStore()?.route ?? null,
    env: process.env.VERCEL_ENV ?? "local",
  };
  // 別クラウド（DeepSeek）に回った呼び出しも同じ口から書く（llm-alt-provider が recordAltUsage を呼ぶ）
  altRecorder = deps;
  const wrapped = wrapFetchWithLlmUsageRecorder(original.bind(globalThis), deps);
  installWrapped(g, original, wrapped);
  return true;
}
