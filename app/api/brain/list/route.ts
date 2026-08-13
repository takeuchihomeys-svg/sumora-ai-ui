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
const MAX_HAIKU_PER_REQUEST = 10;

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
 * Calls Claude Haiku with the last 5 messages for a conversation and returns
 * a lightweight brain summary shaped as SuggestedAixMeta so it can be cached
 * in conversations.suggested_aix_meta.
 */
async function generateBrainSummary(conversationId: string): Promise<SuggestedAixMeta> {
  const { data: messages, error } = await supabase
    .from("messages")
    .select("sender, text, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(5);

  if (error || !messages || messages.length === 0) return null;

  // Reverse so the history reads oldest → newest
  const history = (messages as Array<{ sender: string; text: string | null; created_at: string }>)
    .reverse()
    .map((m) => `[${m.sender}] ${m.text ?? "（画像/添付）"}`)
    .join("\n");

  const prompt = `あなたはスモラAI。以下の会話履歴を読んで、スタッフが次にすべき1アクションを20字以内で答えてください。必ずJSON形式のみで返してください。

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

    return {
      action: parsed.aix ?? "follow_up",
      note: parsed.action ?? "",
      source: "analysis_step1",
      enforcement_level: "recommended",
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
        const meta = await generateBrainSummary(conv.id);
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
