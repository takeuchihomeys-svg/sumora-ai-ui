// scripts/audit-apply-live.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-apply-live.ts [--days=7]
//
// 2026-09-20: detectApplyReadiness を**今動いている会話**に当てて「何件に出るか」を測る。
//   設計知見「分析強化の原則」= 材料やルールを足す前に**届き方**を測る。
//   出しすぎれば注意が安売りされ、出なければ意味がない。
// 読み取りのみ。
import { createClient } from "@supabase/supabase-js";
import { detectApplyReadiness, buildApplyReadinessNote, type ApplyMsg } from "../app/lib/apply-readiness";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=7").split("=")[1]);
/** もう申込より先へ進んでいる会話には出さない（出しても意味がない） */
const DONE = ["applying", "application_push", "screening", "closed_won", "contract", "closed_lost"];

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const { data: convs, error } = await sb.from("conversations")
    .select("id, customer_name, status, updated_at").gte("updated_at", since).order("updated_at", { ascending: false });
  if (error) { console.error(error.message); process.exit(1); }
  const live = (convs ?? []).filter((c) => !DONE.includes(String(c.status ?? "")));
  console.log(`=== 直近${DAYS}日に動いた会話 ${(convs ?? []).length}件 / うち申込前 ${live.length}件 ===\n`);

  const rows: Array<{ name: string; status: string; score: number; level: string; reason: string }> = [];
  for (const c of live) {
    const { data } = await sb.from("messages").select("sender, text, created_at")
      .eq("conversation_id", c.id as string).order("created_at", { ascending: false }).limit(200);
    const ms: ApplyMsg[] = ((data ?? []) as Array<{ sender: string; text: string | null; created_at: string }>)
      .map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at }));
    const r = detectApplyReadiness(ms, Date.now());
    rows.push({ name: String(c.customer_name), status: String(c.status ?? ""), score: r.score, level: r.level, reason: r.reason });
  }
  const n = (lv: string) => rows.filter((x) => x.level === lv).length;
  console.log(`--- 段階の分かれ方 ---`);
  for (const lv of ["hot", "warm", "low"]) {
    console.log(`  ${lv.padEnd(5)} ${String(n(lv)).padStart(4)}件 (${((100 * n(lv)) / Math.max(rows.length, 1)).toFixed(0)}%)`);
  }
  console.log(`\n--- hot（申込が近い＝スタッフに知らせる相手）---`);
  rows.filter((x) => x.level === "hot").sort((a, b) => b.score - a.score)
    .forEach((x) => console.log(`  ${String(x.score).padStart(3)}点 ${x.name.padEnd(14)} [${x.status}] ${x.reason}`));

  const sample = rows.find((x) => x.level === "hot");
  if (sample) {
    console.log(`\n--- プロンプトに入る覚え書き（実物・${sample.name}）---`);
    console.log(buildApplyReadinessNote({ score: sample.score, level: "hot", hits: [], reason: sample.reason, windowCount: 9 })
      .split("\n").map((l) => `  ${l}`).join("\n"));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
