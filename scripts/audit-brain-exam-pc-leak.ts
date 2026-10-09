// scripts/audit-brain-exam-pc-leak.ts — ブレインの試験の「条件の行（pc）」が、その番より後の値（未来）になっていないかを数える（読むだけ・LLM なし・$0）
//
// 2026-10-09: brain-exam-add.ts は条件の行を「今の値」で写している（pc は作った時点の property_customers）。
//   その番より後にお客様が言った条件・スタッフの要約が pc に入っていると、ブレインは未来の材料で判断する
//   （例 q020 友だち追加だけの番なのに条件が埋まっている→フォームを送らずピックアップの約束／q070 限度額を聞く番なのに initial_cost_limit=230000）。
//   property_condition_history（変更の履歴）で、番の後に変わった列・行そのものが番の後に作られたかを数え、巻き戻した値の案も出す。
// 使い方: npx tsx --env-file=.env.local scripts/audit-brain-exam-pc-leak.ts [--out=<json>]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import type { ExamProblem } from "./brain-exam-add";

const args = process.argv.slice(2);
const OUT = args.find((a) => a.startsWith("--out="))?.slice(6) ?? "";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) ?? "");
const probs = JSON.parse(readFileSync("scripts/brain-exam/problems.json", "utf8")) as ExamProblem[];

async function main() {
  const out: Array<Record<string, unknown>> = [];
  for (const p of probs) {
    const { data: conv } = await sb.from("conversations").select("property_customer_id").eq("id", p.conv).maybeSingle();
    const pcId = (conv?.property_customer_id as string | null) ?? null;
    if (!pcId) { out.push({ id: p.id, pc: "なし" }); continue; }
    const { data: pcRow } = await sb.from("property_customers").select("created_at, updated_at").eq("id", pcId).maybeSingle();
    const { data: hist } = await sb.from("property_condition_history").select("changed_field, old_value, new_value, created_at").eq("property_customer_id", pcId).gt("created_at", p.at).order("created_at", { ascending: true });
    const after = (hist ?? []) as Array<{ changed_field: string; old_value: string | null; new_value: string | null; created_at: string }>;
    const fields = [...new Set(after.map((h) => h.changed_field))];
    // 巻き戻し: 番の後の最初の変更の old_value がその番の時点の値
    const asOf: Record<string, string | null> = {};
    for (const f of fields) asOf[f] = after.find((h) => h.changed_field === f)!.old_value;
    const createdAfter = pcRow?.created_at ? Date.parse(String(pcRow.created_at)) > Date.parse(p.at) : false;
    const lastSentAfter = p.pc?.last_property_sent_at ? Date.parse(String(p.pc.last_property_sent_at)) > Date.parse(p.at) : false;
    out.push({ id: p.id, type: p.type, createdAfter, lastSentAfter, changedAfter: fields, asOf, updatedAfter: pcRow?.updated_at ? Date.parse(String(pcRow.updated_at)) > Date.parse(p.at) : null });
  }
  const n = out.length;
  const leak = out.filter((o) => o.createdAfter || (o.changedAfter as string[] | undefined)?.length);
  const L = [`# 条件の行の未来の値（${n}問）`,
    `行そのものが番の後に作られた: ${out.filter((o) => o.createdAfter).length}`,
    `番の後に変わった列がある: ${out.filter((o) => (o.changedAfter as string[] | undefined)?.length).length}`,
    `last_property_sent_at が番の後: ${out.filter((o) => o.lastSentAfter).length}`,
    `行の updated_at が番の後: ${out.filter((o) => o.updatedAfter).length}`,
    `どれか（作成・変更）: ${leak.length}`, ""];
  for (const o of out) if (o.createdAfter || (o.changedAfter as string[] | undefined)?.length) L.push(`  ${o.id} [${o.type}] ${o.createdAfter ? "行が番の後に作成 " : ""}${(o.changedAfter as string[]).length ? `後で変わった列: ${(o.changedAfter as string[]).join(",")}` : ""}`);
  console.log(L.join("\n"));
  if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 1));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
