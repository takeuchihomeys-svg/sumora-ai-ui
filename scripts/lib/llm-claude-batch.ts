// scripts/lib/llm-claude-batch.ts — 試験の Claude の呼び出しを Message Batches API（半額）に回す（夜・予約の回だけ）
//
// 2026-10-21 竹内さん「試験の次の節約（質は落とさない）」③: 夜の安い時間・Claude の部分はまとめて頼む（Batch・半額）。
//   試験（LLM_TEST_FINAL_CLAUDE の最後の確かめ等）で Claude の /v1/messages に行く呼び出しを、その場で Message Batches に出し、
//   終わるまで待って答えを返す（呼んだ側には普通の答えに見える。stream の要求は答えを SSE の形に組み直して返す）。
//   同じ時に出た要求（読み手を並べて呼ぶ等）は1つのバッチにまとめる（既定 1.5秒の窓）。
//   待ちの上限（既定 20分）を超えた・失敗した・バッチに出せない要求（fallbacks 等）は今までどおり直に呼ぶ（止めない）。
// いつ入るか（EXAM_CLAUDE_BATCH）:
//   auto（既定）… Claude を使う試験（LLM_TEST_FINAL_CLAUDE）で、予約の回（EXAM_FROM_QUEUE=1）か夜（JST 1:30〜9:30）の時だけ
//   on … いつでも（Claude に行く物は全部）／off … 入れない
// 置く場所: 共通の入口（llm-test-harness）の一番内側（別クラウド・使用量の記録・録音より内）＝録音・使用量の記録は今までどおり答えを見る。
//   使用量の記録は普通の単価で数える（バッチは実際はその半額）。
// 設定: EXAM_CLAUDE_BATCH_WINDOW_MS（まとめる窓・1500）／EXAM_CLAUDE_BATCH_POLL_MS（見に行く間・15000）／EXAM_CLAUDE_BATCH_TIMEOUT_MIN（待ちの上限・20）
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type BatchMode = "auto" | "on" | "off";
export function readBatchMode(env: Record<string, string | undefined>): BatchMode {
  const v = String(env.EXAM_CLAUDE_BATCH ?? "").trim().toLowerCase();
  return v === "on" || v === "off" ? v : "auto";
}
/** JST 1:30〜9:30（試験の夜の窓） */
export function isNightJst(d: Date): boolean { const j = new Date(d.getTime() + 9 * 3600_000); const m = j.getUTCHours() * 60 + j.getUTCMinutes(); return m >= 90 && m < 570; }
/** この回で入れるか */
export function batchActive(env: Record<string, string | undefined>, now = new Date()): boolean {
  const m = readBatchMode(env);
  if (m === "off") return false;
  if (m === "on") return true;
  const claude = /^(1|true|on|yes)$/i.test(String(env.LLM_TEST_FINAL_CLAUDE ?? "").trim());
  return claude && (String(env.EXAM_FROM_QUEUE ?? "").trim() === "1" || isNightJst(now));
}

/** バッチに出せる要求か（Messages の本体・バッチで断られる物は出さない） */
export function batchable(u: URL, method: string, body: Record<string, unknown> | null, headers: Headers): boolean {
  if (method !== "POST" || !/(^|\.)api\.anthropic\.com$/.test(u.hostname) || u.pathname !== "/v1/messages" || !body) return false;
  if ("fallbacks" in body || "speed" in body) return false; // バッチでは断られる
  if (/server-side-fallback|fast-mode/.test(headers.get("anthropic-beta") ?? "")) return false;
  return true;
}

type Msg = { id?: string; type?: string; role?: string; model?: string; content?: Array<Record<string, unknown>>; stop_reason?: string | null; stop_sequence?: string | null; usage?: Record<string, unknown> };
/** バッチの答え（message）を stream の SSE の形に組み直す（SDK の finalMessage が同じ物を組み立てられる形） */
export function messageToSse(m: Msg): string {
  const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const usage = m.usage ?? {};
  let out = ev("message_start", { message: { ...m, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } });
  (m.content ?? []).forEach((b, index) => {
    const t = String(b.type ?? "");
    if (t === "text") {
      out += ev("content_block_start", { index, content_block: { ...b, text: "" } });
      out += ev("content_block_delta", { index, delta: { type: "text_delta", text: String(b.text ?? "") } });
    } else if (t === "thinking") {
      out += ev("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } });
      if (b.thinking) out += ev("content_block_delta", { index, delta: { type: "thinking_delta", thinking: String(b.thinking) } });
      if (b.signature) out += ev("content_block_delta", { index, delta: { type: "signature_delta", signature: String(b.signature) } });
    } else if (t === "tool_use" || t === "server_tool_use") {
      out += ev("content_block_start", { index, content_block: { ...b, input: {} } });
      out += ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input ?? {}) } });
    } else {
      out += ev("content_block_start", { index, content_block: b });
    }
    out += ev("content_block_stop", { index });
  });
  out += ev("message_delta", { delta: { stop_reason: m.stop_reason ?? null, stop_sequence: m.stop_sequence ?? null }, usage });
  out += ev("message_stop", {});
  return out;
}

type Pending = { id: string; params: Record<string, unknown>; stream: boolean; headers: Headers; resolve: (r: Response | null) => void };
export type BatchStats = { batches: number; requests: number; ok: number; fallback: number; waitedMs: number };

/** 包みを作る（純粋に inner を包む・テストで使う）。inner はバッチの API にも直の呼び出しにも使う */
export function makeClaudeBatchFetch(inner: FetchLike, o: { env?: Record<string, string | undefined>; stats?: BatchStats; log?: (s: string) => void; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): FetchLike {
  const env = o.env ?? process.env;
  const log = o.log ?? ((s: string) => console.log(s));
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? (() => Date.now());
  const stats = o.stats ?? { batches: 0, requests: 0, ok: 0, fallback: 0, waitedMs: 0 };
  const windowMs = Math.max(0, Number(env.EXAM_CLAUDE_BATCH_WINDOW_MS ?? 1500) || 0);
  const pollMs = Math.max(200, Number(env.EXAM_CLAUDE_BATCH_POLL_MS ?? 15000) || 15000);
  const timeoutMs = Math.max(1, Number(env.EXAM_CLAUDE_BATCH_TIMEOUT_MIN ?? 20) || 20) * 60_000;
  let queue: Pending[] = [];
  let timer: Promise<void> | null = null;
  let seq = 0;
  const authHeaders = (h: Headers) => { const out = new Headers(); for (const k of ["x-api-key", "authorization", "anthropic-version", "anthropic-beta"]) { const v = h.get(k); if (v) out.set(k, v); } if (!out.get("anthropic-version")) out.set("anthropic-version", "2023-06-01"); out.set("content-type", "application/json"); return out; };
  const flush = async () => {
    const items = queue; queue = []; timer = null;
    if (!items.length) return;
    // 同じ鍵・同じ beta の物だけ1つのバッチに（違えば分ける）
    const groups = new Map<string, Pending[]>();
    for (const it of items) { const k = `${it.headers.get("x-api-key") ?? it.headers.get("authorization") ?? ""}|${it.headers.get("anthropic-beta") ?? ""}`; groups.set(k, [...(groups.get(k) ?? []), it]); }
    await Promise.all([...groups.values()].map((g) => runBatch(g)));
  };
  const runBatch = async (g: Pending[]) => {
    const h = authHeaders(g[0].headers);
    const t0 = now();
    const fail = (why: string) => { log(`[claude-batch] 直に呼ぶ（${why}）`); for (const it of g) { stats.fallback++; it.resolve(null); } };
    let id = "";
    try {
      const r = await inner("https://api.anthropic.com/v1/messages/batches", { method: "POST", headers: h, body: JSON.stringify({ requests: g.map((it) => ({ custom_id: it.id, params: it.params })) }) });
      if (!r.ok) return fail(`バッチを出せない ${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}`);
      id = String(((await r.json()) as { id?: string }).id ?? "");
      if (!id) return fail("バッチの id が無い");
      stats.batches++; stats.requests += g.length;
      log(`[claude-batch] ${g.length}件をバッチ ${id} に出した（半額・終わるまで待つ）`);
      let resultsUrl = "";
      while (true) {
        await sleep(pollMs);
        const s = await inner(`https://api.anthropic.com/v1/messages/batches/${id}`, { method: "GET", headers: h });
        if (s.ok) { const j = (await s.json()) as { processing_status?: string; results_url?: string | null }; if (j.processing_status === "ended") { resultsUrl = String(j.results_url ?? ""); break; } }
        if (now() - t0 > timeoutMs) { try { await inner(`https://api.anthropic.com/v1/messages/batches/${id}/cancel`, { method: "POST", headers: h }); } catch { /* */ } return fail(`待ちの上限 ${Math.round(timeoutMs / 60000)}分`); }
      }
      const rr = await inner(resultsUrl || `https://api.anthropic.com/v1/messages/batches/${id}/results`, { method: "GET", headers: h });
      if (!rr.ok) return fail(`結果を読めない ${rr.status}`);
      const byId = new Map<string, { type?: string; message?: Msg }>();
      for (const line of (await rr.text()).split("\n")) { if (!line.trim()) continue; try { const x = JSON.parse(line) as { custom_id?: string; result?: { type?: string; message?: Msg } }; if (x.custom_id) byId.set(x.custom_id, x.result ?? {}); } catch { /* */ } }
      stats.waitedMs += now() - t0;
      for (const it of g) {
        const res = byId.get(it.id);
        if (res?.type !== "succeeded" || !res.message) { stats.fallback++; log(`[claude-batch] ${it.id}: ${res?.type ?? "結果なし"} → 直に呼ぶ`); it.resolve(null); continue; }
        stats.ok++;
        it.resolve(it.stream
          ? new Response(messageToSse(res.message), { status: 200, headers: { "content-type": "text/event-stream", "x-claude-batch": id } })
          : new Response(JSON.stringify(res.message), { status: 200, headers: { "content-type": "application/json", "x-claude-batch": id } }));
      }
    } catch (e) { fail(`失敗 ${e instanceof Error ? e.message : String(e)}`.slice(0, 160)); }
  };
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let u: URL | null = null;
    try { u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url); } catch { return inner(input, init); }
    const method = (init?.method ?? (typeof input === "object" && input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (typeof input === "object" && input instanceof Request ? input.headers : undefined));
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") { try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { body = null; } }
    if (!batchable(u, method, body, headers)) return inner(input, init);
    const { stream, ...params } = body!;
    const got = await new Promise<Response | null>((resolve) => {
      queue.push({ id: `r${++seq}`, params, stream: !!stream, headers, resolve });
      if (!timer) timer = sleep(windowMs).then(flush);
    });
    return got ?? inner(input, init);
  };
}

/** 共通の入口が一番内側に入れる（入らない回は何もしない）。入れたら数えを返す */
export function installClaudeBatch(env: Record<string, string | undefined> = process.env): BatchStats | null {
  if (!batchActive(env)) return null;
  const stats: BatchStats = { batches: 0, requests: 0, ok: 0, fallback: 0, waitedMs: 0 };
  const prev = globalThis.fetch as unknown as FetchLike;
  globalThis.fetch = makeClaudeBatchFetch(prev, { env, stats }) as unknown as typeof fetch;
  console.log(`[claude-batch] Claude の呼び出しを Message Batches（半額）に回す（${readBatchMode(env) === "on" ? "EXAM_CLAUDE_BATCH=on" : "夜・予約の回"}・待ちの上限 ${Number(env.EXAM_CLAUDE_BATCH_TIMEOUT_MIN ?? 20) || 20}分を超えたら直に呼ぶ）`);
  return stats;
}
