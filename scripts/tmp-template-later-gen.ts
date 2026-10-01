// tmp(コミットしない・2026-10-01): テンプレート一覧を「AIX を送った直後でない」状態で開いて ✨ を押した時の body（TemplateModal.handleAixContextGenerate と同じ組み方）を YUMA の会話で組み、生成だけ回す（送らない）
// 実行: SIM_BASE=http://localhost:3200 npx tsx --env-file=.env.local scripts/tmp-template-later-gen.ts --n=3 [--cta=viewing|apply]
import { createClient } from "@supabase/supabase-js";
import { resolveTemplateSentMessage } from "../app/lib/aix-template-source";
import { findAiPhrases } from "../app/lib/second-message-style";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const PC = "509cd061-60cc-49a9-8c5a-4f356c4a5f88";
const BASE = process.env.SIM_BASE ?? "http://localhost:3200";
const args = process.argv.slice(2);
const N = Number(args.find((a) => a.startsWith("--n="))?.slice(4) ?? "3");
const CTA = args.find((a) => a.startsWith("--cta="))?.slice(6) ?? null;
async function main() {
  const { data: conv } = await sb.from("conversations").select("customer_name, status").eq("id", Y).single();
  const c = conv as { customer_name: string; status: string };
  const { data: pc } = await sb.from("property_customers").select("conditions, ai_summary").eq("id", PC).maybeSingle();
  const { data: ms } = await sb.from("messages").select("sender, text, created_at, is_aix_generated, image_url").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(60);
  // 画面の recentMessages と同じ形（古い順・isAix）
  const recent = ((ms ?? []) as Array<Record<string, unknown>>).reverse().map((m) => ({ sender: String(m.sender), text: String(m.text ?? ""), imageUrl: (m.image_url as string | null) ?? undefined, rawCreatedAt: String(m.created_at), isAix: !!m.is_aix_generated }));
  // 画面: postAixContext なし（下のメニューから後で開いた）
  const src = resolveTemplateSentMessage({ actionType: "property_recommendation", postAixSent: null, recent });
  console.log(`補った1通目（${src.source}）:\n${src.text}\n`);
  for (let i = 0; i < N; i++) {
    const body = {
      actionType: "property_recommendation", actionCategory: "物件オススメ【AIX】", conversationId: Y, customerName: c.customer_name, conversationState: c.status,
      recentMessages: recent.slice(-15), customerConditions: (pc as { conditions?: string } | null)?.conditions ?? "", customerSummary: (pc as { ai_summary?: string } | null)?.ai_summary ?? null,
      noEmoji: false, pendingScheduledMessages: [], staffMessagedToday: true, pickupType: null, lastAixCheckPattern: null,
      sentMessage: src.text, sentMessageSource: src.source, ctaPreference: CTA,
    };
    const r = await fetch(`${BASE}/api/aix-template-generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(150_000) });
    const j = await r.json().catch(() => ({})) as { text?: string; error?: string };
    const t = j.text ?? "";
    console.log(`[later${CTA ? `-${CTA}` : ""}-${i + 1}]${j.error ? ` ERROR:${j.error}` : ""}\n${t}\n   → ${findAiPhrases(t).map((h) => h.key).join(",") || "AI語なし"}・浅く・${/浅く・/.test(t) ? "あり⚠" : "なし"}・${t.length}字\n`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
