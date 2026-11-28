// scripts/audit-delegation-index.ts — 台帳 #811「任せられる度」の本番の数え（LLM なし・22時以降）
// 2026-11-27 夜 作業員L: 数える元は新しく作らない＝scripts/audit-split-reply-aix.ts の --out（番の行の jsonl・個人情報あり＝scratchpad に置く）を読み、
//   app/lib/delegation-index.ts（純関数）で場面ごとの表にする。--write の時だけ quality_daily に deleg:* を書く（数だけ）
// 実行: npx tsx --env-file=.env.local scripts/audit-split-reply-aix.ts --days=30 --out=<jsonl> の後に
//       npx tsx --env-file=.env.local scripts/audit-delegation-index.ts --from=<jsonl> [--min=5] [--write]
import { requireFreeMemMb } from "./lib/free-mem-guard";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { delegationTable, delegationLines, type DelegRow } from "../app/lib/delegation-index";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string) => process.argv.includes(`--${k}`);

async function main() {
  // 2026-11-28 作業員L（統括役の決め）: 流す前の空きメモリの関所（1000MB・--min-free= で変える・--wait-min= の間待つ）
  await requireFreeMemMb(Number(process.argv.find((a) => a.startsWith("--min-free="))?.slice(11) ?? "") || 1000, { waitMin: Number(process.argv.find((a) => a.startsWith("--wait-min="))?.slice(11) ?? "0") || 0, label: "#811 任せられる度" });
  const f = arg("from"); if (!f) throw new Error("--from=<audit-split-reply-aix の --out の jsonl>");
  const rows: DelegRow[] = [];
  for (const l of readFileSync(f, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try { const r = JSON.parse(l) as { scene?: string; brain?: string; truth?: string; draft?: string | null; sent?: string | null; aixByText?: boolean }; rows.push({ scene: r.scene ?? "-", brain: r.brain ?? "", truth: r.truth ?? "", draft: r.draft ?? null, sent: r.sent ?? null, aixByText: !!r.aixByText }); } catch { /* 壊れた行は外す */ }
  }
  const cells = delegationTable(rows); const min = Number(arg("min", "5")) || 5;
  const all = cells.reduce((a, c) => ({ reply: a.reply + c.replyTurns, asIs: a.asIs + c.asIs, danger: a.danger + c.danger, value: a.value + c.dangerValue, over: a.over + c.dangerOverPromise, aix: a.aix + c.aixTurns, aixAsReply: a.aixAsReply + c.aixAsReply }), { reply: 0, asIs: 0, danger: 0, value: 0, over: 0, aix: 0, aixAsReply: 0 });
  console.log(`任せられる度（#811・番 ${rows.length}）: 返信の番 ${all.reply}・そのまま送れた ${all.reply ? Math.round((all.asIs / all.reply) * 1000) / 10 : "—"}%・危ない間違い ${all.danger}（値の間違い ${all.value}・約束の言い過ぎ ${all.over}）・AIX の番 ${all.aix}・そのうち返信にした ${all.aixAsReply}`);
  for (const l of delegationLines(cells, min)) console.log(l);
  if (flag("write")) {
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); const src = "scripts/audit-delegation-index.ts（作業員L・#811）";
    // 2026-11-28: quality_daily の scope は takeuchi/all/draft/employee だけ（check 制約）＝場面は metric の名前に入れる（deleg:as_is:<場面>）
    const totalCell = delegationTable(rows.map((r) => ({ ...r, scene: "全体" })))[0]; // 全体の行も同じ形で（deleg:*:全体）
    const out = [...(totalCell ? [totalCell] : []), ...cells.filter((c) => c.replyTurns + c.aixTurns >= min)].flatMap((c) => [
      { day, scope: "all", metric: `deleg:as_is:${c.scene}`, value: c.asIsRate, n: c.replyTurns, detail: { asIs: c.asIs, edited: c.edited }, source: src },
      { day, scope: "all", metric: `deleg:danger:${c.scene}`, value: c.danger, n: c.replyTurns, detail: { value: c.dangerValue, overPromise: c.dangerOverPromise, kinds: c.dangerKinds }, source: src },
      { day, scope: "all", metric: `deleg:danger_value:${c.scene}`, value: c.dangerValue, n: c.replyTurns, detail: {}, source: src },
      { day, scope: "all", metric: `deleg:danger_over_promise:${c.scene}`, value: c.dangerOverPromise, n: c.replyTurns, detail: {}, source: src },
      { day, scope: "all", metric: `deleg:aix_as_reply:${c.scene}`, value: c.aixAsReply, n: c.aixTurns, detail: {}, source: src },
    ]);
    const { error } = await sb.from("quality_daily").upsert(out, { onConflict: "day,metric,scope" });
    console.log(error ? `書けない: ${error.message}` : `quality_daily に ${out.length}行`);
  }
}
if (require.main === module) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
