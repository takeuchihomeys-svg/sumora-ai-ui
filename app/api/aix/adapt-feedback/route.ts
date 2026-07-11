import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 30;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });

export async function POST(request: NextRequest) {
  try {
    const { adaptedText, recentConversation, rating, comment } = await request.json() as {
      adaptedText: string;
      baseText?: string;
      recentConversation: string; // 直近会話テキスト
      rating: "good" | "bad";
      comment?: string; // bad時のユーザーコメント
    };

    if (rating === "good") {
      // 👍: パターンをHaikuで分析してルール化
      const res = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{
          role: "user",
          content: `スモラ賃貸仲介のLINE内覧誘導文が「よかった」と評価されました。
どんな会話の流れや表現が効果的だったか、次回に活かせるルールを1文で抽出してください。

【会話の流れ】
${recentConversation}

【生成された内覧誘導文】
${adaptedText}

ルールを1文（50文字以内）で出力してください。説明不要。`,
        }],
      });
      const rule = res.content[0].type === "text" ? res.content[0].text.trim() : "";
      if (rule) {
        // 既存の類似ルールをチェック（先頭20文字ilike）
        const keyword = rule.slice(0, 20);
        const { data: existing } = await supabase
          .from("adaptation_improvement_rules")
          .select("id, example_count, confidence")
          .eq("category", "greeting_viewing")
          .ilike("rule_text", `%${keyword}%`)
          .limit(1);

        if (existing && existing.length > 0) {
          // 既存ルールの信頼度を上げる
          await supabase
            .from("adaptation_improvement_rules")
            .update({
              example_count: ((existing[0].example_count as number | null) ?? 1) + 1,
              confidence: Math.min(1.0, ((existing[0].confidence as number | null) ?? 0.5) + 0.05),
              last_triggered_at: new Date().toISOString(),
            })
            .eq("id", existing[0].id as string);
        } else {
          // 新規ルールを保存
          await supabase.from("adaptation_improvement_rules").insert({
            category: "greeting_viewing",
            rule_text: rule,
            confidence: 0.6,
            example_count: 1,
            is_active: true,
          });
        }
      }
      return NextResponse.json({ ok: true, rule });
    } else {
      // 👎: ユーザーコメントからNG理由をルール化
      const prompt = comment
        ? `スモラ賃貸仲介のLINE内覧誘導文が「イマイチ」と評価されました。
ユーザーのコメント：「${comment}」

どう改善すべきか、次回に活かせる具体的なルールを1文で出力してください。（50文字以内、説明不要）

【生成された内覧誘導文】
${adaptedText}`
        : `スモラ賃貸仲介のLINE内覧誘導文が「イマイチ」と評価されました。
どう改善すべきか、次回に活かせる具体的なルールを1文で出力してください。（50文字以内、説明不要）

【会話の流れ】
${recentConversation}

【生成された内覧誘導文（NG）】
${adaptedText}`;

      const res = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      });
      const rule = res.content[0].type === "text" ? res.content[0].text.trim() : "";
      if (rule) {
        await supabase.from("adaptation_improvement_rules").insert({
          category: "greeting_viewing",
          rule_text: rule,
          confidence: 0.5,
          example_count: 1,
          is_active: true,
        });
      }

      // ❓AI質問タブ（ai_feedback_items）にも追加分析用の質問として積む。
      // 竹内さんが回答すると /api/ai-feedback の Opus 4.8 ルール化フローに乗る。
      // ※ ai_feedback_items に priority カラムは無いため confidence: "low" で優先度低を表現し、
      //    UI側（TemplateModal）で adapt_feedback カテゴリを一番下にまとめて表示する
      const feedbackQuestion = `「会話を合わせる」の結果が修正されました。\n\n【会話の流れ】\n${recentConversation}\n\n【AI生成文（修正前）】\n${adaptedText}\n\n【ユーザーコメント】\n${comment || "（なし）"}\n\nどう改善すれば次回の「会話を合わせる」が自然になりますか？`;
      const { error: fbError } = await supabase.from("ai_feedback_items").insert({
        category: "adapt_feedback",
        question: feedbackQuestion,
        status: "pending",
        confidence: "low",
      });
      if (fbError) console.error("[adapt-feedback] ai_feedback_items insert error:", fbError.message);

      return NextResponse.json({ ok: true, rule });
    }
  } catch {
    return NextResponse.json({ ok: false, error: "server error" }, { status: 500 });
  }
}
