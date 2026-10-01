// scripts/audit-aix-json-residue.ts
// 2026-10-02 ⑫: AIX の文に JSON の名残（"キー":"・","キー"・末尾の "}）が入って送られた通が本番にあるか・
//   出口 joinAixJsonParts が普通の文（人の文・AIX の文）を書き換えないか（JSON の形が無い文はそのまま）を数える。読むだけ・LLM なし。
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-json-residue.ts [--days=180]
import { createClient } from "@supabase/supabase-js";
import { joinAixJsonParts, JSON_RESIDUE_RE } from "../app/lib/aix-json-parts";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=180").slice(7));
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  let n = 0, residue = 0, changed = 0;
  for (let f = 0; f < 600_000; f += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, text, created_at, is_aix_generated").eq("sender", "staff").gte("created_at", since).order("created_at").range(f, f + 999);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ conversation_id: string; text: string | null; created_at: string; is_aix_generated: boolean | null }>) {
      const t = r.text ?? "";
      if (!t.trim()) continue;
      n++;
      if (JSON_RESIDUE_RE.test(t)) { residue++; console.log(`名残 ${r.conversation_id.slice(0, 8)} ${r.created_at.slice(0, 10)} ${r.is_aix_generated ? "AIX" : "手"} ${JSON.stringify(t).slice(0, 160)}`); }
      if (joinAixJsonParts(t, ["a"]).text !== t) changed++;
    }
    if ((data ?? []).length < 1000) break;
  }
  console.log(`\nスタッフの送信 ${n}通・JSON の名残 ${residue}・出口に通すと変わる ${changed}`);
})();
