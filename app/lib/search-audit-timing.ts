// app/lib/search-audit-timing.ts（純関数・依存なし）
// 検索の点検の1回（search_audits の1行）から「操作ごとの時刻」を読みやすい並びにする。
//
// 2026-09-27 竹内「2000回試すなど危ないやり方なのでやらない（リアプロの運営）もっと人間が試した形で試す」:
//   待ち時間が人のようにばらついているかは、関数を大量に呼んだ分布ではなく、本物の検索1回の記録で読む。
//   材料（拡張 v2.5.31 から）:
//     steps          … 段（background の begin/fill_done/result・ページの "page:*"・bulk-dl の "dl:*"）。at は時刻（ms）
//     filled.ops     … クリックの列の1件ごと {t: 入力を始めてからの ms, k: 何を, p: 予定の間, w: 実際の間}
//     filled.stall   … 見張りで止まった時の様子
//   並びは時刻の順（段は届いた順に積まれるので、ページの段は fill_done の後ろに来る）。

export type TimingStep = { at?: number | string | null; k: string; d?: string | null };
export type TimingOp = { t: number; k: string; p: number; w: number };

export type TimelineRow = { at: number; sinceBeginMs: number; gapMs: number | null; k: string; d: string | null };
export type OpsSummary = {
  count: number;
  /** 実際の間（ms）の最小・最大・通り数（同じ間が続いていないか） */
  waitMin: number | null; waitMax: number | null; distinctWaits: number;
  /** 予定より遅れた最大（ms）と 1秒超の回数（タブが隠れている時のタイマーの間引き等） */
  lateMax: number | null; lateOver1s: number;
};

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) { const n = Date.parse(v); if (Number.isFinite(n)) return n; const m = Number(v); if (Number.isFinite(m)) return m; }
  return null;
}

/** 段を時刻の順に並べ、始まり（begin）からの経過と前の段との間を付ける */
export function auditTimeline(steps: ReadonlyArray<TimingStep> | null | undefined): TimelineRow[] {
  const xs = (steps ?? []).map((s, i) => ({ at: num(s.at), k: String(s.k ?? ""), d: s.d == null ? null : String(s.d), i }))
    .filter((s): s is { at: number; k: string; d: string | null; i: number } => s.at != null && !!s.k)
    .sort((a, b) => a.at - b.at || a.i - b.i);
  if (!xs.length) return [];
  const begin = xs.find((s) => s.k === "begin")?.at ?? xs[0].at;
  return xs.map((s, j) => ({ at: s.at, sinceBeginMs: s.at - begin, gapMs: j === 0 ? null : s.at - xs[j - 1].at, k: s.k, d: s.d }));
}

/** クリックの列の記録をまとめる */
export function summarizeOps(ops: ReadonlyArray<TimingOp> | null | undefined): OpsSummary {
  const xs = (ops ?? []).filter((o) => o && Number.isFinite(o.w) && Number.isFinite(o.p));
  if (!xs.length) return { count: 0, waitMin: null, waitMax: null, distinctWaits: 0, lateMax: null, lateOver1s: 0 };
  const waits = xs.map((o) => o.w);
  const lates = xs.map((o) => o.w - o.p);
  return {
    count: xs.length,
    waitMin: Math.min(...waits), waitMax: Math.max(...waits), distinctWaits: new Set(waits).size,
    lateMax: Math.max(...lates), lateOver1s: lates.filter((l) => l > 1000).length,
  };
}

/** 人の間を置く段の間（並び替えの前・ページの間・資料の送信の束の間）だけを抜き出す（名前 → 間の ms の並び） */
export function humanGaps(rows: ReadonlyArray<TimelineRow>): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  const push = (k: string, v: number) => { (out[k] ??= []).push(v); };
  for (let j = 0; j < rows.length; j++) {
    const r = rows[j];
    if (r.k === "dl:sort_wait" && r.d && Number.isFinite(Number(r.d))) push("並び替えの前（予定）", Number(r.d));
    if (r.k === "dl:sort_go") { const w = rows.slice(0, j).reverse().find((x) => x.k === "dl:sort_wait"); if (w) push("並び替えの前（実際）", r.at - w.at); }
    if (r.k === "dl:send") { const prev = rows.slice(0, j).reverse().find((x) => x.k === "dl:sent" || x.k === "dl:page"); if (prev) push(prev.k === "dl:sent" ? "資料の束の間" : "ページ → 最初の束", r.at - prev.at); }
    if (r.k === "dl:sent") { const s = rows.slice(0, j).reverse().find((x) => x.k === "dl:send"); if (s) push("資料の束の送信（往復）", r.at - s.at); }
    if (r.k === "dl:next") { const s = rows.slice(0, j).reverse().find((x) => x.k === "dl:sent"); if (s) push("最後の束 → 次のページ", r.at - s.at); }
    if (r.k === "dl:page") { const s = rows.slice(0, j).reverse().find((x) => x.k === "dl:next"); if (s) push("次のページへ → 読み込み", r.at - s.at); }
    if (r.k === "page:search") { const s = rows.slice(0, j).reverse().find((x) => x.k === "page:fill_start"); if (s) push("入力の始め → 検索を押す", r.at - s.at); }
  }
  return out;
}
