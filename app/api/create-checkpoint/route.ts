import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

// ⚠️ 廃止（2026-08-14）: 旧ブロック方式writer。チェックポイントは brain-core.ts の
// maybeCreateCheckpoint（ローリング累積方式・単一writer）が作成する。
// index の意味が異なるため本ルートは絶対に起動しないこと（併用禁止）。
export const maxDuration = 60;

const MESSAGES_PER_CHECKPOINT = 15;

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

interface CheckpointJson {
  summary: string;
  key_facts: { type: string; value: string }[];
  stage: string;
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { conversation_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { conversation_id } = body;
  if (!conversation_id) {
    return NextResponse.json({ error: "conversation_id required" }, { status: 400 });
  }

  const supabase = getSupabase();

  // Fetch all messages for this conversation ordered by created_at
  const { data: messages, error: msgError } = await supabase
    .from("messages")
    .select("id, sender, text, created_at")
    .eq("conversation_id", conversation_id)
    .order("created_at", { ascending: true });

  if (msgError) {
    return NextResponse.json({ error: msgError.message }, { status: 500 });
  }

  const totalMessages = (messages ?? []).length;
  // Number of complete 15-message blocks
  const maxCheckpointIndex = Math.floor(totalMessages / MESSAGES_PER_CHECKPOINT);

  if (maxCheckpointIndex === 0) {
    return NextResponse.json({ created: 0, skipped: 0, reason: "not_enough_messages" });
  }

  // Fetch existing checkpoints
  const { data: existingCheckpoints, error: cpError } = await supabase
    .from("conversation_checkpoints")
    .select("checkpoint_index")
    .eq("conversation_id", conversation_id);

  if (cpError) {
    return NextResponse.json({ error: cpError.message }, { status: 500 });
  }

  const existingIndexes = new Set(
    (existingCheckpoints ?? []).map((c: { checkpoint_index: number }) => c.checkpoint_index)
  );

  // Determine which checkpoints are missing
  const missingIndexes: number[] = [];
  for (let i = 1; i <= maxCheckpointIndex; i++) {
    if (!existingIndexes.has(i)) {
      missingIndexes.push(i);
    }
  }

  if (missingIndexes.length === 0) {
    return NextResponse.json({ created: 0, skipped: maxCheckpointIndex });
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

  let created = 0;
  let skipped = existingIndexes.size;

  for (const checkpointIndex of missingIndexes) {
    const startIndex = (checkpointIndex - 1) * MESSAGES_PER_CHECKPOINT;
    const endIndex = checkpointIndex * MESSAGES_PER_CHECKPOINT;
    const block = (messages ?? []).slice(startIndex, endIndex);

    const startNum = startIndex + 1;
    const endNum = endIndex;

    const messagesText = block
      .map((m: { sender: string; text: string }) => {
        const role = m.sender === "customer" ? "お客さん" : "スタッフ";
        return `${role}: ${m.text}`;
      })
      .join("\n");

    const prompt = `以下はお客さんとのLINEやり取り（${startNum}〜${endNum}件目）です。
この会話ブロックで起きた重要な出来事・決定事項・お客さんの状況変化を簡潔にまとめてください。

【会話】
${messagesText}

以下のJSON形式のみで返答してください（説明・コードブロック不要）：
{
  "summary": "このブロックの要約（100字以内）",
  "key_facts": [
    {"type": "property_sent", "value": "○○物件3件送付"},
    {"type": "viewing_scheduled", "value": "○月○日内覧設定"}
  ],
  "stage": "hearing"
}

stageは hearing/proposing/applying/contract のいずれかを選んでください。
key_factsは空配列でも構いません。重要な事実のみ抽出してください。`;

    let parsed: CheckpointJson | null = null;
    try {
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      });

      const rawText =
        response.content[0].type === "text" ? response.content[0].text : "";
      parsed = JSON.parse(rawText.trim()) as CheckpointJson;
    } catch (e) {
      console.error(
        `[create-checkpoint] Haiku failed for conversation=${conversation_id} index=${checkpointIndex}:`,
        e instanceof Error ? e.message : String(e)
      );
      continue;
    }

    const { error: insertError } = await supabase
      .from("conversation_checkpoints")
      .insert({
        conversation_id,
        checkpoint_index: checkpointIndex,
        message_count_at_creation: totalMessages,
        summary: parsed.summary ?? "",
        key_facts: parsed.key_facts ?? [],
        conversation_stage: parsed.stage ?? null,
      });

    if (insertError) {
      // UNIQUE violation means it was created by a concurrent run — treat as skipped
      if (insertError.code === "23505") {
        skipped++;
      } else {
        console.error(
          `[create-checkpoint] insert failed conversation=${conversation_id} index=${checkpointIndex}:`,
          insertError.message
        );
      }
      continue;
    }

    created++;
  }

  return NextResponse.json({ created, skipped });
}
