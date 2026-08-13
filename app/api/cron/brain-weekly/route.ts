import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 300;

const HAIKU = "claude-haiku-4-5-20251001";
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 15_000 });

const SKIP_STATUSES = ["contract", "closed_won", "closed_lost", "lost"];

const AIX_BRAIN_NOTES: Record<string, string> = {
  viewing_invite:          "内覧日程の候補を提示してください → AIX【内覧日調整】で日時を選択して送信してください",
  property_send:           "物件URLが揃ったら → AIX【物件ピックアップした】でカバーメッセージを生成して一緒に送ってください",
  estimate_sheet:          "見積書が届いたら → AIX【見積書送る】で読み取って自動計算＋カバーメッセージを生成できます",
  application_push:        "AIX【申込へ！】でクロージングメッセージを生成できます",
  condition_hearing:       "AIX【条件ヒアリング】ボタンで既知情報をスキップした形式で送れます",
  acknowledge_check:       "送信後 → AIX【確認します】で管理会社への空室確認＋見積書依頼を送ってください（宛先は管理会社です）",
  followup_revive:         "AIX【追客する】で再接触メッセージを生成できます",
  property_check_result:   "管理会社から返答が来たら → AIX【物件確認した（募集状況）】で結果報告文を生成してください",
  property_recommendation: "お客様の条件に最も合う1件を特にオススメとしてAIX【物件オススメ】で提案してください",
  meeting_place:           "内覧の日時・物件が確定したら → AIX【待ち合わせ】で待ち合わせ場所の案内を送ってください",
  greeting_viewing:        "内覧前後の挨拶は → AIX【内覧挨拶】でシーンに合わせた挨拶メッセージを生成できます",
};

async function analyzeConversation(
  conversationId: string,
  convStatus: string | null,
  propertyCustomerId: string | null,
): Promise<{ action: string; note: string; source: string; enforcement_level: string; closing_strategy?: string } | null> {
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
    supabase
      .from("ai_reply_examples")
      .select("sent_reply")
      .eq("conversation_id", conversationId)
      .eq("is_starred", true)
      .order("created_at", { ascending: false })
      .limit(3),
    supabase
      .from("conversation_checkpoints")
      .select("checkpoint_index, summary, key_facts")
      .eq("conversation_id", conversationId)
      .order("checkpoint_index", { ascending: false })
      .limit(2),
  ]);

  const messages = msgResult.data;
  if (!messages || messages.length === 0) return null;

  const history = [...messages]
    .reverse()
    .map((m: { sender: string; text: string | null }) => `[${m.sender}] ${m.text ?? "（画像/添付）"}`)
    .join("\n");

  type PC = { desired_area?: string | null; floor_plan?: string | null; rent_max?: number | null; move_in_time?: string | null; preferences?: string | null } | null;
  const pc = (pcResult.data ?? null) as PC;
  const condParts: string[] = [];
  if (pc?.desired_area) condParts.push(`エリア: ${pc.desired_area}`);
  if (pc?.floor_plan) condParts.push(`間取り: ${pc.floor_plan}`);
  if (pc?.rent_max) condParts.push(`家賃上限: ${Math.floor((pc.rent_max as number) / 10000)}万`);
  if (pc?.move_in_time) condParts.push(`入居: ${pc.move_in_time}`);
  if (pc?.preferences) condParts.push(`希望: ${pc.preferences}`);
  const condText = condParts.length > 0 ? `\n顧客条件: ${condParts.join(" / ")}` : "";
  const statusText = convStatus ? `\n現在のステータス: ${convStatus}` : "";

  const examples = (examplesResult.data ?? []) as Array<{ sent_reply: string | null }>;
  const examplesText = examples.length > 0
    ? `\n過去のスタッフ優良返信例:\n${examples.map((e) => `- ${e.sent_reply ?? ""}`).join("\n")}`
    : "";

  type Checkpoint = { checkpoint_index: number; summary: string | null; key_facts: string | null };
  const checkpoints = ((checkpointsResult.data ?? []) as Checkpoint[]).reverse();
  const checkpointText = checkpoints.length > 0
    ? `\n【過去の会話まとめ】\n${checkpoints.map((cp) => `■ ブロック${cp.checkpoint_index}: ${cp.summary ?? ""}`).join("\n")}`
    : "";

  const prompt = `あなたはスモラAI。以下の会話履歴を読んで、スタッフが次にすべき1アクションを20字以内で答えてください。必ずJSON形式のみで返してください。${statusText}${condText}${examplesText}${checkpointText}

会話履歴:
${history}

回答形式（JSONのみ・説明文不要）:
{"action": "スタッフが次にすべき具体的なアクション（20字以内）", "reason": "その理由（30字以内）", "aix": "最も適切なAIXタイプ（viewing_invite/property_send/estimate_sheet/application_push/condition_hearing/acknowledge_check/followup_revive/property_check_result/property_recommendation/meeting_place/greeting_viewing/null）", "closing_strategy": "この顧客が契約に至るための具体的な戦略を1〜2文で"}`;

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
      aix?: string | null;
      closing_strategy?: string;
    };

    const aix = parsed.aix && AIX_BRAIN_NOTES[parsed.aix] ? parsed.aix : null;
    return {
      action: aix ?? "",
      note: aix ? AIX_BRAIN_NOTES[aix] : (parsed.action ?? ""),
      source: "brain_weekly",
      enforcement_level: "recommended",
      closing_strategy: parsed.closing_strategy || undefined,
    };
  } catch {
    return null;
  }
}

// Process an array of items concurrently with a max concurrency limit
async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

export async function GET() {
  // Fetch active non-要対応 conversations (last_sender = 'staff' or 'ai')
  const { data: conversations, error } = await supabase
    .from("conversations")
    .select("id, status, updated_at, property_customer_id")
    .neq("last_sender", "customer")
    .not("status", "in", `(${SKIP_STATUSES.join(",")})`)
    .not("status", "is", null)
    .order("updated_at", { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (conversations ?? []) as Array<{
    id: string;
    status: string | null;
    updated_at: string;
    property_customer_id: string | null;
  }>;

  if (rows.length === 0) {
    return NextResponse.json({ processed: 0, skipped: 0 });
  }

  let processed = 0;
  let failed = 0;

  await withConcurrency(rows, 5, async (conv) => {
    const meta = await analyzeConversation(conv.id, conv.status, conv.property_customer_id);
    if (!meta) { failed++; return; }

    const { error: upsertErr } = await supabase
      .from("conversations")
      .update({ suggested_aix_meta: meta })
      .eq("id", conv.id);

    if (!upsertErr) processed++;
    else failed++;
  });

  return NextResponse.json({ processed, failed, total: rows.length });
}
