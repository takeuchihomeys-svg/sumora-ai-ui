// scripts/audit-form-space-value.ts — condition-format の「空白で書いた値」を読む直し（2026-10-02）で、判定が変わるお客様の発言を全部出す（読むだけ・LLM なし）
// 実行: npx tsx --env-file=.env.local scripts/audit-form-space-value.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { analyzeSumoraForm, SUMORA_FORM_LABELS } from "../app/lib/condition-format";
import { isTestConversation } from "../app/lib/test-conversations";
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "365");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
// 旧の判定（空白の値を読まない）を写したもの
function oldVerdict(text: string) {
  const lines = text.trim().split("\n"); const seen = new Set<string>(); const filled = new Set<string>();
  const labelPart = (l: string) => { const b = l.indexOf("】"); if (b >= 0) return l.slice(0, b + 1); const m = l.match(/^(.*?)[⇒→=＝:：]/); return m ? m[1] : l; };
  const val = (l: string) => { const b = l.indexOf("】"); if (b >= 0) return l.slice(b + 1).replace(/^[\s⇒→=＝:：]+/, "").trim(); const m = l.match(/[⇒→=＝:：](.*)$/); return m ? m[1].trim() : ""; };
  for (let i = 0; i < lines.length; i++) {
    const key = SUMORA_FORM_LABELS.find((x) => x.re.test(labelPart(lines[i])))?.key; if (!key) continue; seen.add(key);
    let v = val(lines[i]);
    if (!v) { const n = (lines[i + 1] ?? "").trim(); if (/^[⇒→=＝:：]/.test(n) && !SUMORA_FORM_LABELS.some((x) => x.re.test(labelPart(n)))) v = n.replace(/^[\s⇒→=＝:：]+/, "").trim(); }
    if (v) filled.add(key);
  }
  return { isFilledForm: seen.size >= 3 && filled.size >= 1, filled: [...filled] };
}
async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows: Array<{ conversation_id: string; created_at: string; text: string }> = [];
  for (let i = 0; ; i += 1000) { const r = await sb.from("messages").select("conversation_id, created_at, text").eq("sender", "customer").gte("created_at", since).or("text.ilike.%入居%,text.ilike.%家賃%").order("created_at").range(i, i + 999); if (r.error) throw r.error; rows.push(...(r.data as typeof rows)); if ((r.data ?? []).length < 1000) break; }
  let changed = 0, newlyFilled = 0, more = 0;
  for (const m of rows) {
    if (isTestConversation(m.conversation_id)) continue;
    const o = oldVerdict(m.text ?? ""), n = analyzeSumoraForm(m.text ?? "");
    if (o.isFilledForm === n.isFilledForm && o.filled.length === n.filled.length) continue;
    changed++; if (!o.isFilledForm && n.isFilledForm) newlyFilled++; else more++;
    console.log(`\n--- ${m.conversation_id.slice(0, 8)} ${m.created_at.slice(0, 10)} 旧 ${o.isFilledForm}/${o.filled.length} → 新 ${n.isFilledForm}/${n.filled.join(",")}`);
    console.log((m.text ?? "").split("\n").slice(0, 10).join("\n"));
  }
  console.log(`\n対象 ${rows.length}通・変わる ${changed}（フォームと確定するようになる ${newlyFilled}・読める項目が増える ${more}）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
