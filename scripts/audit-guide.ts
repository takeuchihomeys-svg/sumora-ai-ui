// scripts/audit-guide.ts — 誘導の物差し（①番ごと・②型の表・③先読みの数え表）を本番の記録で数える（読むだけ・LLM なし・費用0）
//
// 2026-11-18 作業員L。読む物: 竹内さん本人の送信のある会話の messages（sender・text・created_at・staff_writer・is_aix_generated）・
//   aix_usage_logs（種類と時刻）・brain_decision_logs（digest の sg＝その時の段階）。テストの会話・社内の会話は外す。会話の文は出さない（数だけ）。
//   重い読み: 日数×会話の数。営業時間（JST 9〜22時）は --days=2 --max-conv=20 まで（台本が止める）。--force で手元の確かめだけ。
// 実行: npx tsx --env-file=.env.local scripts/audit-guide.ts [--days=60] [--max-conv=400] [--json=<出力>] [--write（cron_run_logs に guide-measure の1行）]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { guideTurnsOf, guideTable, reactionTable, OUTCOME_JA, type GMsg, type GAix, type GDecision, type GuideTurn } from "./lib/guide-measure";
import { NO_LINE_TEST_CONVERSATION_IDS, STAFF_INTERNAL_CONVERSATION_IDS, YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
(async () => {
  let days = Number(arg("days", "60")) || 60, maxConv = Number(arg("max-conv", "400")) || 400;
  const h = (new Date().getUTCHours() + 9) % 24;
  if (h >= 9 && h < 22 && !process.argv.includes("--force")) { days = Math.min(days, 2); maxConv = Math.min(maxConv, 20); console.log(`営業時間なので --days=${days} --max-conv=${maxConv} に絞った（全部は22時以降）`); }
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const skip = new Set<string>([YUMA_CONVERSATION_ID, ...NO_LINE_TEST_CONVERSATION_IDS, ...STAFF_INTERNAL_CONVERSATION_IDS]);
  const { data: tk, error } = await sb.from("messages").select("conversation_id").eq("sender", "staff").eq("staff_writer", "takeuchi").gte("created_at", since).limit(20000);
  if (error) throw new Error(error.message);
  const convs = [...new Set(((tk ?? []) as Array<{ conversation_id: string }>).map((r) => r.conversation_id))].filter((c) => !skip.has(c)).slice(0, maxConv);
  const turns: GuideTurn[] = [];
  for (const c of convs) {
    const [m, a, d] = await Promise.all([
      sb.from("messages").select("sender, text, created_at, staff_writer, is_aix_generated").eq("conversation_id", c).gte("created_at", since).order("created_at").limit(2000),
      sb.from("aix_usage_logs").select("aix_type, sent_at, created_at").eq("conversation_id", c).gte("created_at", since).limit(500),
      sb.from("brain_decision_logs").select("created_at, digest").eq("conversation_id", c).gte("created_at", since).order("created_at").limit(1000),
    ]);
    const decisions: GDecision[] = ((d.data ?? []) as Array<{ created_at: string; digest: { sg?: string; cp?: string } | null }>).map((x) => ({ created_at: x.created_at, stage: x.digest?.sg ?? x.digest?.cp ?? null }));
    turns.push(...guideTurnsOf(c, (m.data ?? []) as GMsg[], (a.data ?? []) as GAix[], decisions));
  }
  const by = (o: string) => turns.filter((t) => t.outcome === o).length;
  const summary = `誘導の物差し（${days}日・会話 ${convs.length}・竹内さん本人の番 ${turns.length}・駅が分かる番 ${turns.filter((t) => t.before).length}）: ${(["advanced", "stuck", "back", "left"] as const).map((o) => `${OUTCOME_JA[o]} ${by(o)}`).join("・")}`;
  console.log(summary);
  const tab = [...guideTable(turns).entries()].filter(([k]) => k.endsWith("|*")).sort((a, b) => b[1].n - a[1].n).slice(0, 25);
  console.log("\n## ② 型の表（駅 × 一手 → 結果・上位25・少ない＝5番未満）");
  for (const [k, c] of tab) console.log(`${k.replace(/\|\*$/, "").padEnd(44)} n=${String(c.n).padStart(3)} 進んだ ${c.advanced} 止まった ${c.stuck} 戻った ${c.back} 離れた ${c.left}${c.few ? "（少ない）" : ""}`);
  console.log("\n## ③ 先読みの数え表（一手 → 次の返事の型）");
  for (const [k, r] of [...reactionTable(turns).entries()].sort((a, b) => Object.values(b[1]).reduce((x, y) => x + y, 0) - Object.values(a[1]).reduce((x, y) => x + y, 0)).slice(0, 15)) console.log(`${k.padEnd(30)} ${Object.entries(r).sort((a, b) => b[1] - a[1]).map(([x, n]) => `${x} ${n}`).join("・")}`);
  if (arg("json", "")) writeFileSync(arg("json", ""), JSON.stringify(turns.map((t) => ({ ...t, conv: t.conv.slice(0, 6) })), null, 1));
  if (process.argv.includes("--write")) {
    const now = new Date().toISOString();
    const { error: e2 } = await sb.from("cron_run_logs").insert({ cron_name: "guide-measure", started_at: now, finished_at: now, ok: true, result_json: { summary, table: Object.fromEntries(tab) } });
    console.log(e2 ? `書けなかった: ${e2.message}` : "cron_run_logs に1行");
  }
})().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
