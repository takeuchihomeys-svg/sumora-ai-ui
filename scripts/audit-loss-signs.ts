// scripts/audit-loss-signs.ts — 失注の兆しの地図を照らしの json に当てる（#805・費用0・LLM なし・2026-11-27 作業員A）
//   入力: audit-route-progress-takeuchi.ts --json の出力（60日・今夜の広げの後は 120日に当て直す）。会話ごとにお客様とこちらの通を読む（会話の数だけの読み＝夜に回す）。
//   竹内さん本人の番（--all-writers の json は writer=takeuchi だけ・--writers=all で全員）ごとに、直前のお客様の塊から合図を読み、離れた番・戻せた一手を数える。
//   実行: npx tsx --env-file=.env.local scripts/audit-loss-signs.ts --json=<照らしの json> [--max-conv=N] [--writers=all] [--out=<json>]
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { lossSignalsOf, isWarm, lossReasonOf, leftSoonAndRecovered, lossSignalTable, lossRecovery, lossLines, type LossTurn } from "./lib/loss-signs";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "", { auth: { persistSession: false } });
type Row = { conv: string; at: string; act: string | null; outcome: string | null; writer?: string | null };

async function main() {
  const all = JSON.parse(readFileSync(arg("json")!, "utf8")) as Row[];
  const rows = (arg("writers") === "all" ? all : all.filter((r) => (r.writer ?? "takeuchi") === "takeuchi")).sort((a, b) => a.conv.localeCompare(b.conv) || a.at.localeCompare(b.at));
  const convs = [...new Set(rows.map((r) => r.conv))].slice(0, Number(arg("max-conv") ?? "100000"));
  const ids: string[] = [];
  for (let from = 0; ; from += 1000) { const { data } = await sb.from("conversations").select("id").range(from, from + 999); const xs = (data ?? []) as Array<{ id: string }>; ids.push(...xs.map((x) => x.id)); if (xs.length < 1000) break; }
  const idOf = (p: string) => ids.find((x) => x.startsWith(p)) ?? null;
  const turns: LossTurn[] = [];
  const reasons: Record<string, number> = {};
  for (const c of convs) {
    const rs = rows.filter((r) => r.conv === c);
    const t0 = new Date(Date.parse(rs[0].at) - 30 * 864e5).toISOString(), t1 = new Date(Date.parse(rs[rs.length - 1].at) + 14 * 864e5).toISOString();
    // 照らしの json の会話は id の頭8字＝最初に会話の id だけを1回読んで頭で引く
    const id = idOf(c);
    if (!id) continue;
    const { data: ms } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", id).gte("created_at", t0).lte("created_at", t1).order("created_at", { ascending: true }).limit(800);
    const m = (ms ?? []) as Array<{ sender: string; text: string | null; created_at: string }>;
    const custLens = m.filter((x) => x.sender === "customer").map((x) => String(x.text ?? "").length).sort((a, b) => a - b);
    const medLen = custLens.length ? custLens[Math.floor(custLens.length / 2)] : null;
    let prevGapH: number | null = null, prevWarm: boolean | null = null;
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i], T = Date.parse(r.at);
      // 直前のお客様の塊と、その前のこちらの通
      const before = m.filter((x) => Date.parse(x.created_at) <= T);
      let k = before.length - 1; while (k >= 0 && before[k].sender !== "customer") k--;
      if (k < 0) continue;
      let s = k; while (s > 0 && before[s - 1].sender === "customer") s--;
      const burst = before.slice(s, k + 1).map((x) => String(x.text ?? ""));
      const ourPrev = [...before.slice(0, s)].reverse().find((x) => x.sender !== "customer");
      const gapH = ourPrev ? (Date.parse(before[s].created_at) - Date.parse(ourPrev.created_at)) / 36e5 : null;
      const signals = lossSignalsOf({ texts: burst, gapH, prevGapH, len: burst.join("").length, medLen, prevWarm });
      const { leftSoon, recovered } = leftSoonAndRecovered(rows, rows.indexOf(r));
      turns.push({ conv: c, at: r.at, signals, leftSoon, act: r.act, recovered });
      prevGapH = gapH; prevWarm = isWarm(burst);
    }
    if (rs.some((r) => r.outcome === "left")) {
      const lastCust = [...m].reverse().find((x) => x.sender === "customer");
      const lastBurst = lastCust ? m.filter((x) => x.sender === "customer" && Math.abs(Date.parse(x.created_at) - Date.parse(lastCust.created_at)) < 36e5).map((x) => String(x.text ?? "")) : null;
      const reason = lossReasonOf(lastBurst);
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
  }
  const table = lossSignalTable(turns), rec = lossRecovery(turns);
  console.log(lossLines(table, rec, reasons, turns.length).join("\n"));
  const out = arg("out"); if (out) writeFileSync(out, JSON.stringify({ table, recovery: rec, reasons, n: turns.length }, null, 1));
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
