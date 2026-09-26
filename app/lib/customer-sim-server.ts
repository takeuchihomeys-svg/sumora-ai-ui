// app/lib/customer-sim-server.ts
// お客様役（テスト・YUMA 専用）のサーバー側: 会話を読んで DeepSeek にお客様の次の返事を書かせる／webhook と同じ関数で会話に入れる。
//   鍵は呼ぶ側（app/api/test/customer-sim/route.ts）が customer-sim-guard.checkCustomerSimAccess で確かめてから呼ぶ。
//   ここでも入れる直前にテスト用の会話かをもう一度見る（二重の歯止め）。
import { supabase } from "@/app/lib/supabase";
import { isTestConversation } from "@/app/lib/test-conversations";
import { newSimLineMessageId } from "@/app/lib/customer-sim-guard";
import { ACCOUNTS, handleTextMessage } from "@/app/lib/line-webhook-text";
import { callDeepSeek } from "@/app/lib/vision-alt-provider";
import { loadDeepseekCutoff, filterAfterCutoff, cutoffMs } from "@/app/lib/post-apply";
import {
  CUSTOMER_SIM_SYSTEM, buildCustomerSimUser, parseCustomerSimReply, type SimScenario, type SimCursor, type SimHistoryItem,
} from "@/app/lib/customer-sim";

/** お客様役の DeepSeek（推論なし・短い返事）。model は既定（VISION_ALT_MODEL / deepseek の既定） */
const SIM_MAX_TOKENS = 300;

export type SimGenerated = {
  text: string;
  goalReached: boolean;
  source: "fixed" | "deepseek";
  usage: { input: number; output: number; cacheHit: number; model: string } | null;
};

function jstNowLabel(now = new Date()): string {
  const j = new Date(now.getTime() + 9 * 3600_000);
  const wd = "日月火水木金土"[j.getUTCDay()];
  return `${j.getUTCMonth() + 1}/${j.getUTCDate()}（${wd}）${String(j.getUTCHours()).padStart(2, "0")}:${String(j.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * 筋書きの今の段のお客様の返事を作る。fixed の段は DeepSeek を呼ばない。
 *   申込中（DeepSeek に渡さない線の内側）の会話は DeepSeek を呼ばずに例外（固定文の段か text を直接渡す）。
 */
export async function generateCustomerReply(conversationId: string, scenario: SimScenario, cursor: SimCursor): Promise<SimGenerated> {
  const step = scenario.steps[cursor.stepIndex];
  if (!step) throw new Error("筋書きは終わっています");
  if (step.fixed && cursor.turnsOnStep === 0) return { text: step.fixed, goalReached: true, source: "fixed", usage: null };

  const cutoff = await loadDeepseekCutoff(supabase, conversationId);
  if (cutoffMs(cutoff) === null) throw new Error("申込中の会話は DeepSeek に渡さない（固定文の段か text を直接渡してください）");

  const [{ data: msgs, error: mErr }, { data: props }, { data: facts }] = await Promise.all([
    supabase.from("messages").select("sender, text, is_aix_generated, image_url, created_at")
      .eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(24),
    supabase.from("sent_properties").select("property_name, room_no, sent_at")
      .eq("conversation_id", conversationId).order("sent_at", { ascending: false }).limit(10),
    supabase.from("sent_facts").select("kind, sent_at")
      .eq("conversation_id", conversationId).eq("kind", "estimate_sent").order("sent_at", { ascending: false }).limit(1),
  ]);
  if (mErr) throw new Error(`会話を読めませんでした: ${mErr.message}`);
  const history: SimHistoryItem[] = filterAfterCutoff(
    ((msgs ?? []) as Array<{ sender: string; text: string | null; is_aix_generated: boolean | null; image_url: string | null; created_at: string }>).reverse(),
    (m) => m.created_at, cutoff,
  ).map((m) => ({ sender: m.sender, text: m.text, isAix: m.is_aix_generated, hasImage: !!m.image_url, createdAt: m.created_at }));
  const propNames = filterAfterCutoff((props ?? []) as Array<{ property_name: string; room_no: string | null; sent_at: string }>, (p) => p.sent_at, cutoff)
    .map((p) => `${p.property_name}${p.room_no ? ` ${p.room_no}` : ""}`);
  const estimateSent = filterAfterCutoff((facts ?? []) as Array<{ sent_at: string }>, (f) => f.sent_at, cutoff).length > 0;

  const user = buildCustomerSimUser({ scenario, cursor, history, sentPropertyNames: propNames, estimateSent, nowLabel: jstNowLabel() });
  const t0 = Date.now();
  // 1回で読めなければ同じ前置きで1回だけ読み直す（Claude には倒さない）
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await callDeepSeek(CUSTOMER_SIM_SYSTEM, user, { maxTokens: SIM_MAX_TOKENS, timeoutMs: 30_000, thinking: false, temperature: 0.8 });
    recordSimUsage(conversationId, res, Date.now() - t0, attempt > 0);
    const parsed = parseCustomerSimReply(res?.text ?? null);
    if (parsed) {
      return {
        text: parsed.text, goalReached: parsed.goalReached, source: "deepseek",
        usage: res ? { input: res.usage.input, output: res.usage.output, cacheHit: res.usage.cacheHit, model: res.model } : null,
      };
    }
  }
  throw new Error("DeepSeek がお客様の返事を返しませんでした（2回）");
}

function recordSimUsage(conversationId: string, res: Awaited<ReturnType<typeof callDeepSeek>>, ms: number, retry: boolean): void {
  void import("@/app/lib/llm-usage-recorder").then(({ recordAltUsage }) => recordAltUsage({
    model: res?.model ?? "deepseek", action: "customer_sim", conversationId,
    usage: { input_tokens: Math.max(0, (res?.usage.input ?? 0) - (res?.usage.cacheHit ?? 0)), output_tokens: res?.usage.output ?? 0, cache_read_input_tokens: res?.usage.cacheHit ?? 0 },
    status: res ? 200 : 0, errorType: res ? null : "no_response", durationMs: ms,
    sysHead: `【お客様役（テスト）${retry ? "・読み直し" : ""}】`, sysKeyFull: null, maxTokens: SIM_MAX_TOKENS,
  })).catch(() => {});
}

/**
 * お客様の発言として会話に入れる（webhook の文字の発言と同じ関数・署名の確認だけ無い）。
 *   line_message_id は "sim-<uuid>"（お客様役の印）。LINE には何も送らない（お客様の発言は LINE を通らない）。
 */
export async function injectCustomerMessage(conversationId: string, text: string): Promise<{ ok: boolean; lineMessageId: string; messageId: string | null }> {
  if (!isTestConversation(conversationId)) throw new Error("テスト用の会話ではありません");
  const body = String(text ?? "").trim();
  if (!body) throw new Error("text が空です");
  const { data: conv, error } = await supabase.from("conversations").select("id, line_user_id, account").eq("id", conversationId).maybeSingle();
  if (error || !conv?.line_user_id) throw new Error(`会話を読めませんでした: ${error?.message ?? "line_user_id なし"}`);
  const account = ACCOUNTS.find((a) => a.key === (conv.account as string | null ?? "sumora"));
  if (!account) throw new Error(`アカウントが分かりません: ${conv.account}`);
  // 入れる前に: webhook の関数は line_user_id＋アカウントで会話を引く。同じ組の会話がこの1件だけであること（別の会話に入れない）
  const { data: same } = await supabase.from("conversations").select("id").eq("line_user_id", String(conv.line_user_id)).eq("account", account.key).limit(2);
  if ((same ?? []).length !== 1 || String(same![0].id) !== conversationId) throw new Error("同じ LINE の id の会話が1件に決まりません（入れずに止めました）");
  const lineMessageId = newSimLineMessageId();
  const ok = await handleTextMessage(String(conv.line_user_id), body, account, lineMessageId);
  const { data: row } = await supabase.from("messages").select("id, conversation_id").eq("line_message_id", lineMessageId).maybeSingle();
  // 同じ LINE の id で別の会話に入っていないか（ensureConversation は line_user_id＋アカウントで引く）
  if (row && String(row.conversation_id) !== conversationId) throw new Error(`別の会話に入りました: ${row.conversation_id}`);
  return { ok, lineMessageId, messageId: (row?.id as string | undefined) ?? null };
}
