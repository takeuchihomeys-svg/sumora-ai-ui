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
    .is("loss_analyzed_at", null)
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

      const validMsgs = [...msgs].reverse().filter((m) => (m.text as string)?.trim());

      // 短会話ガード：顧客発言3通未満 or 合計200字未満は分析材料不足（幻覚防止）
      const customerMsgs = validMsgs.filter((m) => m.sender !== "staff");
      const totalChars = validMsgs.reduce((sum, m) => sum + (m.text as string).trim().length, 0);
      if (customerMsgs.length < 3 || totalChars < 200) {
        skipped++;
        continue;
      }

      const transcript = validMsgs
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
この会話を分析し、失注につながった可能性のある「避けるべき対応パターン」を最大3点抽出してください。
- 各パターンは「〜しない。代わりに〜する」の形式で、具体的な改善行動まで書く
- スタッフの対応（返信の遅さ・提案のズレ・押しの弱さ/強さ・情報不足など）に着目する
- 顧客名・物件名・電話番号・住所は出力に含めないこと（個人情報保護のため。「顧客」「物件」など一般化した表現に置き換える）
- 顧客都合のみで失注した場合（転勤中止など、対応に問題がない場合）は no_fault を true にし、patterns は空配列にする
- 分析できる材料が不十分な場合（会話が短い・失注理由が読み取れない等）も patterns を空配列にし no_fault を true にすること（推測でパターンを作らない）

## 出力形式
以下のJSONのみを出力してください。前置き・コードブロック・説明は一切不要です。
{
  "no_fault": true または false,
  "patterns": ["避けるべきパターン1", "パターン2", "パターン3"]
}`;

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

      // JSONパース（コードブロック囲み等の揺れに対応）
      let parsed: { no_fault?: boolean; patterns?: string[] } | null = null;
      try {
        const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
        if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
      } catch {
        parsed = null;
      }

      if (!parsed) {
        console.warn("[auto-analyze-losers] JSON parse failed:", convId, analysisText.slice(0, 100));
        failed++;
        continue;
      }

      // 分析済みフラグ（毎日の再課金防止）
      await supabase
        .from("conversations")
        .update({ loss_analyzed_at: new Date().toISOString() })
        .eq("id", convId);

      const patterns = (parsed.patterns ?? []).filter((p) => typeof p === "string" && p.trim());

      // no_fault: true または patterns 空配列（顧客都合の失注・判断材料不足）→ knowledge保存をスキップ
      if (parsed.no_fault === true || !patterns.length) {
        skipped++;
        continue;
      }

      const title = `失注パターン_${convId.slice(-6)}_${ymd}`;

      const result = await upsertKnowledge(supabase, {
        title,
        content: patterns.map((p) => `- ${p.trim()}`).join("\n"),
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

// POST: 手動実行用（CRON_SECRET認証必須）
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return run();
}
