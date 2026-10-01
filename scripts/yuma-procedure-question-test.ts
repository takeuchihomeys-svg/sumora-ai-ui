// YUMA で「手続きの質問」（みこと 9/30 の実物の文）を1回通す: ブレインの判断（保存しない）＋返信の下書き（generate-reply を直接・本文は DeepSeek）
//   お客様の発言を YUMA の messages に1通入れ、終わったら消す（conversations は触らない＝AIX要対応・通知なし）
// 実行: BASE_URL=http://localhost:3137 npx tsx --env-file=.env.local scripts/yuma-procedure-question-test.ts [MSG=...]
import { createClient } from "@supabase/supabase-js";
// 2026-10-01 共通の入口（scripts/lib/llm-test-harness.ts）の後にブレインを読む（静的 import だと包む前の fetch を握り Claude が記録0）。
//   起動の印: LLM_TEST_MODE=deepseek-all（試行錯誤）か LLM_TEST_FINAL_CLAUDE=1（最後の確かめ）。手順書 memory/test_protocol_brain.md
import { setupLlmTest, type LlmTestHarness } from "./lib/llm-test-harness";
let h: LlmTestHarness | null = null;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3137";
const MSG = process.env.MSG ?? "よろしくお願いします。\n本人確認書類がマイナンバー、パスポート両方あるのですが審査通るまでどのくらいの期間見といたらいいですか？";

async function main() {
  h = await setupLlmTest("yuma-procedure-question-test");
  const { analyzeConversation } = await import("../app/lib/brain-core");
  const { getCustomerState } = await import("../app/lib/customer-state-server");
  const { data: c } = await sb.from("conversations").select("status, customer_name, has_viewed, brain_strategy, conversation_direction").eq("id", Y).maybeSingle();
  const cc = (c ?? {}) as Record<string, unknown>;
  const st = await getCustomerState(Y);
  const focus = st?.focusKey ? st.properties.find((p) => p.key === st.focusKey) : null;
  console.log(`YUMA [${cc.status}] 主のお部屋: ${focus ? `${focus.name}（${focus.statusLabel}）` : "なし"}`);
  const { data: ins, error } = await sb.from("messages").insert({ conversation_id: Y, sender: "customer", text: MSG }).select("id, created_at").single();
  if (error || !ins) throw new Error(`入れられない: ${error?.message}`);
  try {
    const strategy = (cc.brain_strategy ?? null) as never;
    const prevDir = (cc.conversation_direction ?? null) as Record<string, unknown> | null;
    const meta = await analyzeConversation(Y, true, String(cc.status ?? "proposing"), null, "brain", {
      autoSendEnabled: false, customerName: "YUMA",
      prevPhase: typeof prevDir?.current_phase === "string" ? prevDir.current_phase : null,
      prevAix: typeof prevDir?.suggested_aix_button === "string" ? prevDir.suggested_aix_button : null,
      mode: strategy ? "incremental" : "full", layer: strategy ? "fresh" : "combined", strategy: strategy ?? null,
    }) as Record<string, unknown> | null;
    console.log("\n【ブレイン】", JSON.stringify({ action: meta?.action, check_pattern: meta?.check_pattern, reply_mode: meta?.reply_mode, two_choice_mode: meta?.two_choice_mode, reply_direction_label: meta?.reply_direction_label, decision_source: meta?.decision_source, template_hint: meta?.template_hint }, null, 1));
    console.log("  帯:", meta?.note);
    console.log("  方向:", meta?.reply_direction);
    console.log("  必須:", JSON.stringify(meta?.key_topics), " 禁止:", JSON.stringify(meta?.avoid_topics));
    if (process.env.NO_GEN === "1") return;
    const { data: msgs } = await sb.from("messages").select("sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(20);
    const recentMessages = ((msgs ?? []) as Array<Record<string, unknown>>).reverse().map((m) => ({ sender: String(m.sender), text: String(m.text ?? ""), imageUrl: (m.image_url as string | null) ?? undefined, createdAt: String(m.created_at), isAix: !!m.is_aix_generated }));
    const t0 = new Date().toISOString();
    const res = await fetch(`${BASE}/api/generate-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      message: MSG, customerMessages: [MSG], state: String(cc.status ?? "proposing"), conversationId: Y, customerName: String(cc.customer_name ?? "YUMA"),
      hasViewed: !!cc.has_viewed, activeTaskTypes: [], recentMessages, brainMeta: meta ?? undefined,
    }) });
    const raw = await res.text(); const nl = raw.indexOf("\n");
    const draft = (nl >= 0 ? raw.slice(nl + 1) : raw).replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
    console.log(`\n【下書き】（HTTP ${res.status}）\n${draft}`);
    const { data: logs } = await sb.from("llm_usage_logs").select("action, model, env").eq("conversation_id", Y).gte("created_at", t0).order("created_at");
    console.log("\n【llm_usage_logs】", ((logs ?? []) as Array<Record<string, unknown>>).map((l) => `${l.action}:${l.model}`).join(" / "));
  } finally {
    await sb.from("messages").delete().eq("id", (ins as { id: string }).id);
    console.log("\n片付け: 入れた発言を消した");
    if (h) await h.finish().catch((e) => console.warn("finish:", String(e)));
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
