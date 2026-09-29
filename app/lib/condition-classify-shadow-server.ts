// app/lib/condition-classify-shadow-server.ts
// お客様の発言の分類（line-webhook-text の classifyConditionMessage＝Haiku・4択）の**影の運用**: 同じ入力を仮名化して Jev に聞き、
// 今の判定と並べて jev_shadow_logs に記録するだけ（本番の動きは変えない・失敗しても止めない・応答を待たせない）。
// 判定の部品は condition-classify-jev.ts（純関数）。ここは DB を引いて渡すだけ。
//
// ⚠ 個人情報: 会話の文は pii-pseudonym（createMasker）で仮名化してから渡す。申込以降（DRAFT_SKIP_STATUSES）の会話は呼ばない。
//   鍵（TYPESAFE_API_KEY）が無ければ何もしない。
import { supabase } from "@/app/lib/supabase";
import { isJevEnabled } from "@/app/lib/jev-client";
import { isPostApplyStatus } from "@/app/lib/llm-alt-provider";
import { createMasker } from "@/app/lib/pii-pseudonym";
import { loadKnownCustomerNames } from "@/app/lib/pii-known-names";
import { evaluateConditionClassifyWithJev, toConditionClassifyShadowRow, type CurrentConditionJudgement } from "@/app/lib/condition-classify-jev";
import { waitUntil } from "@vercel/functions";

export function shadowConditionClassify(
  conversationId: string,
  customerText: string,
  recentContext: ReadonlyArray<{ sender: string; text: string }>,
  current: CurrentConditionJudgement,
): void {
  if (!isJevEnabled() || !conversationId || !customerText.trim()) return;
  const job = (async () => {
    try {
      const [{ data: conv }, names] = await Promise.all([
        supabase.from("conversations").select("status, customer_name").eq("id", conversationId).maybeSingle(),
        loadKnownCustomerNames().catch(() => [] as string[]),
      ]);
      const status = (conv?.status as string | null) ?? null;
      if (isPostApplyStatus(status)) return;   // 申込以降は渡さない
      const masker = createMasker({ conversationId, customerName: (conv?.customer_name as string | null) ?? null, knownNames: names });
      const ev = await evaluateConditionClassifyWithJev({
        customerText: masker.mask(customerText),
        recentContext: recentContext.map((m) => ({ sender: m.sender, text: masker.mask(m.text) })),
        conversationId, timeoutMs: 5_000,
      });
      if (!ev) return;
      // 今回の発言の時刻（答え合わせで messages と結ぶ）。取れなければ null
      const { data: last } = await supabase.from("messages").select("created_at").eq("conversation_id", conversationId).eq("sender", "customer")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      const row = toConditionClassifyShadowRow(conversationId, (last?.created_at as string | null) ?? null, current, ev);
      const { error } = await supabase.from("jev_shadow_logs").insert(row);
      if (error) console.warn("[classify-jev] 記録できない:", error.message);
      console.log(JSON.stringify({ tag: "classify:jev", conversationId, current: current.type, source: current.source, jev: ev.decision.type, p: Number(ev.decision.prob.toFixed(2)), ms: ev.raw.ms }));
    } catch (e) {
      console.warn("[classify-jev] skipped:", e instanceof Error ? e.message : String(e));
    }
  })();
  try { waitUntil(job); } catch { /* Vercel 以外 */ }
}
