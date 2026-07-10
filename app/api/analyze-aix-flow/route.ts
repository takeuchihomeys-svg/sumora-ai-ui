import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 60;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""), timeout: 45_000 });

// JST日付文字列を返す
function jstDateStr(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// POST /api/analyze-aix-flow
// 成功会話を分析してAIXフロー誘導ガイドを自動更新
// Cron: 毎日 06:00 UTC (15:00 JST) と 18:00 UTC (03:00 JST翌日) に実行
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const today = jstDateStr();

    // 1. 直近30日のAIX使用ログ・2. 成約パターン・3. 蓄積ノウハウ を並列取得
    //    B07: ③を追加することで analyze-diffs/auto-knowledge が蓄積した原則/修正ルールをガイドに反映する
    const [{ data: usageLogs }, { data: patterns }, { data: principles }] = await Promise.all([
      supabase
        .from("aix_usage_logs")
        .select("aix_type, template_name, template_category, conversation_id, conversation_status, suggested_action")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("ai_reply_knowledge")
        .select("title, content")
        .eq("category", "pattern")
        .ilike("title", "成約パターン%")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(15),
      // B07: 高重要度の原則・修正ルール・次アクションパターン（仮説未却下・適用実績降順）
      // next_action_pattern: log-aix-usage の runGapAnalysis() が保存する予測精度改善ルール
      supabase
        .from("ai_reply_knowledge")
        .select("title, content, category")
        .in("category", ["principle", "correction", "next_action_pattern"])
        .neq("hypothesis_status", "rejected")
        .gte("importance", 7)
        .order("apply_count", { ascending: false })
        .limit(10),
    ]);

    // 3. AIX種類ごとの使用回数・テンプレート別・成約率・予測一致率の集計
    type UsageLog = { aix_type: string; template_name: string | null; template_category: string | null; conversation_id: string; conversation_status: string | null; suggested_action: string | null };
    const logs = (usageLogs ?? []) as UsageLog[];

    // 3-a. conversation_status はAIX送信時点のスナップショットで closed_won はほぼ含まれない。
    // conversations テーブルの「現在の」status を別クエリで取得して突合する。
    const convIds = [...new Set(logs.map((l) => l.conversation_id).filter(Boolean))];
    const statusMap: Record<string, string> = {};
    if (convIds.length > 0) {
      // B09: IN 句の URL 長制限回避のため 200 件ずつチャンク（usageLogs limit=200 超に備える）
      for (let i = 0; i < convIds.length; i += 200) {
        const chunk = convIds.slice(i, i + 200);
        const { data: convStatuses } = await supabase
          .from("conversations")
          .select("id, status")
          .in("id", chunk);
        for (const c of (convStatuses ?? []) as { id: string; status: string | null }[]) {
          if (c.status) statusMap[c.id] = c.status;
        }
      }
    }

    const aixCount: Record<string, number> = {};
    const templateCount: Record<string, number> = {};
    // aix_type別: closed_won / closed_lost / その他 のカウント
    const statusCount: Record<string, { won: number; lost: number; other: number }> = {};
    // aix_type別: suggested_action（AI予測）と実際のaix_typeが一致した件数
    const matchCount: Record<string, { matched: number; predicted: number }> = {};
    for (const log of logs) {
      aixCount[log.aix_type] = (aixCount[log.aix_type] ?? 0) + 1;
      if (log.template_name) {
        const key = `${log.aix_type}→${log.template_name}`;
        templateCount[key] = (templateCount[key] ?? 0) + 1;
      }
      // 成約ステータス集計（conversationsテーブルの現在のstatusで判定。なければ送信時スナップショットにフォールバック）
      const currentStatus = statusMap[log.conversation_id] ?? log.conversation_status;
      const sc = statusCount[log.aix_type] ?? { won: 0, lost: 0, other: 0 };
      if (currentStatus === "closed_won") sc.won += 1;
      else if (currentStatus === "closed_lost") sc.lost += 1;
      else sc.other += 1;
      statusCount[log.aix_type] = sc;
      // 予測一致集計（suggested_actionが記録されているログのみ対象）
      if (log.suggested_action) {
        const mc = matchCount[log.aix_type] ?? { matched: 0, predicted: 0 };
        mc.predicted += 1;
        if (log.suggested_action === log.aix_type) mc.matched += 1;
        matchCount[log.aix_type] = mc;
      }
    }

    const aixCountText = Object.entries(aixCount).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}: ${v}回`).join(", ") || "データなし（まだ使用記録なし）";

    const templateCountText = Object.entries(templateCount).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([k, v]) => `${k}: ${v}回`).join("\n") || "テンプレート使用記録なし";

    // closed_won率 = won / (won + lost)。決着済みサンプルが3件以上あるaix_typeのみ、率の降順
    // （won+lost < 3 はサンプル不足として率を出さない：1件の偶然で0%/100%になるのを防ぐ）
    const MIN_DECIDED_SAMPLES = 3;
    const winRateText = Object.entries(statusCount)
      .filter(([, s]) => s.won + s.lost >= MIN_DECIDED_SAMPLES)
      .map(([k, s]) => ({ k, rate: s.won / (s.won + s.lost), won: s.won, lost: s.lost }))
      .sort((a, b) => b.rate - a.rate)
      .map((e) => `${e.k}: ${Math.round(e.rate * 100)}%（成約${e.won}件/失注${e.lost}件）`)
      .join(", ") || "成約データ不足（決着済み会話が3件未満のため集計なし）";

    // 予測一致率 = matched / predicted（aix_type別）
    const matchRateText = Object.entries(matchCount)
      .map(([k, m]) => ({ k, rate: m.matched / m.predicted, matched: m.matched, predicted: m.predicted }))
      .sort((a, b) => b.rate - a.rate)
      .map((e) => `${e.k}: ${Math.round(e.rate * 100)}%（${e.matched}/${e.predicted}件）`)
      .join(", ") || "予測データなし";

    const patternsText = (patterns ?? [])
      .map((p) => `${p.title}: ${(p.content as string).slice(0, 100)}`)
      .join("\n") || "成約パターンデータなし";

    // B07: 蓄積済みノウハウ（原則・修正ルール・次アクションパターン）をガイド生成に注入
    const principlesText = (principles ?? [])
      .map((p) => {
        const cat = p.category as string;
        const label = cat === "correction" ? "修正" : cat === "next_action_pattern" ? "次行動ルール" : "原則";
        return `[${label}] ${(p.content as string).slice(0, 120)}`;
      })
      .join("\n") || "蓄積ノウハウなし";

    // 4. Claude Haikuで分析・ガイド更新
    const resp = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 700,
      messages: [{
        role: "user",
        content: `以下の実際の使用データを分析して、スモラの賃貸仲介スタッフ向け「AIXボタン誘導ガイド」を更新してください。

【AIXボタン使用回数（過去30日の実績）】
${aixCountText}

【AIX × テンプレートの組み合わせ実績（よく使われた順）】
${templateCountText}

【成約率の高いAIXアクション（closed_won率降順・過去30日）】
${winRateText}

【予測一致率（AIが提案したアクションが実際に使われた割合・aix_type別）】
${matchRateText}

【直近の成約パターン（内覧・申込が決まった会話から学習）】
${patternsText}

【学習済みノウハウ（原則・修正ルール・適用実績降順）】
${principlesText}

【AIXボタン一覧（参考）】
- property_recommendation（物件オススメ）: 条件揃った後
- property_send（物件ピックアップした）: 物件画像を送付した後
- property_check_result（物件確認した）: 空室確認の結果報告
- estimate_sheet（見積書送る）: 初期費用見積もり送付
- viewing_invite（内覧へ！）: 内覧日程の提案
- meeting_place（待ち合わせ）: 内覧確定後の待ち合わせ案内
- application_push（申込へ！）: 申込を促す

実際の使用データに基づいて、以下の形式でガイドを出力してください（500文字以内）:

【AIXフロー誘導ガイド — 更新日: ${today}】

▶ [お客様の状況] → [AIXボタン名] + [理由/使うタイミング]
（3〜5フェーズ、実績データに基づいて。成約率の高いAIXアクションを優先的に組み込むこと）

【成約につながりやすいアクション】
・[AIXボタン名]: 成約率[%]（成約率データがあれば上位1〜2件を挙げ、活用のコツを一言。データがなければ省略）

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

// GET /api/analyze-aix-flow
// Vercel CronはGETでリクエストするため、認証チェック後POSTへ委譲
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return POST(req);
}
