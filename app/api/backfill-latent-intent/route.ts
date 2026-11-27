import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase-server";
import { generateEmbedding } from "@/app/lib/knowledge-utils";
// 2026-09-27 竹内: テスト用の会話（YUMA）は学習に入れない（一覧は test-conversations.ts の1か所）
import { isTestConversation } from "@/app/lib/test-conversations";
import { stageOnNow } from "@/app/lib/rollout";
import { isFilledApplicationForm } from "@/app/lib/post-apply";

// Opus呼び出し（80件履歴）を1会話ずつシーケンシャル処理するため延長
export const maxDuration = 300;

// 成約・申込済みとみなすステータス
const CLOSED_STATUSES = ["applying", "application", "screening", "contract", "approved", "closed_won"];

// POST /api/backfill-latent-intent
// 既存の成約・申込済み会話から latent_intent_pattern（潜在意識・動機パターン）のみを抽出してバックフィルする。
// learn-closing-pattern と同じプロンプト構成だが、抽出対象は latent_intent_pattern のみ。
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const internalSecret = process.env.INTERNAL_API_SECRET;
  const auth = req.headers.get("authorization");
  const validCron = cronSecret && auth === `Bearer ${cronSecret}`;
  const validInternal = internalSecret && auth === `Bearer ${internalSecret}`;
  if (!validCron && !validInternal) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "");
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "10"), 30);

  // 1) 成約・申込済み会話を取得
  const { data: convs, error: convErr } = await supabase
    .from("conversations")
    .select("id, customer_name, status")
    .in("status", CLOSED_STATUSES)
    .order("updated_at", { ascending: false });

  if (convErr) return NextResponse.json({ ok: false, error: convErr.message }, { status: 500 });
  if (!convs || convs.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, skipped: 0, errors: [], done: true });
  }

  type ConvRow = { id: string; customer_name: string | null; status: string };
  // 2026-09-27: テスト用の会話（YUMA）は学びに入れない
  const typedConvs = (convs as ConvRow[]).filter((c) => !isTestConversation(c.id));

  // 2) 既に latent_intent_pattern 学習済みの顧客を把握
  //   （title LIKE %パターン% AND content LIKE %潜在意識% の既存knowledgeに customer_name が含まれているか）
  const { data: learnedRows, error: learnedErr } = await supabase
    .from("ai_reply_knowledge")
    .select("title, content")
    .like("title", "%パターン%")
    .like("content", "%潜在意識%");

  if (learnedErr) return NextResponse.json({ ok: false, error: learnedErr.message }, { status: 500 });

  type LearnedRow = { title: string | null; content: string | null };
  const learnedTexts = ((learnedRows ?? []) as LearnedRow[]).map(
    (r) => `${r.title ?? ""}\n${r.content ?? ""}`
  );
  const isAlreadyLearned = (customerName: string | null): boolean => {
    if (!customerName) return false;
    return learnedTexts.some((t) => t.includes(customerName));
  };

  let processed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const conv of typedConvs) {
    if (processed >= limit) break;

    try {
      // 3) 学習済みスキップ判定
      if (isAlreadyLearned(conv.customer_name)) {
        skipped++;
        continue;
      }

      // 会話履歴を取得（直近80件を時系列順に）
      const { data: msgs, error: msgErr } = await supabase
        .from("messages")
        .select("sender, text, created_at")
        .eq("conversation_id", conv.id)
        .neq("text", "[画像]")
        .neq("text", "[動画]")
        .not("text", "is", null)
        .order("created_at", { ascending: false })
        .limit(80);

      if (msgErr) {
        errors.push(`${conv.id}: messages fetch error: ${msgErr.message}`);
        continue;
      }
      if (!msgs || msgs.length < 5) {
        skipped++;
        continue;
      }

      // 2026-11-28 作業員L（統括役の決め3・申込以降を学びに使わない）: 直近80通には記入済みの申込フォームと申込の後の通も入る。
      //   LATENT_INTENT_CUT_AT_APPLY=on（既定 off・段階で読む）の時だけ、最初の記入済みの申込フォームの通か deal_outcomes の applied_at の早い方より前の通だけ（learn-closing-pattern と同じ形）
      let useMsgs = msgs as Array<{ sender: string; text: string | null; created_at: string }>;
      if (await stageOnNow("LATENT_INTENT_CUT_AT_APPLY", conv.id)) {
        const { data: outs } = await supabase.from("deal_outcomes").select("applied_at").eq("conversation_id", conv.id).not("applied_at", "is", null).order("applied_at", { ascending: true }).limit(1);
        const formAt = [...useMsgs].reverse().find((m) => m.created_at && isFilledApplicationForm(m.text))?.created_at ?? null;
        const appliedAt = ((outs ?? []) as Array<{ applied_at: string | null }>)[0]?.applied_at ?? null;
        const cut = [formAt, appliedAt].filter((x): x is string => !!x).sort()[0] ?? null;
        if (cut) useMsgs = useMsgs.filter((m) => m.created_at < cut);
        if (useMsgs.length < 5) { skipped++; continue; }
      }
      const history = useMsgs
        .slice()
        .reverse()
        .map((m) => `${m.sender === "customer" ? "お客さん" : "スタッフ"}: ${(m.text || "").slice(0, 150)}`)
        .join("\n");

      // 4) Claude Opus 5 で latent_intent_pattern のみ抽出（learn-closing-pattern と同じプロンプト構成）
      const eventLabel = conv.status === "closed_won" || conv.status === "contract" ? "成約" : "申込";
      const successMoment =
        eventLabel === "申込"
          ? "お客さんが申込フォーマット（氏名・フリガナ・生年月日・現住所・緊急連絡先・勤務先などの個人情報）をLINEで送ってきた瞬間"
          : "最終的に成約・契約に至った瞬間";

      const prompt = `以下は賃貸仲介の会話履歴です（お客様名: ${conv.customer_name ?? "不明"}）。
成功の定義: 「${successMoment}」
この会話でなぜお客さんがそのアクションを取ったかを分析し、学習パターンとして抽出してください。

【会話履歴】
${history}

以下のJSONのみ返してください：
{
  "latent_intent_pattern": "この成約会話を通じてお客さんがもっていた潜在的な動機・不安・期待（例: 初期費用を何度も確認していた→予算ギリギリで不安だったが見積で安心して決断 / 審査について遠回しに聞いていた→審査に通るか不安で申し込みをためらっていた / 物件の写真を何度も見返していた→即決したいが失敗したくない慎重さがあった）。会話の文脈・沈黙・繰り返し質問のパターンから推測すること。根拠がなければnull"
}`;

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-opus-5",
          max_tokens: 500,
          thinking: { type: "disabled" },
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(45_000),
      });

      if (!res.ok) {
        errors.push(`${conv.id}: AI error (status ${res.status})`);
        continue;
      }

      const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
      const raw = data.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text ?? "";
      const match = raw.replace(/```json?\s*/gi, "").replace(/```\s*/g, "").trim().match(/\{[\s\S]*\}/);
      if (!match) {
        errors.push(`${conv.id}: parse error`);
        continue;
      }

      const learned = JSON.parse(match[0]) as { latent_intent_pattern: string | null };
      if (!learned.latent_intent_pattern) {
        // 根拠なし（null）→ 学習対象外としてスキップ
        skipped++;
        continue;
      }

      // 5) ai_reply_knowledge に保存（importance=9・applying_pattern）
      const customerName = conv.customer_name ?? "不明";
      const title = `${eventLabel}パターン_潜在意識_${customerName}_${new Date().toISOString().slice(0, 10)}`;
      const content = `【${eventLabel}パターン学習: ${customerName}さん】
潜在意識・動機パターン: ${learned.latent_intent_pattern}`;

      // 重複INSERT防止: 同一タイトルが既に存在する場合はスキップ
      const { data: existingPattern } = await supabase
        .from("ai_reply_knowledge")
        .select("id")
        .eq("title", title)
        .limit(1);
      if (existingPattern?.length) {
        skipped++;
        continue;
      }

      const embedding = await generateEmbedding(`pattern: ${content}`);
      const { error: insertErr } = await supabase.from("ai_reply_knowledge").insert({
        category: "pattern",
        title,
        content,
        importance: 9,
        conversation_state: "applying_pattern",
        ...(embedding ? { embedding: JSON.stringify(embedding) } : {}),
      });

      if (insertErr) {
        errors.push(`${conv.id}: insert error: ${insertErr.message}`);
        continue;
      }

      // 同一顧客の再処理を防ぐため学習済みリストへ追加
      learnedTexts.push(`${title}\n${content}`);
      processed++;

      // 6) レート制限対策: 1件ごとに間隔を空ける
      await new Promise((r) => setTimeout(r, 2000));
    } catch (e) {
      errors.push(`${conv.id}: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }

  // 8) レスポンス
  return NextResponse.json({ ok: true, processed, skipped, errors });
}

// GET: 未学習件数の確認（潜在意識パターン未学習の成約・申込済み会話数）
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const internalSecret = process.env.INTERNAL_API_SECRET;
  const auth = req.headers.get("authorization");
  const validCron = cronSecret && auth === `Bearer ${cronSecret}`;
  const validInternal = internalSecret && auth === `Bearer ${internalSecret}`;
  if (!validCron && !validInternal) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { data: convs } = await supabase
    .from("conversations")
    .select("id, customer_name")
    .in("status", CLOSED_STATUSES);

  const { data: learnedRows } = await supabase
    .from("ai_reply_knowledge")
    .select("title, content")
    .like("title", "%パターン%")
    .like("content", "%潜在意識%");

  type LearnedRow = { title: string | null; content: string | null };
  const learnedTexts = ((learnedRows ?? []) as LearnedRow[]).map(
    (r) => `${r.title ?? ""}\n${r.content ?? ""}`
  );

  // 2026-09-27: テスト用の会話（YUMA）は学びに入れない
  const typedConvs = ((convs ?? []) as Array<{ id: string; customer_name: string | null }>).filter((c) => !isTestConversation(c.id));
  const remaining = typedConvs.filter(
    (c) => !c.customer_name || !learnedTexts.some((t) => t.includes(c.customer_name as string))
  ).length;

  return NextResponse.json({ ok: true, total: typedConvs.length, remaining });
}
