// app/lib/brain-researcher-server.ts（サーバー専用・DB は読むだけ・DeepSeek 1回）— 調べる係（brain-researcher.ts の決まりで呼ぶ）
//   DeepSeek に渡すのはお客様の今の連投の文（maskPII・個人の値があれば渡さない）だけ。記録の読み取りはコード。材料は記録の行そのまま。
import { supabase } from "@/app/lib/supabase";
import { maskPII } from "@/app/lib/pii-mask";
import { altPiiSignal } from "@/app/lib/alt-pii-gate";
import { loadDeepseekCutoff } from "@/app/lib/post-apply";
import { customerSharedPropertyNames } from "@/app/lib/customer-property-names";
import { pastConversationLines } from "@/app/lib/brain-deep-check";
import { RESEARCHER_SYSTEM, buildResearcherUser, parseResearcherOutput, researcherBlock, type ResearchLookup, type ResearchKind } from "@/app/lib/brain-researcher";

const jst = (iso: string | null | undefined) => (iso ? new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ") : "");

async function runLookup(conversationId: string, pcId: string | null, l: ResearchLookup, beforeIso: string): Promise<string[]> {
  switch (l.kind as ResearchKind) {
    case "sent_properties": {
      const { data } = await supabase.from("sent_properties").select("property_name, room_no, sent_at, rent, recruitment_status").eq("conversation_id", conversationId).lte("sent_at", beforeIso).order("sent_at", { ascending: false }).limit(8);
      return ((data ?? []) as Array<{ property_name: string | null; room_no: string | null; sent_at: string; rent: number | null; recruitment_status: string | null }>)
        .map((r) => `- ${jst(r.sent_at)} ${r.property_name ?? "?"}${r.room_no ? ` ${r.room_no}号室` : ""}${r.rent ? `・家賃${r.rent.toLocaleString("ja-JP")}円` : ""}${r.recruitment_status ? `・${r.recruitment_status}` : ""}`);
    }
    case "customer_shared": {
      const { data } = await supabase.from("messages").select("sender, text, created_at").eq("conversation_id", conversationId).eq("sender", "customer").lte("created_at", beforeIso).order("created_at", { ascending: false }).limit(200);
      const rows = ((data ?? []) as Array<{ sender: string; text: string | null; created_at: string }>).reverse().map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.created_at }));
      return customerSharedPropertyNames(rows, { limit: 6 }).map((c) => `- ${jst(c.at ?? null)} ${c.label || c.name}${c.url ? `（${c.url.slice(0, 60)}）` : ""}`);
    }
    case "past_lines": {
      if (!l.query) return [];
      const { data } = await supabase.from("messages").select("sender, text, created_at").eq("conversation_id", conversationId).lt("created_at", beforeIso).order("created_at", { ascending: false }).limit(400);
      const rows = ((data ?? []) as Array<{ sender: string; text: string | null; created_at: string }>).reverse();
      return pastConversationLines({ messages: rows, topics: [], beforeMs: Date.parse(beforeIso), max: 6, keywords: [l.query] });
    }
    case "conditions": {
      if (!pcId) return [];
      const { data } = await supabase.from("property_condition_history").select("changed_field, old_value, new_value, created_at").eq("property_customer_id", pcId).lte("created_at", beforeIso).order("created_at", { ascending: false }).limit(10);
      return ((data ?? []) as Array<{ changed_field: string; old_value: string | null; new_value: string | null; created_at: string }>)
        .map((r) => `- ${jst(r.created_at)} ${r.changed_field}: ${r.old_value ?? "（空）"} → ${r.new_value ?? "（空）"}`);
    }
    case "viewings": {
      const { data } = await supabase.from("viewing_history").select("property_name, scheduled_date, scheduled_time, status, created_at").eq("conversation_id", conversationId).lte("created_at", beforeIso).order("created_at", { ascending: false }).limit(5);
      return ((data ?? []) as Array<{ property_name: string | null; scheduled_date: string | null; scheduled_time: string | null; status: string | null }>)
        .map((r) => `- ${r.scheduled_date ?? "?"} ${r.scheduled_time ?? ""} ${r.property_name ?? "?"}${r.status ? `（${r.status}）` : ""}`);
    }
    case "estimates": {
      const { data } = await supabase.from("estimate_records").select("property_name, room_no, initial_cost_yen, created_at").eq("conversation_id", conversationId).lte("created_at", beforeIso).order("created_at", { ascending: false }).limit(6);
      return ((data ?? []) as Array<{ property_name: string | null; room_no: string | null; initial_cost_yen: number | null; created_at: string }>)
        .map((r) => `- ${jst(r.created_at)} ${r.property_name ?? "?"}${r.room_no ? ` ${r.room_no}号室` : ""}${r.initial_cost_yen ? `・初期費用${r.initial_cost_yen.toLocaleString("ja-JP")}円` : ""}`);
    }
  }
  return [];
}

export type ResearcherResult = { block: string; lookups: ResearchLookup[]; ms: number; skipped?: string };

/** お客様の今の連投（customerText）が指す物の記録を取ってくる。止まった・読めない・渡せない時は block="" */
export async function researchVagueReference(o: { conversationId: string; customerText: string; customerName?: string | null; propertyCustomerId?: string | null; turnAtIso?: string | null; budgetMs?: number }): Promise<ResearcherResult> {
  const t0 = Date.now();
  const skip = (why: string): ResearcherResult => ({ block: "", lookups: [], ms: Date.now() - t0, skipped: why });
  if (!(process.env.DEEPSEEK_API_KEY ?? "").trim()) return skip("no_key");
  // 申込以降・申込中（線が null）は DeepSeek に出さない
  const cutoff = await loadDeepseekCutoff(supabase as never, o.conversationId);
  if (cutoff === null) return skip("post_apply");
  const masked = maskPII(o.customerText, [o.customerName ?? null]);
  if (altPiiSignal(masked)) return skip("pii");
  const budget = o.budgetMs ?? 8_000;
  try {
    const { callDeepSeekRead } = await import("@/app/lib/vision-alt-provider");
    const read = await Promise.race([
      callDeepSeekRead(RESEARCHER_SYSTEM, buildResearcherUser(masked), { maxTokens: 200, timeoutMs: budget }, (t) => parseResearcherOutput(t)),
      new Promise<null>((r) => setTimeout(() => r(null), budget + 500)),
    ]);
    if (read) for (const a of read.attempts) {
      void import("@/app/lib/llm-usage-recorder").then(({ recordAltUsage }) => recordAltUsage({
        model: a.res?.model ?? "deepseek", action: "brain_researcher", conversationId: o.conversationId,
        usage: { input_tokens: Math.max(0, (a.res?.usage.input ?? 0) - (a.res?.usage.cacheHit ?? 0)), output_tokens: a.res?.usage.output ?? 0, cache_read_input_tokens: a.res?.usage.cacheHit ?? 0 },
        status: a.res ? 200 : 0, errorType: a.ok ? null : (a.res ? "empty_or_unparsable" : "no_response"),
        durationMs: a.ms, sysHead: "【調べる係】", sysKeyFull: null, maxTokens: 200,
      })).catch(() => {});
    }
    const lookups = read?.value ?? null;
    if (!lookups || !lookups.length) return skip(read ? "no_lookup" : "timeout");
    const { data: conv } = o.propertyCustomerId === undefined ? await supabase.from("conversations").select("property_customer_id").eq("id", o.conversationId).maybeSingle() : { data: null };
    const pcId = o.propertyCustomerId ?? ((conv as { property_customer_id?: string | null } | null)?.property_customer_id ?? null);
    const beforeIso = o.turnAtIso ?? new Date().toISOString();
    const results = await Promise.all(lookups.map(async (l) => ({ ...l, lines: await runLookup(o.conversationId, pcId, l, beforeIso).catch(() => [] as string[]) })));
    return { block: researcherBlock({ customerText: masked, results }), lookups, ms: Date.now() - t0 };
  } catch (e) {
    console.warn("[brain-researcher] skipped:", o.conversationId, e instanceof Error ? e.message : String(e));
    return skip("error");
  }
}
