// app/lib/reply-quality-weekly.ts — 返信の番だけの文の質の週ごとの物差し（純関数・LLM なし）
//
// 2026-11-07 作業員9（統括役・竹内さん「文の質はどれくらい上がっているか」）:
//   竹内さん本人の送信で下書きがあった番（ai_reply_examples）の近さ（ai_similarity）を週ごとに数える。
//   送った通が AIX（messages.is_aix_generated）の番は除く＝返信の番だけ（AIX の番はスタッフだけが知る事を送る番で、下書きと比べる物ではない）。
//   0.6 未満の外れを2つに分ける（簡単な線）:
//     ブレイン＝下書きと送信のどちらか片方だけが「確認／ピックアップ／御見積書の作成」の約束をしている（返信の向きが違う）
//     書き手＝それ以外（向きは同じで言い方が違う）
//   毎週の振り返り・毎朝の拾い上げから scripts/reply-quality-weekly.ts で出す。

export const LOW_SIM = 0.6;
const DRAFT_PROMISE_RE = /確認(?:出来|でき)次第|確認させて頂きます|ピックアップ(?:し|させて)|御見積書を作成/;
const SENT_PROMISE_RE = /確認(?:出来|でき)次第|確認させて頂きます|確認させていただきます|ピックアップ(?:し|させて)|御見積書を作成/;

export type QualityRow = { sentAt: string; similarity: number; draft: string; sent: string; writer: string | null; aix: boolean | null };
export type WeekStat = { week: string; n: number; avg: number | null; lowPct: number | null; lowBrain: number; lowWriter: number };

/** JST の月曜始まりの週（YYYY-MM-DD） */
export function jstWeekOf(iso: string): string {
  const t = Date.parse(iso) + 9 * 3600_000;
  const d = new Date(t);
  const dow = (d.getUTCDay() + 6) % 7; // 月=0
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
  return monday.toISOString().slice(0, 10);
}

/** 0.6 未満の外れの型（返信の番だけ） */
export function lowKindOf(r: Pick<QualityRow, "draft" | "sent">): "brain" | "writer" {
  return DRAFT_PROMISE_RE.test(r.draft) !== SENT_PROMISE_RE.test(r.sent) ? "brain" : "writer";
}

/** 週ごとに数える。writer は "takeuchi" だけ・AIX の番は除く */
export function weeklyReplyQuality(rows: ReadonlyArray<QualityRow>, writer = "takeuchi"): WeekStat[] {
  const by = new Map<string, QualityRow[]>();
  for (const r of rows) {
    if (r.writer !== writer || r.aix === true) continue;
    if (!r.draft?.trim() || !r.sent?.trim() || !Number.isFinite(r.similarity)) continue;
    const w = jstWeekOf(r.sentAt);
    (by.get(w) ?? by.set(w, []).get(w)!).push(r);
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, rs]) => {
    const low = rs.filter((r) => r.similarity < LOW_SIM);
    return {
      week, n: rs.length,
      avg: rs.length ? Math.round((rs.reduce((s, r) => s + r.similarity, 0) / rs.length) * 1000) / 1000 : null,
      lowPct: rs.length ? Math.round((1000 * low.length) / rs.length) / 10 : null,
      lowBrain: low.filter((r) => lowKindOf(r) === "brain").length,
      lowWriter: low.filter((r) => lowKindOf(r) === "writer").length,
    };
  });
}

/** 送信に一番近いスタッフの通（前後3分）を選ぶ */
export function nearestStaffMessage<T extends { created_at: string }>(sentAt: string, cands: ReadonlyArray<T>, windowMs = 3 * 60_000): T | null {
  const t = Date.parse(sentAt);
  let best: T | null = null, bd = Infinity;
  for (const c of cands) {
    const d = Math.abs(Date.parse(c.created_at) - t);
    if (d <= windowMs && d < bd) { best = c; bd = d; }
  }
  return best;
}

export function weeklyTable(stats: ReadonlyArray<WeekStat>): string {
  const head = "| 週（JST・月曜始まり） | 通数 | 近さの平均 | 0.6未満 | うちブレイン | うち書き手 |\n|---|---|---|---|---|---|";
  return [head, ...stats.map((s) => `| ${s.week} | ${s.n} | ${s.avg ?? "-"} | ${s.lowPct ?? "-"}% | ${s.lowBrain} | ${s.lowWriter} |`)].join("\n");
}
