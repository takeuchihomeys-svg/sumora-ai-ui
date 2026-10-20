// app/lib/self-review-morning.ts — 朝の報告（/api/cron/morning-report）の「🧠 自己点検（夜中）」の段
//
// 2026-10-18 竹内さん 10/18 OK「毎晩の自己点検を朝の報告に載せる」。本番の cron は手元のファイル（morning-line.txt）を読めないので、
//   scripts/brain-self-review.ts が書いた表（brain_self_review_runs の1日1行・brain_self_review_proposals の status='open'）を読む。
//   表が無い（まだ流していない）・直近2日に行が無い時は段を出さない。読むだけ。戻す MORNING_SELF_REVIEW=off
import type { SupabaseClient } from "@supabase/supabase-js";

export function morningSelfReviewEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.MORNING_SELF_REVIEW ?? "").trim().toLowerCase() !== "off";
}

export type SelfReviewRun = { day: string; morning_line: string; explained: number; proposals: number; ask_count: number; questions: string[] | null; top_cause: string | null };
export type OpenProposal = { fix_kind: string; cause_keys: string[] | null; n: number; needs_takeuchi: boolean; questions: string[] | null };

/** JST の日付（YYYY-MM-DD） */
export const jstDay = (ms = Date.now()) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);

/**
 * 段の文（純関数）。run が無ければ空。
 *   1行目は self-review の朝の1行そのまま・2行目に案の数と未決（open）の数・竹内さんに聞く事は上から3つ（その日の物→未決の物の順・重ねない）
 */
export function formatSelfReviewSection(run: SelfReviewRun | null, open: ReadonlyArray<OpenProposal>, o: { today?: string } = {}): string {
  if (!run) return "";
  const today = o.today ?? jstDay();
  const stale = run.day < jstDay(Date.parse(`${today}T00:00:00+09:00`) - 86_400_000);
  if (stale) return "";
  const openN = open.length;
  const openAsk = open.filter((p) => p.needs_takeuchi);
  const qs = [...new Set([...(run.questions ?? []), ...openAsk.flatMap((p) => p.questions ?? [])].map((q) => q.trim()).filter(Boolean))].slice(0, 3);
  const lines = [
    run.morning_line,
    `  案 ${run.proposals}件（説明 ${run.explained}件）・未決の案 ${openN}件${openAsk.length ? `（うち竹内さんに聞く ${openAsk.length}件）` : ""}`,
  ];
  if (qs.length) lines.push("  竹内さんに聞く事:", ...qs.map((q) => `  ・${q}`));
  return `🧠 自己点検（夜中）\n${lines.join("\n")}`;
}

const NO_TABLE = (e: { code?: string; message?: string } | null) => !!e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|Could not find the table/i.test(e.message ?? ""));

/**
 * 表を読んで段を作る（表が無い・止めている・失敗は空＝朝の報告は止めない）。
 *   表は RLS あり・方針なし（anon では読めない）→ SUPABASE_SERVICE_ROLE_KEY がある時はその鍵で読む（無ければ渡された client＝読めなければ空）
 */
export async function loadSelfReviewSection(fallback: SupabaseClient): Promise<string> {
  if (!morningSelfReviewEnabled()) return "";
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, skey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const sb = url && skey ? (await import("@supabase/supabase-js")).createClient(url, skey, { auth: { persistSession: false } }) : fallback;
  const since = jstDay(Date.now() - 86_400_000);
  const { data: runs, error } = await sb.from("brain_self_review_runs")
    .select("day, morning_line, explained, proposals, ask_count, questions, top_cause").gte("day", since).order("day", { ascending: false }).limit(1);
  if (error) { if (!NO_TABLE(error)) console.warn(JSON.stringify({ tag: "morning-report:self-review-read-failed", error: error.message })); return ""; }
  const run = ((runs ?? [])[0] ?? null) as SelfReviewRun | null;
  if (!run) return "";
  const { data: open } = await sb.from("brain_self_review_proposals")
    .select("fix_kind, cause_keys, n, needs_takeuchi, questions").eq("status", "open").order("n", { ascending: false }).limit(50);
  return formatSelfReviewSection(run, (open ?? []) as OpenProposal[]);
}
