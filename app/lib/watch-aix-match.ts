// app/lib/watch-aix-match.ts — 見張り（line_watch_turns）の「ブレインが出した AIX をスタッフが押したか」の一致率（純関数・LLM なし）
//   2026-10-08 竹内さんの決定⑥: 自動返信化の関所（cron/auto-reply-readiness）は成約の勝ち率でなく見張りの一致率で見る。
//   数えるのは aix_verdict が same（同じ AIX）／other（別の AIX）／not_pressed（押さなかった）の番だけ。
//   unexpected（AI は AIX なし・スタッフは押した）と判定前（null）はこの AIX の分母に入れない。
export const WATCH_MATCH_MIN = 0.5;
export const WATCH_MATCH_MIN_N = 5;

//   2026-10-08: 過去の番の埋め戻し（verdict_detail.backfill・line-watch-backfill.ts）は関所に入れない（今の控えだけで見る）。backfill を読んだ行だけ外す
export type WatchAixRow = { brain_action: string | null; aix_verdict: string | null; backfill?: string | null };
export function watchAixMatchRates(rows: ReadonlyArray<WatchAixRow>): Record<string, { same: number; n: number; rate: number }> {
  const out: Record<string, { same: number; n: number; rate: number }> = {};
  for (const r of rows) {
    if (r.backfill) continue;
    const a = (r.brain_action ?? "").trim();
    const v = (r.aix_verdict ?? "").trim();
    if (!a || !["same", "other", "not_pressed"].includes(v)) continue;
    const x = (out[a] ??= { same: 0, n: 0, rate: 0 });
    x.n++; if (v === "same") x.same++;
  }
  for (const x of Object.values(out)) x.rate = x.n ? Math.round((x.same / x.n) * 1000) / 1000 : 0;
  return out;
}
