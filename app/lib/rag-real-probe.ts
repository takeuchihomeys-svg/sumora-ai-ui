// app/lib/rag-real-probe.ts — 毎朝の RAG の見張りに「本番に近い問い」で関数を実際に呼んで測る段を足す（2026-11-20 作業員H・統括役の決め）
//
// なぜ: 11/18 夜の測り（88〜195ms）は表の中の行の埋め込みを問いにした＝本番と違う問いで測っていた。
//   11/20 夜に本番の問い（embedding_cache の最近の行＝お客様の文・generate-reply の「proposing: …」）で測り直すと、
//   手本の2つ（match_reply_examples・match_aix_reply_examples）は HNSW を使わず表を全部読む Seq Scan（約1.6万ブロック・2.5〜2.9秒・本番の昼は8秒の打ち切り）。
//   → 「夜の測りが本番と違った」をくり返さないため、毎朝 embedding_cache の最近の問いで3つの関数を本番と同じ引数で呼び、時間と件数を残す。
//   止める: RAG_REAL_PROBE=off（毎朝の rag-watch-daily の中・読むだけ・LLM なし）
export const RAG_REAL_PROBE_SLOW_MS = 3000;
export type RealProbeCall = { rpc: string; args: Record<string, unknown> };
export type RealProbeResult = { rpc: string; query: string; ms: number; rows: number | null; error: string | null };

export function ragRealProbeOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.RAG_REAL_PROBE ?? "").trim().toLowerCase() !== "off";
}

/** 本番と同じ呼び方（generate-reply・aix-template-generate・aix/action の実際の引数） */
export function realProbeCalls(embedding: number[]): RealProbeCall[] {
  return [
    { rpc: "match_reply_examples", args: { query_embedding: embedding, match_count: 24, filter_states: ["proposing", "hearing"] } },
    { rpc: "match_aix_reply_examples", args: { query_embedding: embedding, match_count: 15, filter_action: "property_check_result" } },
    { rpc: "match_reply_knowledge", args: { query_embedding: embedding, match_count: 40, min_importance: 7 } },
  ];
}

/** embedding_cache の行（JSONB の配列）を問いにできるか */
export function probeEmbeddingOf(v: unknown): number[] | null {
  return Array.isArray(v) && v.length === 1536 && v.every((x) => typeof x === "number") ? (v as number[]) : null;
}

/** 拾い上げ: 関数ごとの中央値が遅い・失敗・0件 */
export function realProbeFindings(rs: ReadonlyArray<RealProbeResult>, slowMs = RAG_REAL_PROBE_SLOW_MS): Array<{ rpc: string; kind: "real_slow" | "real_error" | "real_empty"; detail: string }> {
  const by = new Map<string, RealProbeResult[]>();
  for (const r of rs) by.set(r.rpc, [...(by.get(r.rpc) ?? []), r]);
  const out: Array<{ rpc: string; kind: "real_slow" | "real_error" | "real_empty"; detail: string }> = [];
  for (const [rpc, a] of by) {
    const errs = a.filter((x) => x.error);
    if (errs.length) out.push({ rpc, kind: "real_error", detail: `${errs.length}/${a.length}回 失敗（${String(errs[0].error).slice(0, 80)}）` });
    const ok = a.filter((x) => !x.error);
    if (!ok.length) continue;
    const ms = ok.map((x) => x.ms).sort((p, q) => p - q);
    const med = ms[Math.floor((ms.length - 1) / 2)];
    if (med > slowMs) out.push({ rpc, kind: "real_slow", detail: `本番に近い問いで中央値 ${med}ms（${ok.length}回・最大 ${ms[ms.length - 1]}ms）` });
    if (ok.every((x) => (x.rows ?? 0) === 0)) out.push({ rpc, kind: "real_empty", detail: `本番に近い問いで ${ok.length}回とも0件` });
  }
  return out;
}

type Sb = {
  from(t: string): { select(c: string): { order(c: string, o: { ascending: boolean }): { limit(n: number): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> } } };
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};
/** 最近の問い n 個で3つの関数を順に呼ぶ（並べない＝DB に重ねない） */
export async function runRealProbe(sb: Sb, n = 3): Promise<RealProbeResult[]> {
  const { data, error } = await sb.from("embedding_cache").select("text_key, embedding").order("created_at", { ascending: false }).limit(20);
  if (error) throw new Error(error.message);
  const qs = ((data ?? []) as Array<{ text_key: string; embedding: unknown }>).map((r) => ({ key: String(r.text_key ?? "").slice(0, 24), emb: probeEmbeddingOf(r.embedding) }))
    .filter((r): r is { key: string; emb: number[] } => !!r.emb).slice(0, n);
  const out: RealProbeResult[] = [];
  for (const q of qs) for (const c of realProbeCalls(q.emb)) {
    const t0 = Date.now();
    try {
      const r = await sb.rpc(c.rpc, c.args);
      out.push({ rpc: c.rpc, query: q.key, ms: Date.now() - t0, rows: Array.isArray(r.data) ? r.data.length : null, error: r.error ? r.error.message : null });
    } catch (e) {
      out.push({ rpc: c.rpc, query: q.key, ms: Date.now() - t0, rows: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
