// scripts/brain-manuals-weekly-dry.ts — 取扱説明書の毎週の書き直しを、手元で書かずに1回流して「書く行の計画」を見る（作業員1・11/04・読むだけ・LLM なし）
//   本番の cron（/api/cron/brain-manuals-weekly?dry=1）は CRON_SECRET が要る＝PC からは呼ばない。同じ関数 runBrainManualsWeekly を apply=false で回す。
//   brain_manuals の今の行は RLS で公開キーでは読めない → --existing=<json>（MCP の軽い読みで写した物）を渡す。DB には書かない。
// 実行: npx tsx --env-file=.env.local scripts/brain-manuals-weekly-dry.ts --existing=<json> [--days=30]
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { runBrainManualsWeekly } from "../app/lib/brain-manuals-weekly-server";
import type { ExistingRow } from "../app/lib/brain-manuals-weekly";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
(async () => {
  const existing = JSON.parse(readFileSync(arg("existing"), "utf8")) as ExistingRow[];
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
  const r = await runBrainManualsWeekly(sb, { days: Number(arg("days", "30")), apply: false, existing });
  console.log(`番 ${r.turns}・書く ${r.written}（apply=false）`);
  for (const [b, v] of Object.entries(r.stats)) console.log(`- ${b}: 竹内さんの番 ${v.takeuchi.hit}/${v.takeuchi.n}・従業員（参考） ${v.employee.hit}/${v.employee.n}`);
  console.log("\n## 書く行の計画（本文の1行目＝新しく頭に足す本番の数の行）");
  for (const x of r.rows) console.log(`### ${x.brain}.${x.item}\n${x.body}\n`);
})().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
