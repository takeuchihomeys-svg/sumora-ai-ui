// scripts/audit-vacate-movein-gap.ts — 退去予定のお部屋の「最短の入居時期の目安」をスタッフがどう逆算して答えたか（読むだけ・LLM なし）
//   2026-10-15 竹内さんの決定②「ちゃんと逆算して入れる」の材料: 退去予定日と答えた最短の入居時期の差（工事・クリーニングの期間）を実送信から数える。
// 実行: npx tsx --env-file=.env.local scripts/audit-vacate-movein-gap.ts [--days=150] [--all]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "150"));
const ALL = process.argv.includes("--all");
type M = { conversation_id: string; sender: string; text: string | null; created_at: string; staff_writer: string | null; is_aix_generated: boolean | null };
async function main() {
  const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
  const all: M[] = [];
  for (let p = 0; p < 80; p++) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, created_at, staff_writer, is_aix_generated")
      .gte("created_at", since).neq("sender", "customer").ilike("text", "%退去%")
      .order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    if (error) throw error;
    all.push(...((data ?? []) as M[]));
    if ((data ?? []).length < 1000) break;
  }
  let n = 0;
  for (const m of all) {
    if (isTestConversation(m.conversation_id)) continue;
    const t = String(m.text ?? "");
    if (!ALL && !/(?:最短|クリーニング|工事|原状回復|リフォーム)/.test(t)) continue;
    if (!/(?:入居|住め|入れ)/.test(t)) continue;
    n++;
    console.log(`${m.conversation_id.slice(0, 8)} ${m.created_at.slice(0, 16)} [${m.staff_writer ?? "-"}${m.is_aix_generated ? "・AIX" : ""}] ${t.replace(/\n/g, "／").slice(0, 300)}`);
  }
  console.log(`\n${n}通（${DAYS}日・退去と入居の語のある送信）`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
