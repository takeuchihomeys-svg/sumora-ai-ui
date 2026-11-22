// app/lib/quality-daily-server.ts — 見張りの判定が付いた時に、その日の返信の一致を quality_daily に足し直す（軽い読み・LLM なし・作業員N・2026-11-21・台帳 #473）
//
// 竹内さん 11/21「次の朝ではなく、そのまま連携することはできないのか」（統括役の頼み）。
//   line-watch-eval（毎日 JST 20:40）が判定を書いた後に、判定が動いた日（直近 days 日）の reply_match（竹内さんの番・全体）を数え直して入れ直す。
//   毎朝の1枚（scripts/self-improve.ts）と同じ数え方（verdict が same か same_meaning・竹内さんの番は verdict_detail.staff_writer）・同じ名前（metric=reply_match）。
//   AIX の最初の一手・伸びしろは読みが重いので入れない（毎朝の1枚が入れる）。
//   スイッチ QUALITY_DAILY_FROM_EVAL（2026-11-21 から既定 on・記録だけなので試験なし・統括役の決め。止める =off）。記録だけで、判定・返信・AIX は変えない。失敗しても見張りは止めない。
import type { SupabaseClient } from "@supabase/supabase-js";

type Env = Record<string, string | undefined>;
export const qualityDailyFromEvalOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.QUALITY_DAILY_FROM_EVAL ?? "").trim().toLowerCase() !== "off"; // 2026-11-21 既定 on（記録だけ・統括役の決め）・止める =off

const jstDay = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const isMatch = (v: string) => v === "same" || v === "same_meaning";

/** 1日分の返信の一致（純関数） */
export function replyMatchOf(rows: ReadonlyArray<{ verdict: string; writer: string | null }>) {
  const r = (xs: ReadonlyArray<{ verdict: string }>) => ({ n: xs.length, value: xs.length ? Math.round((xs.filter((x) => isMatch(x.verdict)).length / xs.length) * 1000) / 10 : null });
  return { all: r(rows), takeuchi: r(rows.filter((x) => x.writer === "takeuchi")) };
}

export async function refreshReplyMatchDays(sb: SupabaseClient, days = 3, nowMs = Date.now()): Promise<number> {
  const rows: Array<Record<string, unknown>> = [];
  for (let k = 1; k <= days; k++) {
    const d = jstDay(nowMs - k * 86_400_000);
    const s0 = new Date(`${d}T00:00:00+09:00`).toISOString(), e0 = new Date(Date.parse(s0) + 86_400_000).toISOString();
    const { data, error } = await sb.from("line_watch_turns").select("verdict,writer:verdict_detail->>staff_writer").gte("customer_turn_at", s0).lt("customer_turn_at", e0).not("verdict", "is", null).neq("verdict", "na").limit(3000);
    if (error) throw new Error(error.message);
    const m = replyMatchOf((data ?? []) as Array<{ verdict: string; writer: string | null }>);
    for (const scope of ["all", "takeuchi"] as const) rows.push({ day: d, metric: "reply_match", scope, value: m[scope].value, n: m[scope].n, source: "line-watch-eval" });
  }
  const { error } = await sb.from("quality_daily").upsert(rows, { onConflict: "day,metric,scope" });
  if (error) throw new Error(error.message);
  return rows.length;
}
