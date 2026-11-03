// scripts/lib/aix-eval-common.ts — AIX の統括の試し・竹内さんの AIX の読み解きで共通の道具（その番の時刻までの状況のまとめ・DeepSeek の JSON 呼び出し・伏せ）
// 2026-11-03 作業員1: scripts/aix-desk-eval.ts から切り出した（同じ物を2か所に持たない）
import { createClient } from "@supabase/supabase-js";
import { piiValueSignal } from "../../app/lib/test-pii-guard";
import { maskExamText } from "./brain-exam-mask";
export const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
export async function situationText(conversationId: string, asOf: string, convStatus: string | null, turnText: string): Promise<string> {
  try {
    const { resolveCustomerState } = await import("../../app/lib/customer-state");
    const { buildActionLedger } = await import("../../app/lib/action-ledger");
    const { buildPromiseQueue } = await import("../../app/lib/promise-queue");
    const { itemsFromLedger, bindReaction, explainedItemsOf } = await import("../../app/lib/sent-ledger-bind");
    const { buildSituationSummary, withTurnBrought } = await import("../../app/lib/situation-summary");
    const { broughtThisTurnNames } = await import("../../app/lib/aix-commander");
    const nowMs = Date.parse(asOf);
    const [msgs, aix, facts, vh, sp, tasks] = await Promise.all([
      sb.from("messages").select("sender, text, created_at, is_aix_generated, line_message_id").eq("conversation_id", conversationId).lte("created_at", asOf).order("created_at", { ascending: false }).limit(300),
      sb.from("aix_usage_logs").select("aix_type, check_pattern, created_at, sent_at, line_message_id, generated_text, property_names, prop_statuses, estimate_sent, template_name").eq("conversation_id", conversationId).lte("created_at", asOf).order("created_at", { ascending: false }).limit(200),
      sb.from("sent_facts").select("sent_at, origin, aix_type, kind, status, line_message_id, detail, evidence").eq("conversation_id", conversationId).lte("sent_at", asOf).order("sent_at", { ascending: false }).limit(300),
      sb.from("viewing_history").select("scheduled_date, scheduled_time, status, property_name, actual_date, viewing_report, created_at").eq("conversation_id", conversationId).lte("created_at", asOf),
      sb.from("sent_properties").select("property_name, room_no, sent_at").eq("conversation_id", conversationId).lte("sent_at", asOf).order("sent_at", { ascending: false }).limit(300),
      sb.from("line_tasks").select("task_type, status, created_at, resolved_at, result").eq("conversation_id", conversationId).lte("created_at", asOf).order("created_at", { ascending: false }).limit(30),
    ]);
    const m2 = ((msgs.data ?? []) as Array<{ sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; line_message_id: string | null }>).reverse();
    const messages = m2.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: !!m.is_aix_generated, lineMessageId: m.line_message_id }));
    const aixRows = ((aix.data ?? []) as any[]).reverse();
    const recordedFacts = ((facts.data ?? []) as any[]).reverse();
    const lineTasks = ((tasks.data ?? []) as any[]).map((t) => ({ task_type: t.task_type, status: t.status, created_at: t.created_at, completed_at: t.resolved_at, result: t.result }));
    const lastCustomerAt = [...messages].reverse().find((m) => m.sender === "customer")?.createdAt ?? null;
    const ledger = buildActionLedger({ recentAixRows: aixRows.filter((r: any) => !!r.aix_type), messages: messages.map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.createdAt, isAix: m.isAix, lineMessageId: m.lineMessageId })), lineTasks, lastCustomerAt, now: nowMs, recordedFacts } as any);
    const state = resolveCustomerState({ now: nowMs, status: convStatus, messages, aixRows, recordedFacts, lineTasks, viewingHistory: (vh.data ?? []) as any, sentProperties: ((sp.data ?? []) as any[]).reverse(), ledger } as any);
    const promises = buildPromiseQueue(messages.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.createdAt, isAix: m.isAix })), aixRows.map((l: any) => ({ aixType: l.aix_type, checkPattern: l.check_pattern, sentAt: l.sent_at ?? l.created_at, estimateSent: l.estimate_sent, text: l.generated_text })), nowMs);
    const staffItems = messages.filter((m) => m.sender !== "customer" && (m.text ?? "").trim()).slice(-10).flatMap((m) => explainedItemsOf(m.text ?? "", m.createdAt, m.lineMessageId));
    const bind = bindReaction({ customerText: turnText, items: [...itemsFromLedger(ledger.entries as any), ...staffItems], nowMs });
    const sum = withTurnBrought(buildSituationSummary({ state, promises, emotion: null, bind, pickupReady: null, nowMs }), broughtThisTurnNames(turnText));
    const nf = sum.nowFulfillable;
    const j = (a: string[]) => (a.length ? a.slice(0, 6).join("・") : "なし");
    return [
      `【状況のまとめ（この番の時点の記録だけ）】段階: ${sum.stageLabel}`,
      `まだ果たしていない約束: ${sum.openPromises.length ? sum.openPromises.slice(0, 5).map((p) => `${p.kind}${p.object ? `（${p.object}）` : ""}`).join("・") : "なし"}`,
      `今すぐ果たせる物: 募集中と確認済み=${j(nf.confirmed)}／見積を作れる=${j(nf.estimateReady)}／見積を送った=${j(nf.estimated)}／まだ確認が要る=${j(nf.needCheck)}`,
      `今の発言が指す送った事: ${sum.bind ? `${sum.bind.kind}${sum.bind.name ? `（${sum.bind.name}）` : ""}${sum.bind.topic ? `・${sum.bind.topic}` : ""}` : "不明"}`,
    ].join("\n");
  } catch (e) { console.warn(`  状況のまとめ失敗: ${e instanceof Error ? e.message : e}`); return ""; }
}

export const cost = { usd: 0, calls: 0, fail: 0, hit: 0, miss: 0 };
export async function deepseekJson(sys: string, user: string, maxTokens = 600): Promise<Record<string, unknown> | null> {
  const key = process.env.DEEPSEEK_API_KEY ?? process.env.LLM_ALT_DEEPSEEK_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY が無い");
  const { DEEPSEEK_ENDPOINT, DEEPSEEK_DEFAULT_MODEL } = await import("../../app/lib/llm-alt-provider");
  const { altPriceOf, isDeepseekPeakAt } = await import("../../app/lib/llm-price");
  if (piiValueSignal(user)) { cost.fail++; return null; }
  const model = process.env.DEEPSEEK_MODEL ?? DEEPSEEK_DEFAULT_MODEL;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(DEEPSEEK_ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: user }], temperature: 0, max_tokens: maxTokens, response_format: { type: "json_object" }, thinking: { type: "disabled" } }),
        signal: AbortSignal.timeout(120_000),
      });
      const j = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens?: number } };
      if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
      const pr = altPriceOf(model);
      if (pr && j.usage) cost.usd += (((j.usage.prompt_cache_miss_tokens ?? 0) * pr.in + (j.usage.prompt_cache_hit_tokens ?? 0) * pr.read + (j.usage.completion_tokens ?? 0) * pr.out) / 1e6) * (pr.peakDouble && isDeepseekPeakAt(new Date()) ? 2 : 1);
      cost.calls++; cost.hit += j.usage?.prompt_cache_hit_tokens ?? 0; cost.miss += j.usage?.prompt_cache_miss_tokens ?? 0;
      return JSON.parse(String(j.choices?.[0]?.message?.content ?? "{}")) as Record<string, unknown>;
    } catch (e) { if (attempt === 1) { cost.fail++; console.warn(`  失敗: ${e instanceof Error ? e.message : e}`); } }
  }
  return null;
}

export function maskForLlm(text: string, names: string[]): string {
  return maskExamText(text, null, names)
    .replace(/https?:\/\/\S+/g, "［URL］")
    .replace(/[0-9０-９]{2,4}\s*号室/g, "［号室］")
    .replace(/\[(画像|動画|ファイル)\][^\n]{60,}/g, (m) => m.slice(0, 80));
}

