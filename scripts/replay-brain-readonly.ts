// scripts/replay-brain-readonly.ts
// 本番の会話の「今」のブレインの判断を、DB に書かずに取り直す（読み取りのみ・AIX要対応・カレンダー・判断ログは作らない）。
// 実行（方向が決まるまでの試し＝ブレインも DeepSeek）:
//   LLM_TEST_MODE=deepseek-all LLM_ALT_ACTIONS=reply_generate,brain_fresh,brain_full npx tsx --env-file=.env.local scripts/replay-brain-readonly.ts <conversation_id> [回数]
// 最終の確かめ（本番と同じ＝ブレインは Claude）: 先頭の2つを付けずに実行する
//
// 2026-10-01 竹内（和樹事例）: SUUMO の物件の持ち込みに 物件確認した が出るかを確かめるために作った。
//   書かないための約束: analyzeConversation だけを呼ぶ（保存は analyzeAndSaveBrainMeta の仕事）・property_customer_id を渡さない
//   （渡すと全項目の層でお客様の要約を property_customers に書く）。llm_usage_logs には使用量の記録だけが残る
import { createClient } from "@supabase/supabase-js";
// ⚠ 差し替え（DeepSeek）は brain-core を読み込む前に入れる（tsx では instrumentation.ts が動かない）
type Analyze = typeof import("../app/lib/brain-core").analyzeConversation;
async function loadBrain(): Promise<Analyze> {
  try { const { installLlmUsageRecorder } = await import("../app/lib/llm-usage-recorder"); await installLlmUsageRecorder(); } catch (e) { console.warn("usage recorder:", String(e)); }
  const { installAltProvider } = await import("../app/lib/llm-alt-provider");
  console.log(`[alt] ${installAltProvider() ? "差し替え有効" : "差し替えなし（Claude）"}`);
  return (await import("../app/lib/brain-core")).analyzeConversation;
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main() {
  const analyzeConversation = await loadBrain();
  const conv = process.argv[2];
  const times = Math.max(1, Math.min(6, Number(process.argv[3] ?? 1)));
  if (!conv) throw new Error("conversation_id を渡してください");
  const { data: c } = await sb.from("conversations").select("status, brain_strategy, conversation_direction, customer_name").eq("id", conv).maybeSingle();
  const cc = (c ?? {}) as Record<string, unknown>;
  const strategy = (cc.brain_strategy ?? null) as never;
  const prevDir = (cc.conversation_direction ?? null) as Record<string, unknown> | null;
  console.log(`test-mode=${process.env.LLM_TEST_MODE ?? "-"} alt=${process.env.LLM_ALT_ACTIONS ?? "-"} layer=${strategy ? "fresh" : "combined"}`);
  for (let i = 0; i < times; i++) {
    const meta = await analyzeConversation(conv, true, (cc.status as string) ?? "proposing", null, "brain", {
      autoSendEnabled: false, customerName: (cc.customer_name as string) ?? undefined,
      prevPhase: typeof prevDir?.current_phase === "string" ? prevDir.current_phase : null,
      prevAix: typeof prevDir?.suggested_aix_button === "string" ? prevDir.suggested_aix_button : null,
      mode: strategy ? "incremental" : "full", layer: strategy ? "fresh" : "combined", strategy: strategy ?? null,
    });
    const m = (meta ?? {}) as Record<string, unknown>;
    console.log(JSON.stringify({ run: i + 1, action: m.action ?? null, decision_source: m.decision_source ?? null, check_pattern: m.check_pattern ?? null, reply_mode: m.reply_mode ?? null, scene: (m.scene_evidence as Record<string, unknown> | undefined)?.scene ?? null, direction: String(m.reply_direction ?? "").slice(0, 120) }));
  }
  setTimeout(() => process.exit(0), 500);
}
main().catch((e) => { console.error(e); process.exit(1); });
