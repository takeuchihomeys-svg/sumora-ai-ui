// scripts/audit-exam-focus-scenes.ts — 試験を寄せる場面の順位（#823 ③・費用0・LLM なし・2026-11-27 作業員A）
//   読む: line_watch_turns（days 日・軽い読み）と exam-dictionary.json（手元）。--write で quality_daily の exam_focus:top（detail に上位5つ）を書く（朝の1枚の1行が読む）
//   実行: npx tsx --env-file=.env.local scripts/audit-exam-focus-scenes.ts [--days=14] [--write]
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { focusTable, focusLine, type WatchRow } from "./lib/exam-focus-scenes";

const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "14");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "", { auth: { persistSession: false } });
const DICT = join(__dirname, "..", "..", "..", "..", ".claude", "exam-cache", "exam-dictionary.json");

async function main() {
  const { data, error } = await sb.from("line_watch_turns").select("scene_key, tpo_label, verdict, verdict_detail, brain_reply_mode, brain_action, staff_aix").gte("customer_turn_at", new Date(Date.now() - DAYS * 864e5).toISOString()).limit(5000);
  if (error) throw error;
  const rows: WatchRow[] = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    scene: String(r.scene_key ?? r.tpo_label ?? "-"), verdict: (r.verdict as string | null) ?? null,
    aixVerdict: ((r.verdict_detail as { aix_verdict?: string | null } | null)?.aix_verdict) ?? null,
    brainReply: String(r.brain_reply_mode ?? "") !== "aix" && !String(r.brain_action ?? "").trim(),
    // 2026-11-27 作業員A（#821 の読み）: スタッフの返事の塊の中で押した AIX（burst）だけ。塊の外で後から押した AIX は「約束の返信→後で AIX」の2段＝ブレインの返信と合う
    staffAix: Array.isArray(r.staff_aix) && (r.staff_aix as Array<{ burst?: boolean }>).some((x) => x?.burst === true),
  }));
  const problemCount: Record<string, number> = {};
  if (existsSync(DICT)) for (const p of Object.values((JSON.parse(readFileSync(DICT, "utf8")) as { problems: Record<string, { scene?: string }> }).problems)) { const s = p.scene ?? "other"; problemCount[s] = (problemCount[s] ?? 0) + 1; }
  const t = focusTable(rows, problemCount);
  console.log(focusLine(t, DAYS));
  for (const r of t.slice(0, 10)) console.log(`  ${r.scene}: 判定 ${r.judged}・外れ ${r.miss}（${r.missRate ?? "—"}%）・文 ${r.textMiss}・AIX ${r.aixMiss}・返信を AIX ${r.replyAsAix}・問題 ${r.problems}・点 ${r.score}`);
  if (process.argv.includes("--write")) {
    const day = new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10);
    const { error: e2 } = await sb.from("quality_daily").upsert([{ day, metric: "exam_focus:top", scope: "all", value: t[0]?.score ?? null, n: rows.length, source: "scripts/audit-exam-focus-scenes.ts", detail: { days: DAYS, line: focusLine(t, DAYS), top: t.slice(0, 5) } }], { onConflict: "day,metric,scope" });
    console.log(e2 ? `quality_daily: ${e2.message}` : "quality_daily exam_focus:top");
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
