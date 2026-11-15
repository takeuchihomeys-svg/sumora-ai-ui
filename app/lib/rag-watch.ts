// app/lib/rag-watch.ts — RAG（Supabase の match_* の RPC）ごとの見張り（純関数＋fetch の包み・LLM なし）
//
// 2026-11-15 作業員H（竹内さん 11/15「RAG もブレインと AIX-META と連携した精度の高い RAG か・統括ちゃんとできているか」・KB P0 3041baaa・統括役の頼み 土台①）:
//   11/15 まで match_takeuchi_compose は search_path の誤りで毎回0件だったのに、誰も気づけなかった（呼び出し元は 0件を「手本なし」として静かに進む）。
//   RAG の呼び出し元は 13 か所以上に散っている（match_reply_knowledge だけで 13）＝呼び出し元ごとに数えを足すと漏れる。
//   → llm_usage_logs と同じく、出口（globalThis.fetch）で PostgREST の /rest/v1/rpc/match_* を1回ずつ見て、
//     呼ばれた・0件・失敗・一番近い手本の近さ・かかった時間・どの入口（route）からを rag_call_logs に1行残す。
//   毎朝の拾い上げ（app/api/cron/rag-watch-daily）が「0件・失敗が続く RAG」を出す（ragWatchFindings）。
//   本文（問いの文・手本の中身）は残さない＝個人情報を書かない。残すのは数と RPC の名前と引数の名前だけ。
//   切替: 11/15 から既定 on（RAG_WATCH=off で包まない）。記録の失敗で本来の応答は止めない。
// テスト: app/lib/__tests__/rag-watch.test.ts

export type RagCallRow = {
  rpc: string;
  route: string | null;
  status: number;          // HTTP の状態（0 = 投げた・時間切れ）
  ok: boolean;
  rows: number | null;     // 返った件数（失敗は null）
  top_sim: number | null;  // 一番近い手本の近さ（similarity / score / sim の最大）
  ms: number;
  match_count: number | null; // 頼んだ件数（引数の match_count / k / limit）
  arg_keys: string[];      // 引数の名前（値は残さない）
  error: string | null;    // 失敗の短い文（120字まで・本文は含まない）
  env: string | null;
};

type Env = Record<string, string | undefined>;
export function ragWatchOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.RAG_WATCH ?? "").trim().toLowerCase() !== "off"; // 11/15 統括役の決め: 表を当てて1行書けるのを確かめた（rag_call_logs_20261115）・既定 on（止める RAG_WATCH=off）
}

/** PostgREST の RPC の URL から名前（match_ で始まる物だけ） */
export function ragRpcName(url: URL | null): string | null {
  if (!url) return null;
  const m = url.pathname.match(/\/rest\/v1\/rpc\/(match_[a-z0-9_]+)\/?$/i);
  return m ? m[1] : null;
}

const SIM_KEYS = ["similarity", "score", "sim", "final_score", "cosine"];
/** 返った行から一番近い手本の近さ（数の欄が無ければ null） */
export function topSimilarity(rows: unknown): number | null {
  if (!Array.isArray(rows)) return null;
  let best: number | null = null;
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    let v: number | null = null;
    for (const k of SIM_KEYS) {
      const x = (r as Record<string, unknown>)[k];
      if (typeof x === "number" && Number.isFinite(x)) { v = x; break; }
    }
    // match_conductor_turns 等は距離（distance・cosine の <=>）を返す＝近さは 1 − 距離
    const d = (r as Record<string, unknown>).distance;
    if (v === null && typeof d === "number" && Number.isFinite(d)) v = 1 - d;
    if (v !== null) best = best === null ? v : Math.max(best, v);
  }
  return best === null ? null : Math.round(best * 1000) / 1000;
}

/** 引数（本文の JSON）から頼んだ件数と引数の名前（値は残さない） */
export function ragArgsMeta(body: unknown): { match_count: number | null; arg_keys: string[] } {
  let o: unknown = body;
  if (typeof body === "string") { try { o = JSON.parse(body); } catch { o = null; } }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { match_count: null, arg_keys: [] };
  const rec = o as Record<string, unknown>;
  const n = [rec.match_count, rec.k, rec.limit_count, rec.match_limit].find((v) => typeof v === "number");
  return { match_count: typeof n === "number" ? n : null, arg_keys: Object.keys(rec).sort().slice(0, 20) };
}

/** 1回の呼び出しを1行に（純関数） */
export function buildRagRow(i: { rpc: string; route: string | null; status: number; json: unknown; ms: number; body: unknown; error?: string | null; env?: string | null }): RagCallRow {
  const ok = i.status >= 200 && i.status < 300 && !i.error;
  const rows = ok ? (Array.isArray(i.json) ? i.json.length : i.json == null ? 0 : 1) : null;
  const meta = ragArgsMeta(i.body);
  let err: string | null = i.error ?? null;
  if (!ok && !err && i.json && typeof i.json === "object") {
    const j = i.json as Record<string, unknown>;
    err = [j.code, j.message].filter((x) => typeof x === "string").join(" ") || null;
  }
  return { rpc: i.rpc, route: i.route, status: i.status, ok, rows, top_sim: ok ? topSimilarity(i.json) : null, ms: Math.max(0, Math.round(i.ms)),
    match_count: meta.match_count, arg_keys: meta.arg_keys, error: err ? err.slice(0, 120) : null, env: i.env ?? null };
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
function urlOf(input: RequestInfo | URL): URL | null {
  try { return input instanceof URL ? input : new URL(typeof input === "string" ? input : (input as Request).url); } catch { return null; }
}
/** fetch を包む: match_* の RPC だけ見て row を insert に渡す（応答はそのまま返す・数えは複製で読む） */
export function wrapFetchWithRagWatch(original: FetchLike, deps: { insert: (r: RagCallRow) => Promise<void>; keepAlive: (p: Promise<unknown>) => void; route: () => string | null; env: string | null; now?: () => number }): FetchLike {
  const now = deps.now ?? Date.now;
  return async (input, init) => {
    const rpc = ragRpcName(urlOf(input));
    if (!rpc) return original(input, init);
    const t0 = now();
    let route: string | null = null;
    try { route = deps.route(); } catch { route = null; }
    const body = init?.body;
    try {
      const res = await original(input, init);
      const ms = now() - t0;
      const copy = res.clone();
      deps.keepAlive((async () => {
        let json: unknown = null;
        try { json = await copy.json(); } catch { json = null; }
        await deps.insert(buildRagRow({ rpc, route, status: res.status, json, ms, body, env: deps.env }));
      })().catch(() => {}));
      return res;
    } catch (e) {
      const ms = now() - t0;
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      deps.keepAlive(deps.insert(buildRagRow({ rpc, route, status: 0, json: null, ms, body, error: msg, env: deps.env })).catch(() => {}));
      throw e;
    }
  };
}

// ── 毎朝の拾い上げ（純関数）──────────────────────────────────────────
export type RagStat = { rpc: string; calls: number; empty: number; failed: number; slow: number; p50Sim: number | null; p50Ms: number | null; routes: string[] };
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
/** 行を RPC ごとに数える（slow = 3秒以上） */
export function ragWatchStats(rows: ReadonlyArray<Pick<RagCallRow, "rpc" | "ok" | "rows" | "top_sim" | "ms" | "route">>): RagStat[] {
  const by = new Map<string, Array<(typeof rows)[number]>>();
  for (const r of rows) { const a = by.get(r.rpc) ?? []; a.push(r); by.set(r.rpc, a); }
  return [...by.entries()].map(([rpc, a]) => ({
    rpc, calls: a.length, empty: a.filter((r) => r.ok && (r.rows ?? 0) === 0).length, failed: a.filter((r) => !r.ok).length, slow: a.filter((r) => r.ms >= 3000).length,
    p50Sim: median(a.map((r) => r.top_sim).filter((x): x is number => typeof x === "number")), p50Ms: median(a.map((r) => r.ms)),
    routes: [...new Set(a.map((r) => r.route ?? "?"))].slice(0, 8),
  })).sort((x, y) => y.calls - x.calls);
}
export type RagFinding = { rpc: string; kind: "always_empty" | "mostly_empty" | "failing" | "slow" | "silent"; why: string };
/**
 * 拾い上げの決まり（数だけ）:
 *   always_empty: 5回以上呼ばれて全部0件（11/15 の match_takeuchi_compose の形）
 *   mostly_empty: 10回以上で0件が8割以上
 *   failing: 失敗が2割以上（3回以上）
 *   slow: 3秒以上が2割以上（3回以上）・時間切れの手前（match_conductor_focus の nop9o-1）
 *   silent: 前の日は呼ばれていたのに今日は0回（呼び出し元が止まった・スイッチが外れた）
 */
export function ragWatchFindings(today: RagStat[], prevCalls: Record<string, number> = {}): RagFinding[] {
  const out: RagFinding[] = [];
  for (const s of today) {
    if (s.calls >= 5 && s.empty === s.calls) out.push({ rpc: s.rpc, kind: "always_empty", why: `${s.calls}回とも0件（壊れて空を返している疑い・search_path・索引・引数の名前）` });
    else if (s.calls >= 10 && s.empty / s.calls >= 0.8) out.push({ rpc: s.rpc, kind: "mostly_empty", why: `${s.calls}回中 ${s.empty}回が0件` });
    if (s.failed >= 3 && s.failed / s.calls >= 0.2) out.push({ rpc: s.rpc, kind: "failing", why: `${s.calls}回中 ${s.failed}回が失敗` });
    if (s.slow >= 3 && s.slow / s.calls >= 0.2) out.push({ rpc: s.rpc, kind: "slow", why: `${s.calls}回中 ${s.slow}回が3秒以上（中央 ${s.p50Ms}ms）` });
  }
  const seen = new Set(today.map((s) => s.rpc));
  for (const [rpc, n] of Object.entries(prevCalls)) if (n >= 5 && !seen.has(rpc)) out.push({ rpc, kind: "silent", why: `前の日は ${n}回呼ばれたのに今日は0回` });
  return out;
}
