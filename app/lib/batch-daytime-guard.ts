// app/lib/batch-daytime-guard.ts — 夜の一括の cron（2通目の手本・場面の RAG・文の解剖）を、昼でも本番の調子が良ければ少しずつ動かす守り
//
// 2026-11-03 作業員6（竹内さん「コードで軽くしたから固まらないのでは」・統括の指示）。
//   JST 9〜22時: 本番の調子が良い時だけ動く・1回の量は半分・間の待ちは2倍。悪い時は今まで通り動かない。夜は今まで通り。
//   本番の調子 = 直近10分の LLM の失敗（status 0＝時間切れ・つながらない か 5xx・テスト／script／個人情報の別窓口止めは数えない）＋ cron の失敗（cron_run_logs.ok=false）が 0。
//   （作業員1の ops-anomaly の llm_fail・cron_fail と同じ数え方。窓を10分に縮めた物）
//   守り: BATCH_DAYTIME_GUARD=strict（今まで通り・昼は ?force=1 が無いと動かない）。既定は adaptive（上の形）。
import type { SupabaseClient } from "@supabase/supabase-js";

export type DaytimeDecision = { run: boolean; daytime: boolean; scale: number; pauseScale: number; reason: string };
export function jstHourNow(now = new Date()): number { return (now.getUTCHours() + 9) % 24; }

/** 決め方（純関数） */
export function daytimeDecision(o: { hour: number; force: boolean; mode: string; failures: number | null }): DaytimeDecision {
  const daytime = o.hour >= 9 && o.hour < 22;
  if (!daytime || o.force) return { run: true, daytime, scale: 1, pauseScale: 1, reason: o.force ? "force" : "night" };
  if (o.mode === "strict") return { run: false, daytime, scale: 0, pauseScale: 0, reason: "営業時間（JST 9〜22時）は動かさない（BATCH_DAYTIME_GUARD=strict）・?force=1 で動かす" };
  if (o.failures === null) return { run: false, daytime, scale: 0, pauseScale: 0, reason: "本番の調子を読めない＝昼は動かさない" };
  if (o.failures > 0) return { run: false, daytime, scale: 0, pauseScale: 0, reason: `本番の調子が悪い（直近10分の失敗 ${o.failures}）＝昼は動かさない` };
  return { run: true, daytime, scale: 0.5, pauseScale: 2, reason: "昼・本番の調子が良い＝量を半分・間を2倍で動かす" };
}

/** 直近10分の失敗の数（読めない時は null） */
export async function recentFailures(db: SupabaseClient, now = new Date()): Promise<number | null> {
  try {
    const since = new Date(now.getTime() - 10 * 60_000).toISOString();
    const [llm, cron] = await Promise.all([
      db.from("llm_usage_logs").select("error_type, env, route, status").gte("created_at", since).or("status.eq.0,status.gte.500").limit(200),
      db.from("cron_run_logs").select("id", { count: "exact", head: true }).gte("started_at", since).eq("ok", false),
    ]);
    if (llm.error || cron.error) return null;
    const l = ((llm.data ?? []) as Array<{ error_type: string | null; env: string | null; route: string | null }>)
      .filter((r) => r.error_type !== "alt_skipped_pii" && !String(r.env ?? "").includes("test") && !String(r.route ?? "").startsWith("script:")).length;
    return l + (cron.count ?? 0);
  } catch { return null; }
}

export async function decideBatchRun(db: SupabaseClient | null, force: boolean, env: Record<string, string | undefined> = process.env, now = new Date()): Promise<DaytimeDecision> {
  const hour = jstHourNow(now);
  const mode = (env.BATCH_DAYTIME_GUARD ?? "adaptive").trim().toLowerCase();
  const daytime = hour >= 9 && hour < 22;
  const failures = daytime && !force && mode !== "strict" && db ? await recentFailures(db, now) : daytime && !db ? null : 0;
  return daytimeDecision({ hour, force, mode, failures });
}

/** cron から呼ぶ形（サーバーの鍵で本番の調子を読む） */
export async function decideBatchRunFromEnv(force: boolean): Promise<DaytimeDecision> {
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return decideBatchRun(url && key ? createClient(url, key, { auth: { persistSession: false } }) : null, force);
}
