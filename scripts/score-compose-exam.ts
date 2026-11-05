// scripts/score-compose-exam.ts — 試験の答案の下書きを竹内さん（実際のスタッフ）の送信と比べる（読むだけ・LLM なし）
// 2026-11-06 作業員9（COMPOSE_CONDUCTOR の試験の採点）。scoreAgainstTakeuchi（近さ・原則の型・継続の約束の抜け）で on と off を並べる
// 実行: npx tsx --env-file=.env.local scripts/score-compose-exam.ts --on=<jsonl>[,<jsonl>] --off=<jsonl>[,<jsonl>]
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { scoreAgainstTakeuchi, OMIT_JA } from "../app/lib/reply-compose-conductor";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? "";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const spec = JSON.parse(readFileSync("scripts/brain-exam/spec.json", "utf8")) as Array<{ id: string; conv: string; at: string }>;
type Row = { id: string; rep: number; draft?: { text?: string | null } | null };
const load = (fs: string) => fs.split(",").filter(Boolean).flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row));

async function sentOf(id: string): Promise<{ text: string; writer: string | null } | null> {
  const q = spec.find((x) => x.id === id); if (!q) return null;
  const { data } = await sb.from("messages").select("text, sender, created_at, staff_writer, is_aix_generated").eq("conversation_id", q.conv)
    .gt("created_at", q.at).lt("created_at", new Date(Date.parse(q.at) + 6 * 3600_000).toISOString()).order("created_at").limit(10);
  const m = (data ?? []).find((x) => x.sender === "staff" && x.text && x.text !== "[画像]");
  return m ? { text: m.text as string, writer: (m.staff_writer as string | null) ?? null } : null;
}

async function main() {
  const on = load(arg("on")), off = load(arg("off"));
  const ids = [...new Set([...on, ...off].map((r) => r.id))].sort();
  for (const id of ids) {
    const s = await sentOf(id);
    if (!s) { console.log(`${id}: 実際の送信が見つからない`); continue; }
    const sc = (rows: Row[]) => rows.filter((r) => r.id === id && r.draft?.text).map((r) => scoreAgainstTakeuchi({ draft: r.draft!.text!, sent: s.text }));
    const a = sc(off), b = sc(on);
    const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((p, c) => p + c, 0) / xs.length) * 100) / 100 : null);
    const line = (xs: ReturnType<typeof sc>) => `近さ ${avg(xs.map((x) => x.sim)) ?? "-"}（${xs.length}通）・原則の外れ ${xs.reduce((p, x) => p + x.extraKinds.length, 0)}・継続の抜け ${xs.filter((x) => x.keepMissed).length}`;
    console.log(`${id}（書き手 ${s.writer ?? "?"}）\n  off: ${line(a)}\n  on : ${line(b)}${b.flatMap((x) => x.extraKinds).length ? `（${[...new Set(b.flatMap((x) => x.extraKinds))].map((k) => OMIT_JA[k]).join("・")}）` : ""}\n  送信: ${s.text.replace(/\s+/g, " ").slice(0, 140)}`);
    for (const [tag, rows] of [["off", off], ["on", on]] as const) for (const r of rows.filter((x) => x.id === id && x.draft?.text)) console.log(`    ${tag}#${r.rep}: ${r.draft!.text!.replace(/\s+/g, " ").slice(0, 140)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
