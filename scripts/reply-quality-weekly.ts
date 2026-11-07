// scripts/reply-quality-weekly.ts — 返信の番だけの文の質（竹内さん本人の送信と下書きの近さ）を週ごとに出す（LLM なし・読むだけ）
//
// 2026-11-07 作業員9（統括役・竹内さん「文の質はどれくらい上がっているか」）。計算は app/lib/reply-quality-weekly.ts（純関数）。
//   毎週の振り返り（CONDUCTOR_REFLECTION）・毎朝の拾い上げから呼ぶ想定。DB は 1000行の頁で読む（営業時間の重い読みを避けるなら --weeks を小さく）。
// 実行: npx tsx --env-file=.env.local scripts/reply-quality-weekly.ts [--weeks=8] [--writer=takeuchi] [--json]
import { createClient } from "@supabase/supabase-js";
import { weeklyReplyQuality, weeklyTable, nearestStaffMessage, type QualityRow } from "../app/lib/reply-quality-weekly";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const weeks = Math.max(1, Math.min(26, Number(arg("weeks", "8")) || 8));
const writer = arg("writer", "takeuchi");
const asJson = process.argv.includes("--json");
const PAGE = 1000;

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

function startIso(): string {
  // JST の今週の月曜 0時から weeks-1 週前
  const now = Date.now() + 9 * 3600_000;
  const d = new Date(now);
  const dow = (d.getUTCDay() + 6) % 7;
  const monJst = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow - 7 * (weeks - 1));
  return new Date(monJst - 9 * 3600_000).toISOString();
}

type Ex = { conversation_id: string; sent_at: string; ai_similarity: number | null; ai_draft: string | null; sent_reply: string | null };
type Msg = { conversation_id: string; created_at: string; staff_writer: string | null; is_aix_generated: boolean | null };

async function pages<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function main(): Promise<void> {
  const since = startIso();
  const ex = await pages<Ex>((a, b) => sb.from("ai_reply_examples").select("conversation_id, sent_at, ai_similarity, ai_draft, sent_reply")
    .gte("sent_at", since).not("ai_draft", "is", null).not("ai_similarity", "is", null).order("sent_at", { ascending: true }).range(a, b));
  const rowsIn = ex.filter((e) => (e.ai_draft ?? "").trim() && (e.sent_reply ?? "").trim() && e.conversation_id);
  // スタッフの通は会話ごとに 200件ずつ（URL の長さ）で読む
  const convIds = [...new Set(rowsIn.map((e) => e.conversation_id))];
  const msgsByConv = new Map<string, Msg[]>();
  const sinceMsg = new Date(Date.parse(since) - 5 * 60_000).toISOString();
  for (let i = 0; i < convIds.length; i += 200) {
    const ids = convIds.slice(i, i + 200);
    const ms = await pages<Msg>((a, b) => sb.from("messages").select("conversation_id, created_at, staff_writer, is_aix_generated")
      .in("conversation_id", ids).neq("sender", "customer").gte("created_at", sinceMsg).order("created_at", { ascending: true }).range(a, b));
    for (const m of ms) (msgsByConv.get(m.conversation_id) ?? msgsByConv.set(m.conversation_id, []).get(m.conversation_id)!).push(m);
  }
  const rows: QualityRow[] = rowsIn.map((e) => {
    const m = nearestStaffMessage(e.sent_at, msgsByConv.get(e.conversation_id) ?? []);
    return { sentAt: e.sent_at, similarity: Number(e.ai_similarity), draft: e.ai_draft ?? "", sent: e.sent_reply ?? "", writer: m?.staff_writer ?? null, aix: m?.is_aix_generated ?? null };
  });
  const stats = weeklyReplyQuality(rows, writer);
  if (asJson) { console.log(JSON.stringify({ since, writer, weeks, stats })); return; }
  console.log(`返信の番だけの文の質（${writer}・AIX の番を除く・${since.slice(0, 10)} から・下書き ${rowsIn.length} 通を読んだ）`);
  console.log(weeklyTable(stats));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
