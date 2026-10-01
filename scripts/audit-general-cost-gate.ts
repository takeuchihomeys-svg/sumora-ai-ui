// scripts/audit-general-cost-gate.ts
// 2026-10-02 竹内「見積・空室の断言ゲートの当てすぎを直す」: 見積金額内訳ゲートの対象外にした「一般の説明」（isGeneralCostExplanation）が
//   ①人の手打ちで何文を救うか ②AI の文（AIX の生成文・下書き）の特定のお部屋の金額を取りこぼしていないか、を文ごとに出して目で読む（読むだけ・LLM なし）
// 実行: npx tsx --env-file=.env.local scripts/audit-general-cost-gate.ts [--days=90]
import { createClient } from "@supabase/supabase-js";
import { isGeneralCostExplanation } from "../app/lib/validate-reply";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "90");
const COST_GATE = (s: string) => /[0-9０-９][0-9０-９,，．.]*\s*(?:万\s*)?円/.test(s) && /(?:初期費用|敷金|礼金|仲介手数料|保証料|鍵交換|火災保険|前?家賃|管理費|共益費|日割|御見積|お見積|見積|合計|総額|内訳|割引|スモ割|節約)/.test(s);
const split = (t: string) => t.split(/\n|(?<=[。！!？?])/).map((x) => x.trim()).filter(Boolean);
async function all(table: string, sel: string, f: (q: any) => any) {
  const out: any[] = [];
  for (let p = 0; p < 30; p++) { const { data } = await f(sb.from(table).select(sel)).range(p * 1000, p * 1000 + 999); out.push(...(data ?? [])); if (!data || data.length < 1000) break; }
  return out;
}
async function main() {
  const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
  const human = await all("messages", "text", (q) => q.eq("sender", "staff").eq("is_aix_generated", false).gte("created_at", since));
  const aix = await all("aix_usage_logs", "generated_text", (q) => q.gte("created_at", since).not("generated_text", "is", null));
  const drafts = await all("ai_reply_examples", "ai_draft", (q) => q.gte("created_at", since).not("ai_draft", "is", null));
  for (const [label, texts] of [["人の手打ち", human.map((r) => r.text)], ["AIX の生成文", aix.map((r) => r.generated_text)], ["AI の下書き", drafts.map((r) => r.ai_draft)]] as const) {
    let gated = 0; const exempt: string[] = [];
    for (const t of texts) for (const s of split(String(t ?? ""))) { if (!COST_GATE(s)) continue; gated++; if (isGeneralCostExplanation(s)) exempt.push(s); }
    console.log(`\n■ ${label}: 金額＋費用の語の文 ${gated} ／ 一般の説明として対象外 ${exempt.length}`);
    for (const s of [...new Set(exempt)].slice(0, 40)) console.log(`   ${s.replace(/\s+/g, " ").slice(0, 120)}`);
  }
}
main();
