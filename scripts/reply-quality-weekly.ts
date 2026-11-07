// scripts/reply-quality-weekly.ts — 返信の番だけの文の質（竹内さん本人の送信と下書きの近さ）を週ごとに出す（LLM なし・読むだけ）
//
// 2026-11-07 作業員9（統括役・竹内さん「文の質はどれくらい上がっているか」）。計算は app/lib/reply-quality-weekly.ts（純関数）、
//   読み方は毎週の振り返りと同じ app/lib/conductor-reflection-server.ts の loadReplyQualityStats（1か所）。DB は 1000行の頁で読む。
//   11/07 から「返信を2〜3通に分けた番」の欄（数・近さ・竹内さんの返信の中身が下書きに入っている割合 1通目／全部つないだ物）
// 実行: npx tsx --env-file=.env.local scripts/reply-quality-weekly.ts [--weeks=8] [--writer=takeuchi] [--json]
import { createClient } from "@supabase/supabase-js";
import { weeklyTable } from "../app/lib/reply-quality-weekly";
import { loadReplyQualityStats } from "../app/lib/conductor-reflection-server";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const weeks = Math.max(1, Math.min(26, Number(arg("weeks", "8")) || 8));
const writer = arg("writer", "takeuchi");
const asJson = process.argv.includes("--json");

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main(): Promise<void> {
  // loadReplyQualityStats の weeks は「今週より前の週の数」＝今週を含めて weeks 週にするには weeks-1
  const r = await loadReplyQualityStats(sb, { weeks: weeks - 1, writer });
  if (!r) throw new Error("読めませんでした（DB の読みで失敗）");
  if (asJson) { console.log(JSON.stringify({ since: r.since, writer, weeks, currentWeek: r.currentWeek, stats: r.stats })); return; }
  console.log(`返信の番だけの文の質（${writer}・AIX の番を除く・${r.since.slice(0, 10)} から・下書き ${r.read} 通を読んだ・今週 ${r.currentWeek} は途中）`);
  console.log(weeklyTable(r.stats));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
