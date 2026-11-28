// scripts/audit-staff-added-phrases.ts — スタッフが毎回足す一言の型の表（台帳 #815・LLM なし・費用0・DB は日付と会話で絞った軽い読み）
// 2026-11-27 作業員L（統括役の頼み）: line_watch_turns（番ごとの AI の下書き draft_last と実送信 staff_texts）を、書き手（messages.staff_writer='takeuchi' が竹内さん本人）で分け、
//   場面（scene_key・無ければ tpo_label）×一言の型×足した割合を出す。文は出さない（型の名前と数だけ）。申込以降の番は数えない
// 実行: npx tsx --env-file=.env.local scripts/audit-staff-added-phrases.ts [--days=60] [--min=5] [--json=<file>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { phraseTable, PHRASE_JA, type TurnIn } from "./lib/staff-added-phrases";
import { isPostApplyStatus } from "../app/lib/llm-alt-provider";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type Row = { conversation_id: string; customer_turn_at: string; conv_status: string | null; draft_last: string | null; staff_texts: Array<{ at?: string; text?: string }> | null; scene_key: string | null; tpo_label: string | null };

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!, { auth: { persistSession: false } });
  const days = Number(arg("days", "60")) || 60, since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows: Row[] = [];
  for (let from = 0; from < 20_000; from += 1000) {
    const { data, error } = await sb.from("line_watch_turns").select("conversation_id, customer_turn_at, conv_status, draft_last, staff_texts, scene_key, tpo_label").gte("customer_turn_at", since).not("draft_last", "is", null).order("customer_turn_at", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  const use = rows.filter((r) => !isPostApplyStatus(r.conv_status) && (r.staff_texts ?? []).some((x) => String(x.text ?? "").trim()));
  // 書き手: 実送信の時刻の messages.staff_writer（会話ごと・期間の中だけ読む）
  const writerAt = new Map<string, string>();
  const convs = [...new Set(use.map((r) => r.conversation_id))];
  for (let i = 0; i < convs.length; i += 50) {
    const { data, error } = await sb.from("messages").select("conversation_id, created_at, staff_writer").in("conversation_id", convs.slice(i, i + 50)).neq("sender", "customer").gte("created_at", since).limit(20_000);
    if (error) throw new Error(error.message);
    for (const m of (data ?? []) as Array<{ conversation_id: string; created_at: string; staff_writer: string | null }>) writerAt.set(`${m.conversation_id}|${Math.round(Date.parse(m.created_at) / 1000)}`, m.staff_writer ?? "");
  }
  const writerOf = (conv: string, at?: string) => { if (!at) return ""; const s = Math.round(Date.parse(at) / 1000); for (const d of [0, -1, 1, -2, 2]) { const w = writerAt.get(`${conv}|${s + d}`); if (w !== undefined) return w; } return ""; };
  const turns: TurnIn[] = use.map((r) => {
    const st = (r.staff_texts ?? []).filter((x) => String(x.text ?? "").trim());
    return { scene: r.scene_key || r.tpo_label || "(場面なし)", writer: writerOf(r.conversation_id, st[0]?.at) === "takeuchi" ? "takeuchi" : "staff", draft: String(r.draft_last ?? ""), sent: st.map((x) => x.text).join("\n") };
  });
  const tbl = phraseTable(turns, Number(arg("min", "5")) || 5);
  console.log(`スタッフが足した一言の型（${days}日・下書きと実送信が揃う番 ${turns.length}・うち竹内さん本人 ${turns.filter((t) => t.writer === "takeuchi").length}・申込以降は除く）`);
  for (const who of ["竹内さん", "全員"] as const) {
    console.log(`\n## ${who}（足した割合の高い順・上位15）`);
    for (const r of tbl.filter((x) => x.who === who).slice(0, 15)) console.log(`- ${r.scene}｜${PHRASE_JA[r.kind]}｜${r.share}%（${r.added}/${r.turns}番）`);
  }
  if (arg("json")) writeFileSync(arg("json"), JSON.stringify({ at: new Date().toISOString(), days, turns: turns.length, table: tbl }, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
