// scripts/audit-aix-edit-count-mask.ts — #839 数えるためだけに残した物件オススメの直しの組（source=aix_edit_count）の伏せ方の確かめ（読むだけ・軽い・LLM なし・2026-11-28 作業員A）
//   統括役 11/28: AIX_EDIT_COUNT_RECOMMENDATION を on にしたら、最初の数行をこれで確かめてから続ける。
//   行の本文は出さない。伏せ残しの形（個人の値・物件名・号室・金額・URL・申込の書類の欄・名前らしい語）の当たりを、行ごとの数と合計だけ出す。
//   実行: npx tsx --env-file=.env.local scripts/audit-aix-edit-count-mask.ts [--limit=20] [--days=7]
import { createClient } from "@supabase/supabase-js";
import { AIX_EDIT_COUNT_SOURCE, residueOf } from "../app/lib/aix-edit-count";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "", { auth: { persistSession: false } });

(async () => {
  const limit = Number(arg("limit", "20")), days = Number(arg("days", "7"));
  const { data, error } = await sb.from("ai_template_candidates").select("id, template_text, original_text, created_at")
    .eq("source", AIX_EDIT_COUNT_SOURCE).gte("created_at", new Date(Date.now() - days * 86_400_000).toISOString())
    .order("created_at", { ascending: true }).limit(limit);
  if (error) throw error;
  const rows = data ?? [];
  const total: Record<string, number> = {};
  let clean = 0;
  for (const r of rows) {
    const hits = [...new Set([...residueOf(String(r.template_text ?? "")), ...residueOf(String(r.original_text ?? ""))])];
    for (const h of hits) total[h] = (total[h] ?? 0) + 1;
    if (!hits.length) clean++;
    console.log(`- ${String(r.id).slice(0, 8)} ${String(r.created_at).slice(0, 16)}: ${hits.length ? `残り ${hits.join("・")}` : "残りなし"}`);
  }
  console.log(`\n### 伏せ方の確かめ（${days}日・${rows.length}行）: 残りなし ${clean}/${rows.length}${Object.keys(total).length ? `・形ごと ${Object.entries(total).map(([k, n]) => `${k} ${n}`).join("・")}` : ""}`);
  if (rows.length && clean < rows.length) console.log("→ 残りがある＝AIX_EDIT_COUNT_RECOMMENDATION を off に戻し、aix-edit-count.ts の伏せ方を直してから続ける");
})().catch((e) => { console.error(e); process.exit(1); });
