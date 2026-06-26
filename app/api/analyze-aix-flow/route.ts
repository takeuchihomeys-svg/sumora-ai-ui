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
    // 1. 直近30日の成約パターン（最大20件）
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const { data: patterns } = await supabase
      .from("ai_reply_knowledge")
      .select("title, content")
      .eq("category", "pattern")
      .ilike("title", "成約パターン%")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(20);

    // 2. AIXタスク使用頻度（過去30日）
    const { data: tasks } = await supabase
      .from("line_tasks")
      .select("task_type")
      .gte("created_at", since);

    const taskCounts: Record<string, number> = {};
    for (const t of (tasks ?? []) as { task_type: string }[]) {
      taskCounts[t.task_type] = (taskCounts[t.task_type] ?? 0) + 1;
    }
    const taskCountText = Object.entries(taskCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}: ${v}件`)
      .join(", ") || "データなし";

    const patternsText = (patterns ?? [])
      .map((p) => `${p.title}: ${(p.content as string).slice(0, 120)}`)
      .join("\n") || "データなし";

    // 3. Claude Haikuで分析・ガイド更新
    const today = jstDateStr();
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 700,
      messages: [{
        role: "user",
        content: `以下のデータを分析して、スモラの賃貸仲介スタッフ向け「AIXボタン誘導ガイド」を更新してください。

【直近の成約パターン（成功した会話から学習）】
${patternsText}

【AIXタスク使用頻度（過去30日）】
${taskCountText}

【AIXボタン一覧】
- 物件オススメ: 条件揃った後・物件提案文を生成
- 物件送る: 物件画像を送った後の案内文
- 物件確認した: 空室確認の結果報告（OK/NG/調査中の3種）
- 見積書送る: 初期費用見積もりを送る（テンプレートあり）
- 内覧へ！: 内覧日程の提案文を生成
- 待ち合わせ: 内覧確定後の待ち合わせ案内
- 申込へ！: 申込を促すメッセージを生成

以下の形式でガイドを出力してください（500文字以内・実用的な内容のみ）:

【AIXフロー誘導ガイド — 更新日: ${today}】

▶ [フェーズ] → [AIXボタン名] + [使うタイミング1行]
▶ [フェーズ] → [AIXボタン名] + [使うタイミング1行]
（3〜5フェーズ）

【バナーが出たら即AIXを使う】
・[バナー色/種類] → [AIXボタン名]
（2〜3点）

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
