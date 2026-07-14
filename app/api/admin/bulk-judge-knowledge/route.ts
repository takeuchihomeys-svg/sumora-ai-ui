import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { syncConfirmedToPromptRule } from "@/app/lib/knowledge-promote";

export const maxDuration = 300; // Vercel Pro: 5分まで延長

const BATCH_SIZE = 10; // parallel Sonnet calls per batch
const MAX_AI_QUESTIONS = 100; // AI質問登録の上限

export async function GET(req: NextRequest) {
  // Auth check: Authorization: Bearer（Vercel cron が自動付与）/ x-cron-secret ヘッダー / ?secret= の3方式対応
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const secret = req.headers.get("x-cron-secret") ?? req.nextUrl.searchParams.get("secret");
  const bearerOk = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!cronSecret || (!bearerOk && secret !== cronSecret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ページング: 1回の呼び出しで処理する件数 (default 200)
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") ?? "200"), 300);
  const offset = parseInt(req.nextUrl.searchParams.get("offset") ?? "0");

  // 1. Fetch hypothesis items (importance>=7, not phrase) with paging
  const { data: items } = await supabase
    .from("ai_reply_knowledge")
    .select("id, title, content, category, conversation_state, importance, correct_count, wrong_count, apply_count")
    .eq("hypothesis_status", "hypothesis")
    .neq("category", "phrase")
    .gte("importance", 7)
    .order("importance", { ascending: false })
    .range(offset, offset + limit - 1);

  if (!items || items.length === 0) {
    return NextResponse.json({ ok: true, message: "no items to process" });
  }

  // 2. Get existing confirmed rules for context (per conversation_state)
  const stateMap: Record<string, Array<{ title: string; content: string }>> = {};

  // 3. Batch process with Sonnet
  const confirmed: string[] = [];
  const questions: Array<{
    id: string;
    title: string;
    content: string;
    category: string;
    conversation_state: string | null;
    importance: number;
    reason: string;
    verdict: string;
  }> = [];

  // Process in batches of BATCH_SIZE
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(batch.map(async (item) => {
      // Get existing confirmed rules for this state (cache per state)
      const state = (item.conversation_state as string) ?? "";
      if (!stateMap[state]) {
        const { data: existing } = await supabase
          .from("ai_reply_knowledge")
          .select("title, content")
          .eq("hypothesis_status", "confirmed")
          .eq("conversation_state", state)
          .order("importance", { ascending: false })
          .limit(3);
        stateMap[state] = (existing ?? []).map(r => ({ title: r.title as string, content: String(r.content).slice(0, 80) }));
      }

      const existingText = stateMap[state].map((r, idx) => `${idx + 1}. ${r.title}: ${r.content}`).join("\n") || "（なし）";
      const imp = (item.importance as number) ?? 7;
      const apiKey = process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "");
      if (!apiKey) return { id: item.id as string, verdict: "skip" as const, reason: "no api key" };

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: AbortSignal.timeout(8_000),
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 300,
          messages: [{
            role: "user",
            content: `賃貸仲介AIのナレッジ品質審査員として判定してください。
フェーズ: ${item.conversation_state ?? "不明"} / 重要度: ${imp}
タイトル: ${item.title}
内容: ${String(item.content).slice(0, 200)}
既存確定ルール: ${existingText}
JSONのみ回答: {"verdict":"confirm"|"question"|"contradiction","reason":"何が問題か・竹内さんに何を確認すればよいかを60字以内で具体的に"}`,
          }],
        }),
      });

      if (!res.ok) return { id: item.id as string, verdict: "skip" as const, reason: "api error" };
      const data = await res.json() as { content?: Array<{ text: string }> };
      const text = data.content?.[0]?.text ?? "";
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return { id: item.id as string, verdict: "skip" as const, reason: "parse error" };
      const parsed = JSON.parse(match[0]) as { verdict?: string; reason?: string };
      return {
        id: item.id as string,
        title: item.title as string,
        content: String(item.content),
        category: item.category as string,
        conversation_state: item.conversation_state as string | null,
        importance: imp,
        correct_count: item.correct_count as number,
        verdict: (parsed.verdict ?? "skip") as string,
        reason: parsed.reason ?? "",
      };
    }));

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        const v = r.value;
        if (v.verdict === "confirm") {
          const vConfirmed = v as { importance?: number; correct_count?: number };
          if ((vConfirmed.importance ?? 0) >= 9 && (vConfirmed.correct_count ?? 0) >= 2) {
            confirmed.push(v.id);
          } else {
            // 条件未満はAI質問に回す
            questions.push({ ...v, verdict: "question", reason: "AIが確認OK判定だが実績不足（importance<9 または correct_count<2）" } as typeof questions[0]);
          }
        } else if (v.verdict === "question" || v.verdict === "contradiction") {
          questions.push({ ...v, verdict: v.verdict } as typeof questions[0]);
        }
      }
    }

    // Small pause between batches to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  // 4. Auto-confirm clear ones
  let confirmedCount = 0;
  for (const id of confirmed) {
    const { error } = await supabase.from("ai_reply_knowledge").update({ hypothesis_status: "confirmed" }).eq("id", id);
    if (!error) {
      const { data: row } = await supabase.from("ai_reply_knowledge").select("id, title, content, conversation_state, importance").eq("id", id).single();
      if (row) {
        await syncConfirmedToPromptRule(row);
        confirmedCount++;
      }
    }
  }

  // 5. Deduplicate questions: group by conversation_state + category
  //    Within each group, merge questions with similar titles (keyword overlap)
  const deduped: typeof questions = [];
  const seen = new Set<string>();

  // Sort by importance DESC first
  questions.sort((a, b) => b.importance - a.importance);

  for (const q of questions) {
    // Dedup key: conversation_state + category + first 15 chars of title
    const titleKey = (q.title ?? "").replace(/[「」・]/g, "").slice(0, 15);
    const key = `${q.conversation_state ?? "null"}:${q.category}:${titleKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(q);
    if (deduped.length >= MAX_AI_QUESTIONS) break;
  }

  // 6. Register to ai_feedback_items
  let questionCount = 0;
  for (const q of deduped) {
    const categoryVal = q.verdict === "contradiction" ? "knowledge_gap" : "prompt_ambiguity";
    const contentPreview = String(q.content ?? "");
    const phase = q.conversation_state ?? "不明";
    const reason = q.reason || "内容の妥当性を確認したい";

    const questionText = q.verdict === "contradiction"
      ? `[knowledge_id:${q.id}]
⚠️【確認お願いします】このナレッジは既存ルールと矛盾している可能性があります

━━ ナレッジ名 ━━
「${q.title}」

━━ 内容（全文） ━━
${contentPreview}

━━ 使用フェーズ ━━
${phase}（${q.conversation_state ?? "全フェーズ共通"}）

━━ AIが検出した矛盾 ━━
${reason}

❓ 竹内さんへの質問
① このナレッジは残して使いますか？（既存ルールより優先しますか？）
② 既存ルールの方が正しければ、このナレッジは削除してください
③ 両方必要な場合は「場面が違う」など補足を教えてください`
      : `[knowledge_id:${q.id}]
❓【教えてください】このナレッジの使い方が判断できません

━━ ナレッジ名 ━━
「${q.title}」

━━ 内容（全文） ━━
${contentPreview}

━━ 使用フェーズ ━━
${phase}（${q.conversation_state ?? "全フェーズ共通"}）

━━ 判断できなかった理由 ━━
${reason}

❓ 竹内さんへの質問
① このナレッジはどんな場面で使いますか？（例：「お客様が来月引越したいと言っているとき」など具体的に）
② AIに何をさせたいですか？（例：「スモ割の締切を伝える」「入居時期を確認する」など）
③ 内容に修正が必要な場合は、正しい内容を教えてください`;

    // Dedup check against existing pending items
    const { data: existing } = await supabase
      .from("ai_feedback_items")
      .select("id")
      .eq("status", "pending")
      .ilike("question", `%${q.id}%`)
      .limit(1);
    if (existing && existing.length > 0) continue;

    const { error } = await supabase.from("ai_feedback_items").insert({
      category: categoryVal,
      question: questionText,
      speculation: `フェーズ: ${q.conversation_state ?? "不明"} / 重要度: ${q.importance}`,
      evidence: `category: ${q.category}`,
      status: "pending",
      confidence: q.importance >= 8 ? "high" : "medium",
    });
    if (!error) questionCount++;
  }

  const processed = items.length;
  const hasMore = processed === limit;
  return NextResponse.json({
    ok: true,
    offset,
    processed,
    confirmed: confirmedCount,
    questions_registered: questionCount,
    questions_candidates: questions.length,
    skipped: processed - confirmed.length - questions.length,
    // 続きがある場合: nextOffset を使って次の呼び出しを行う
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
  });
}

// POST: 週次 Vercel cron 用（GET と同じ処理に委譲。認証は GET 側で実施）
export async function POST(req: NextRequest) {
  return GET(req);
}
