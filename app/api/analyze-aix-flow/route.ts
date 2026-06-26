import { NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "") });

// JST日付文字列を返す
function jstDateStr(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// POST /api/analyze-aix-flow
// 成功会話を分析してAIXフロー誘導ガイドを自動更新
// Cron: 毎日 06:00 UTC (15:00 JST) と 18:00 UTC (03:00 JST翌日) に実行
export async function POST() {
  try {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const today = jstDateStr();

    // 1. 直近30日のAIX使用ログ（テンプレート情報含む）
    const { data: usageLogs } = await supabase
      .from("aix_usage_logs")
      .select("aix_type, template_name, template_category, conversation_id, conversation_status")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(200);

    // 2. 成功した会話ID（成約パターンが記録されたもの）を取得
    const { data: patterns } = await supabase
      .from("ai_reply_knowledge")
      .select("title, content")
      .eq("category", "pattern")
      .ilike("title", "成約パターン%")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(15);

    // 3. AIX種類ごとの使用回数・テンプレート別集計
    type UsageLog = { aix_type: string; template_name: string | null; template_category: string | null; conversation_id: string; conversation_status: string | null };
    const logs = (usageLogs ?? []) as UsageLog[];

    const aixCount: Record<string, number> = {};
    const templateCount: Record<string, number> = {};
    for (const log of logs) {
      aixCount[log.aix_type] = (aixCount[log.aix_type] ?? 0) + 1;
      if (log.template_name) {
        const key = `${log.aix_type}→${log.template_name}`;
        templateCount[key] = (templateCount[key] ?? 0) + 1;
      }
    }

    const aixCountText = Object.entries(aixCount).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}: ${v}回`).join(", ") || "データなし（まだ使用記録なし）";

    const templateCountText = Object.entries(templateCount).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([k, v]) => `${k}: ${v}回`).join("\n") || "テンプレート使用記録なし";

    const patternsText = (patterns ?? [])
      .map((p) => `${p.title}: ${(p.content as string).slice(0, 100)}`)
      .join("\n") || "成約パターンデータなし";

    // 4. Claude Haikuで分析・ガイド更新
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 700,
      messages: [{
        role: "user",
        content: `以下の実際の使用データを分析して、スモラの賃貸仲介スタッフ向け「AIXボタン誘導ガイド」を更新してください。

【AIXボタン使用回数（過去30日の実績）】
${aixCountText}

【AIX × テンプレートの組み合わせ実績（よく使われた順）】
${templateCountText}

【直近の成約パターン（内覧・申込が決まった会話から学習）】
${patternsText}

【AIXボタン一覧（参考）】
- property_recommendation（物件オススメ）: 条件揃った後
- property_send（物件送る）: 物件画像を送付した後
- property_check_result（物件確認した）: 空室確認の結果報告
- estimate_sheet（見積書送る）: 初期費用見積もり送付
- viewing_invite（内覧へ！）: 内覧日程の提案
- meeting_place（待ち合わせ）: 内覧確定後の待ち合わせ案内
- application_push（申込へ！）: 申込を促す

実際の使用データに基づいて、以下の形式でガイドを出力してください（500文字以内）:

【AIXフロー誘導ガイド — 更新日: ${today}】

▶ [お客様の状況] → [AIXボタン名] + [理由/使うタイミング]
（3〜5フェーズ、実績データに基づいて）

【よく使われるテンプレートの組み合わせ】
・[AIX名] × [テンプレート名]: [使うシーン]
（実績上位2〜3件のみ。データがなければ省略）

【半自動3ステップ】
AIXを選ぶ → 生成を確認 → 送信`,
      }],
    });

    const generated = resp.content[0].type === "text" ? resp.content[0].text.trim() : null;
    if (!generated) return NextResponse.json({ ok: false, error: "generation failed" });

    // 4. ai_promptsにupsert
    const { error } = await supabase.from("ai_prompts").upsert({
      key: "aix_flow_guide",
      label: "AIXフロー誘導ガイド",
      content: generated,
      updated_at: new Date().toISOString(),
    }, { onConflict: "key" });

    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, updated: today, content: generated });
  } catch (e) {
    console.error("[analyze-aix-flow]", e);
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
