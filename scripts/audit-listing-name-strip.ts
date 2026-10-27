// scripts/audit-listing-name-strip.ts — LISTING_NAME_STRIP の前後を本番の記録に当てる（読むだけ・書かない・LLM なし）
//   ① 物件名の記録（property_pickups・sent_properties）で外れる名前を全部出す
//   ② スタッフの送信（AIX の本文）の見出しの行で変わる物を全部出す
//   前後を目で読む（件数だけ見ない）。実行: npx tsx --env-file=.env.local scripts/audit-listing-name-strip.ts [--days=120]
import { supabase } from "../app/lib/supabase-server";
import { stripListingAnnotation, stripListingAnnotationInHeads } from "../app/lib/listing-name-strip";

const days = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 120);
async function pageAll<T>(q: (a: number, b: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let a = 0; ; a += 1000) {
    const { data, error } = await q(a, a + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}
(async () => {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const names = new Map<string, number>();
  for (const t of ["property_pickups", "sent_properties"] as const) {
    const rows = await pageAll<{ property_name: string | null }>((a, b) => supabase.from(t).select("property_name").or("property_name.ilike.%(%,property_name.ilike.%（%").order("id").range(a, b));
    for (const r of rows) if (r.property_name) names.set(`${t}\t${r.property_name}`, (names.get(`${t}\t${r.property_name}`) ?? 0) + 1);
  }
  let changedNames = 0, keptNames = 0;
  console.log("== ① 物件名（変わる物）");
  for (const [k, n] of [...names].sort()) {
    const [t, name] = k.split("\t");
    const after = stripListingAnnotation(name);
    if (after !== name) { changedNames++; console.log(`  ${t} ×${n}: ${name} → ${after}`); } else keptNames++;
  }
  console.log(`  かっこ付きの名前 ${changedNames + keptNames} 種類のうち 変わる ${changedNames}・残る ${keptNames}`);
  const msgs = await pageAll<{ text: string | null; created_at: string }>((a, b) => supabase.from("messages").select("text, created_at").eq("sender", "staff").gte("created_at", since)
    .or("text.ilike.%🌟%,text.ilike.%【%").order("created_at").range(a, b));
  let changedMsgs = 0;
  console.log(`\n== ② 本文の見出し（変わる物）・対象 ${msgs.length}通`);
  for (const m of msgs) {
    const r = stripListingAnnotationInHeads(m.text ?? "");
    if (!r.changed) continue;
    changedMsgs++;
    const before = (m.text ?? "").split("\n").filter((l) => /^\s*(?:🌟|【)/.test(l));
    const after = r.text.split("\n").filter((l) => /^\s*(?:🌟|【)/.test(l));
    before.forEach((l, i) => { if (l !== after[i]) console.log(`  ${m.created_at.slice(0, 16)}  ${l}\n                    → ${after[i]}`); });
  }
  console.log(`  変わる ${changedMsgs}通`);
  process.exit(0);
})();
