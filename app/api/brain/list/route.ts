import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 60;

const HAIKU = "claude-haiku-4-5-20251001";
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 15_000 });

// Statuses that indicate a closed/inactive conversation — excluded from brain list
const SKIP_STATUSES = ["contract", "closed_won", "closed_lost", "lost"];

// Conversations updated within this window are flagged as urgent
const URGENT_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

// Max conversations to run Haiku brain-summary for in a single request (cost/latency guard)
const MAX_HAIKU_PER_REQUEST = 30;

type SuggestedAixMeta = {
  action: string;
  note: string;
  source?: string;
  enforcement_level?: "required" | "recommended" | "optional";
} | null;

type BrainConversation = {
  id: string;
  customer_name: string | null;
  status: string | null;
  updated_at: string;
  last_message: string | null;
  suggested_aix_meta: SuggestedAixMeta;
  ai_draft: string | null;
  property_customer_id: string | null;
  is_urgent: boolean;
};

/**
 * Calls Claude Haiku with enriched context (last 15 messages, customer conditions,
 * conversation status) and returns a SuggestedAixMeta to cache in conversations.
 * FIX #02: enforcement_level is now dynamic based on urgency.
 */
async function generateBrainSummary(
  conversationId: string,
  isUrgent: boolean,
  convStatus: string | null,
  propertyCustomerId: string | null,
): Promise<SuggestedAixMeta> {
  // Fetch last 15 messages and customer conditions in parallel
  const [msgResult, pcResult, examplesResult, checkpointsResult] = await Promise.all([
    supabase
      .from("messages")
      .select("sender, text, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(15),
    propertyCustomerId
      ? supabase
          .from("property_customers")
          .select("desired_area, floor_plan, rent_min, rent_max, move_in_time, preferences")
          .eq("id", propertyCustomerId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // Recent starred reply examples for this conversation (context for Haiku)
    supabase
      .from("ai_reply_examples")
      .select("sent_reply, is_starred")
      .eq("conversation_id", conversationId)
      .eq("is_starred", true)
      .order("created_at", { ascending: false })
      .limit(3),
    // Latest 2 checkpoints for long-conversation context
    supabase
      .from("conversation_checkpoints")
      .select("checkpoint_index, summary, key_facts, conversation_stage")
      .eq("conversation_id", conversationId)
      .order("checkpoint_index", { ascending: false })
      .limit(2),
  ]);

  const { data: messages, error } = msgResult;
  if (error || !messages || messages.length === 0) return null;

  // Reverse so the history reads oldest → newest
  const history = (messages as Array<{ sender: string; text: string | null; created_at: string }>)
    .reverse()
    .map((m) => `[${m.sender}] ${m.text ?? "（画像/添付）"}`)
    .join("\n");

  // Build customer conditions context
  type PC = { desired_area?: string | null; floor_plan?: string | null; rent_min?: number | null; rent_max?: number | null; move_in_time?: string | null; preferences?: string | null } | null;
  const pc = (pcResult.data ?? null) as PC;
  const condParts: string[] = [];
  if (pc?.desired_area) condParts.push(`エリア: ${pc.desired_area}`);
  if (pc?.floor_plan) condParts.push(`間取り: ${pc.floor_plan}`);
  if (pc?.rent_max) condParts.push(`家賃上限: ${Math.floor((pc.rent_max as number) / 10000)}万`);
  if (pc?.move_in_time) condParts.push(`入居: ${pc.move_in_time}`);
  if (pc?.preferences) condParts.push(`希望: ${pc.preferences}`);
  const condText = condParts.length > 0 ? `\n顧客条件: ${condParts.join(" / ")}` : "";

  const statusText = convStatus ? `\n現在のステータス: ${convStatus}` : "";

  // Recent starred examples (good replies) for this customer
  const examples = (examplesResult.data ?? []) as Array<{ sent_reply: string | null; is_starred: boolean | null }>;
  const examplesText = examples.length > 0
    ? `\n過去のスタッフ優良返信例:\n${examples.map((e) => `- ${e.sent_reply ?? ""}`).join("\n")}`
    : "";

  // Checkpoint summaries for long-conversation context (セーブポイント)
  type Checkpoint = { checkpoint_index: number; summary: string | null; key_facts: string | null; conversation_stage: string | null };
  const checkpoints = ((checkpointsResult.data ?? []) as Checkpoint[]).reverse(); // oldest first
  const checkpointText = checkpoints.length > 0
    ? `\n【過去の会話まとめ（セーブポイント）】\n${checkpoints.map((cp) => `■ ブロック${cp.checkpoint_index}: ${cp.summary ?? ""}${cp.key_facts ? ` / ${cp.key_facts}` : ""}`).join("\n")}`
    : "";

  const prompt = `あなたはスモラAI。以下の会話履歴を読んで、スタッフが次にすべき1アクションを20字以内で答えてください。必ずJSON形式のみで返してください。${statusText}${condText}${examplesText}${checkpointText}

会話履歴:
${history}

回答形式（JSONのみ・説明文不要）:
{"action": "スタッフが次にすべき具体的なアクション（20字以内）", "reason": "その理由（30字以内）", "aix": "関連するAIXタイプまたはnull（viewing_invite/property_send/estimate_sheet/follow_up/application_push/null）"}`;

  try {
    const response = await client.messages.create({
      model: HAIKU,
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = response.content[0].type === "text" ? response.content[0].text : "";
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as {
      action?: string;
      reason?: string;
      aix?: string | null;
    };

    // FIX #02: enforcement_level is "required" for urgent conversations (customer replied < 2h ago),
    // otherwise "recommended"
    return {
      action: parsed.aix ?? "follow_up",
      note: parsed.action ?? "",
      source: "analysis_step1",
      enforcement_level: isUrgent ? "required" : "recommended",
    };
  } catch {
    return null;
  }
}

export async function GET(_req: NextRequest) {
  // 1. Fetch all active conversations where it is the customer's turn
  const { data: conversations, error } = await supabase
    .from("conversations")
    .select(
      "id, customer_name, status, updated_at, last_message, suggested_aix_meta, ai_draft, property_customer_id"
    )
    .eq("last_sender", "customer")
    .not("status", "in", `(${SKIP_STATUSES.join(",")})`)
    .order("updated_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (conversations ?? []) as Array<{
    id: string;
    customer_name: string | null;
    status: string | null;
    updated_at: string;
    last_message: string | null;
    suggested_aix_meta: SuggestedAixMeta;
    ai_draft: string | null;
    property_customer_id: string | null;
  }>;

  // 2. Find conversations that have no brain summary yet and process them via Haiku
  const needsSummary = rows.filter((c) => !c.suggested_aix_meta);
  const toProcess = needsSummary.slice(0, MAX_HAIKU_PER_REQUEST);

  if (toProcess.length > 0) {
    const summaries = await Promise.all(
      toProcess.map(async (conv) => {
        const isUrgent = Date.now() - new Date(conv.updated_at).getTime() <= URGENT_WINDOW_MS;
        const meta = await generateBrainSummary(
          conv.id,
          isUrgent,
          conv.status,
          conv.property_customer_id,
        );
        return { id: conv.id, meta };
      })
    );

    // Persist and update in-memory rows simultaneously
    await Promise.all(
      summaries
        .filter((s): s is { id: string; meta: NonNullable<SuggestedAixMeta> } => s.meta !== null)
        .map(async ({ id, meta }) => {
          // Only update if still null in DB (safety guard against concurrent requests)
          await supabase
            .from("conversations")
            .update({ suggested_aix_meta: meta })
            .eq("id", id)
            .is("suggested_aix_meta", null);

          // Reflect into the in-memory row so the response is up to date
          const row = rows.find((r) => r.id === id);
          if (row) row.suggested_aix_meta = meta;
        })
    );
  }

  // 3. Build typed result with urgency flag
  const now = Date.now();
  const result: BrainConversation[] = rows.map((c) => ({
    id: c.id,
    customer_name: c.customer_name,
    status: c.status,
    updated_at: c.updated_at,
    last_message: c.last_message ?? null,
    suggested_aix_meta: c.suggested_aix_meta ?? null,
    ai_draft: c.ai_draft ?? null,
    property_customer_id: c.property_customer_id ?? null,
    is_urgent: now - new Date(c.updated_at).getTime() <= URGENT_WINDOW_MS,
  }));

  // 4. Sort: urgent conversations (last customer message ≤ 2h ago) first,
  //    then the rest — both groups already ordered by updated_at DESC from the DB query
  result.sort((a, b) => {
    if (a.is_urgent === b.is_urgent) return 0;
    return a.is_urgent ? -1 : 1;
  });

  return NextResponse.json(result);
}
