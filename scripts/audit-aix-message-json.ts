// scripts/audit-aix-message-json.ts
// readAixMessageJson（app/lib/aix-message-json.ts）を保存済みの AIX の文に当てて、変わる文を数える（読むだけ・LLM なし・費用0）。
//   保存済みの文は LLM の生の出力ではなく読み取りの後の文＝普通の文は1つも変わってはいけない（変わるのは JSON の名残がある文だけのはず）。
// 2026-10-06 ⑰
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-message-json.ts [--days=180]
import { createClient } from "@supabase/supabase-js";
import { readAixMessageJson } from "../app/lib/aix-message-json";
import { JSON_RESIDUE_RE } from "../app/lib/aix-json-parts";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "180"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = Record<string, any>;
async function all(table: string, cols: string, since: string): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < 200; p++) {
    const { data, error } = await sb.from(table).select(cols).gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out = out.concat(data as unknown as Row[]);
    if (data.length < 1000) break;
  }
  return out;
}
(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const sets: Array<[string, string[]]> = [];
  const ex = await all("ai_reply_examples", "ai_draft, sent_reply, entry_source", since);
  sets.push(["ai_reply_examples.ai_draft（AIX）", ex.filter((r) => String(r.entry_source ?? "").startsWith("aix")).map((r) => String(r.ai_draft ?? "")).filter(Boolean)]);
  sets.push(["ai_reply_examples.sent_reply（全部）", ex.map((r) => String(r.sent_reply ?? "")).filter(Boolean)]);
  const gl = await all("aix_generate_log", "generated_text", since);
  sets.push(["aix_generate_log.generated_text", gl.map((r) => String(r.generated_text ?? "")).filter(Boolean)]);
  const ul = await all("aix_usage_logs", "generated_text", since);
  sets.push(["aix_usage_logs.generated_text（送った AIX）", ul.map((r) => String(r.generated_text ?? "")).filter(Boolean)]);
  for (const [label, xs] of sets) {
    let changed = 0, residue = 0, changedWithoutResidue = 0;
    const show: string[] = [];
    for (const s of xs) {
      const hasRes = JSON_RESIDUE_RE.test(s);
      if (hasRes) residue++;
      const r = readAixMessageJson(s);
      if (r.text !== s) {
        changed++;
        if (!hasRes) { changedWithoutResidue++; if (show.length < 5) show.push(s.slice(0, 80).replace(/\n/g, "⏎")); }
      }
    }
    console.log(`${label}: ${xs.length}件・変わる ${changed}（JSON の名残あり ${residue}・名残なしで変わる ${changedWithoutResidue}）`);
    for (const x of show) console.log(`   名残なしで変わった: ${x}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
