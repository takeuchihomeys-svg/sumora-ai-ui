import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "@/app/lib/supabase";
import { upsertKnowledge } from "@/app/lib/knowledge-utils";

// 失注パターン自動学習バッチ
// closed_lost になった会話を Haiku で分析し「避けるべき対応パターン」を ai_reply_knowledge に記録
// 毎日1回（vercel.json cron: auto-star-winners の10分後）

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function run() {
  // 過去14日以内に closed_lost になった会話（最大20件）
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  const { data: lostConvs, error: convErr } = await supabase
    .from("conversations")
    .select("id, customer_name")
    .eq("status", "closed_lost")
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(20);

  if (convErr) {
    console.error("[auto-analyze-losers] conv fetch error:", convErr.message);
    return NextResponse.json({ ok: false, error: convErr.message }, { status: 500 });
  }

  if (!lostConvs?.length) {
    return NextResponse.json({ ok: true, analyzed: 0, message: "no closed_lost conversations in 14 days" });
  }

  const today = new Date();
  const ymd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;

  let analyzed = 0;
  let inserted = 0;
  let merged = 0;
  let skipped = 0;
  let failed = 0;

  for (const conv of lostConvs) {
    const convId = conv.id as string;

    try {
      // 直近40メッセージを取得（DESC → reverse で時系列順に）
      const { data: msgs, error: msgErr } = await supabase
        .from("messages")
        .select("sender, text, created_at")
        .eq("conversation_id", convId)
        .order("created_at", { ascending: false })
        .limit(40);

      if (msgErr || !msgs?.length) {
        if (msgErr) console.warn("[auto-analyze-losers] messages fetch error:", convId, msgErr.message);
        skipped++;
        continue;
      }

      const transcript = [...msgs]
        .reverse()
        .filter((m) => (m.text as string)?.trim())
        .map((m) => `[${m.sender === "staff" ? "スタッフ" : "顧客"}] ${m.text as string}`)
        .join("\n");

      if (!transcript) {
        skipped++;
        continue;
      }

      const prompt = `あなたは不動産営業AIのアドバイザーです。
以下は失注（closed_lost）した顧客とのLINE会話ログです。

## 会話ログ（古い順）
顧客名: ${(conv.customer_name as string) ?? "不明"}
${transcript}

## 指示
この会話を分析し、失注につながった可能性のある「避けるべき対応パターン」を最大3点、箇条書きで抽出してください。
- 各項目は「〜しない。代わりに〜する」の形式で、具体的な改善行動まで書く
- スタッフの対応（返信の遅さ・提案のズレ・押しの弱さ/強さ・情報不足など）に着目する
- 顧客都合のみで失注した場合（転勤中止など、対応に問題がない場合）は「対応に問題なし」とだけ書く
- 前置きや結論のまとめは不要。箇条書きのみ出力する`;

      const message = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      });

      const analysisText = message.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("\n")
        .trim();

      analyzed++;

      if (!analysisText || analysisText.includes("対応に問題なし")) {
        skipped++;
        continue;
      }

      const title = `失注パターン_${convId.slice(-6)}_${ymd}`;

      const result = await upsertKnowledge(supabase, {
        title,
        content: analysisText,
        category: "principle",
        importance: 8,
      });

      if (result === "inserted") inserted++;
      else if (result === "merged") merged++;
      else skipped++;
    } catch (e) {
      failed++;
      console.error("[auto-analyze-losers] analyze error:", convId, e);
    }
  }

  console.log(`[auto-analyze-losers] done: analyzed=${analyzed} inserted=${inserted} merged=${merged} skipped=${skipped} failed=${failed} convs=${lostConvs.length}`);
  return NextResponse.json({
    ok: true,
    convs: lostConvs.length,
    analyzed,
    inserted,
    merged,
    skipped,
    failed,
  });
}

// GET: Vercel cron から呼ばれる（Authorization: Bearer <CRON_SECRET> を自動付与）
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return run();
}

// POST: 手動実行用
export async function POST() {
  return run();
}
