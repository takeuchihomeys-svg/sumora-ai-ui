// scripts/audit-check-result-name-guard.ts — CHECK_RESULT_NAME_GUARD の網（会話の文から物件名を拾う）を本番の物件確認した の番に当てる（読むだけ・LLM なし）
//   ①拾った名前が物件名か（目で読む・ランダム40）②下書き（aix_generate_log）に「前のやり取りの別の物件名」が出た番の数
//   ③CHECK_REQUEST_FOCUS の頼まれた事を拾った番（目で読む）
// 実行: npx tsx --env-file=.env.local scripts/audit-check-result-name-guard.ts [--days=60]
import { createClient } from "@supabase/supabase-js";
import { propertyNamesInTexts, buildingCore } from "../app/lib/check-result-name-guard";
import { checkRequestFocus } from "../app/lib/check-request-focus";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const days = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "60");
(async () => {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data: gens } = await sb.from("aix_generate_log").select("conversation_id, generated_at, generated_text, conditions_snapshot")
    .eq("action_type", "property_check_result").gte("generated_at", since).order("generated_at", { ascending: false }).limit(400);
  const all = new Map<string, number>();
  let n = 0, otherInDraft = 0;
  const hits: string[] = [];
  const focusHits: string[] = [];
  for (const g of (gens ?? []) as Array<{ conversation_id: string; generated_at: string; generated_text: string | null; conditions_snapshot: Record<string, unknown> | null }>) {
    if ((g.conditions_snapshot as { source?: string } | null)?.source === "aix-template-generate") continue;
    const { data: ms } = await sb.from("messages").select("text, created_at, sender").eq("conversation_id", g.conversation_id).lt("created_at", g.generated_at).order("created_at", { ascending: false }).limit(15);
    const rows = ((ms ?? []) as Array<{ text: string | null; sender: string }>).reverse();
    const hist = rows.map((m) => m.text);
    const fc = checkRequestFocus(rows);
    if (fc.keys.length) focusHits.push(`${g.generated_at.slice(0, 16)} ${fc.keys.join("・")}｜${fc.quote ?? "-"}｜${fc.promise ?? "-"}`);
    const names = propertyNamesInTexts(hist);
    for (const x of names) all.set(x, (all.get(x) ?? 0) + 1);
    n++;
    const pn = ((g.conditions_snapshot as { property_names?: string[] } | null)?.property_names ?? []).map(buildingCore);
    const lastCustShare = hist.length;
    const draft = String(g.generated_text ?? "");
    const other = names.filter((x) => !pn.some((p) => p && (p.includes(buildingCore(x)) || buildingCore(x).includes(p))) && draft.includes(x.replace(/\s*[0-9]+号室$/, "")));
    if (other.length && !pn.length) { otherInDraft++; hits.push(`${g.generated_at.slice(0, 16)} ${g.conversation_id.slice(0, 6)}: 入力の名前なし・下書きに履歴の名前 ${other.join("／")}`); }
    void lastCustShare;
  }
  console.log(`番 ${n}・拾った名前 ${all.size}種類`);
  console.log([...all.keys()].sort(() => Math.random() - 0.5).slice(0, 40).join("\n"));
  console.log(`\n入力に物件名が無いのに下書きが履歴の物件名を書いた番（候補・目で読む）: ${otherInDraft}`);
  for (const h of hits.slice(0, 20)) console.log("  " + h);
  console.log(`
頼まれた事を拾った番: ${focusHits.length}/${n}`);
  for (const h of focusHits.slice(0, 25)) console.log("  " + h);
})();
