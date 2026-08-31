// POST /api/recommend-templates
// AIX送信後の「続きテンプレ」おすすめAPI
// 入力: conversation_id, action_type, sent_message, category, templates[{ id, label, text }]
//       customer_conditions (任意): お客様の希望条件テキスト
// 出力: { ok: boolean, recommendations: [{ id, reason, score }] }（スコア降順・上位3件）
//
// Claude Sonnet で以下を判断:
// - お客様の希望条件（customer_conditions）
// - AIX生成文（sent_message）: 希望条件のどこがマッチしたか・どこが足りなかったか
// - 直近の会話メッセージ（messages テーブル: customer / staff）
// - カテゴリ内の全テンプレ候補（サブカテゴリタグ込み）
// → ギャップ分析を踏まえて最もおすすめな順にスコアをつけて返す
//
// エラー時は { ok: false, recommendations: [] } を返す（UI側はおすすめなし表示にフォールバック）

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 30;

type TemplateCandidate = { id: string; label: string; text: string; use_count?: number | null; win_rate?: number | null; recommend_shown_count?: number | null; recommend_picked_count?: number | null };
type RankedItem = { index: number; score: number; reason: string };

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      conversation_id,
      action_type,
      sent_message,
      category,
      templates,
      customer_conditions,
      customer_summary,
      sub_category,
    } = body as {
      conversation_id?: string | null;
      action_type?: string | null;
      sent_message?: string | null;
      category?: string | null;
      templates?: TemplateCandidate[];
      customer_conditions?: string | null;
      customer_summary?: string | null;
      sub_category?: string | null;
    };

    if (!Array.isArray(templates) || templates.length === 0) {
      return NextResponse.json({ ok: true, recommendations: [] });
    }

    // 1. 直近の会話メッセージ + 今回の状況（AIX履歴・Brain戦略）を並列取得
    let conversationHistory = "（会話履歴なし）";
    // 「今回が単独オススメか、複数送付後の絞り込みか」「お客様の温度感」を推薦判断に効かせる
    let situationSection = "";
    if (conversation_id) {
      const [msgsRes, aixLogsRes, convRes] = await Promise.all([
        supabase
          .from("messages")
          .select("sender, text, created_at")
          .eq("conversation_id", conversation_id)
          .neq("text", "[画像]")
          .neq("text", "[動画]")
          .not("text", "is", null)
          .order("created_at", { ascending: false })
          .limit(10),
        supabase
          .from("aix_usage_logs")
          .select("aix_type, check_pattern, created_at")
          .eq("conversation_id", conversation_id)
          .order("created_at", { ascending: false })
          .limit(20),
        supabase
          .from("conversations")
          .select("suggested_aix_meta")
          .eq("id", conversation_id)
          .single(),
      ]);

      const msgs = msgsRes.data as Array<{ sender: string; text: string }> | null;
      if (msgs && msgs.length > 0) {
        conversationHistory = msgs
          .reverse()
          .map((m) => `${m.sender === "customer" ? "顧客" : "スタッフ"}: ${(m.text || "").slice(0, 120)}`)
          .join("\n");
      }

      type AixLogRow = { aix_type: string | null; check_pattern: string | null; created_at: string };
      const aixLogs = (aixLogsRes.data ?? []) as AixLogRow[];
      const propertyLogs = aixLogs.filter(
        (l) => l.aix_type === "property_send" || l.aix_type === "property_recommendation",
      );
      // aix-template-generate と同じ補正: 今回送信したAIX自身がログに入っているため差し引く
      const CURRENT_SEND_WINDOW_MS = 30 * 60 * 1000;
      const newest = propertyLogs[0];
      const selfLogged = Boolean(
        newest &&
        newest.aix_type === action_type &&
        Date.now() - new Date(newest.created_at).getTime() < CURRENT_SEND_WINDOW_MS,
      );
      const priorSentPropertyCount = Math.max(0, propertyLogs.length - (selfLogged ? 1 : 0));
      const priorPropertySendCount = aixLogs.filter(
        (l, i) => l.aix_type === "property_send" && !(selfLogged && i === 0),
      ).length;

      const meta = (convRes.data as { suggested_aix_meta?: Record<string, unknown> | null } | null)?.suggested_aix_meta ?? null;
      const signal = typeof meta?.purchase_signal_level === "string" ? meta.purchase_signal_level : null;
      const stance = typeof meta?.engagement_stance === "string" ? meta.engagement_stance : null;
      const templateHint = typeof meta?.template_hint === "string" ? meta.template_hint : null;

      const aixHistory = aixLogs
        .slice(0, 5)
        .map((l, i) => `${i === 0 ? "最新" : `${i + 1}回前`}:${l.aix_type ?? "?"}${l.check_pattern ? `(結果:${l.check_pattern})` : ""}`)
        .join(" → ");

      situationSection = [
        "## 今回の状況（テンプレ選定の最重要判断材料）",
        `・今回のAIXより前にこの会話で物件を送付した回数: ${priorSentPropertyCount}回（うち物件ピックアップ＝複数送付: ${priorPropertySendCount}回）`,
        priorSentPropertyCount === 0
          ? "  → 今回が初めての物件送付。「お送りしたお部屋の中でも」等、複数送付済みを前提にした絞り込み系テンプレは選ばない"
          : "  → 既に送付済みの物件がある。送付済みリストとの比較・絞り込み系テンプレを選んでよい",
        aixHistory ? `・直近のAIX履歴: ${aixHistory}` : "",
        signal
          ? `・お客様の購買シグナル強度: ${signal}${
              signal === "peak" || signal === "strong"
                ? "（申込・内覧に直結するテンプレを優先。情報提供だけで終わるテンプレは順位を下げる）"
                : "（売り込み色の強いクロージングテンプレは順位を下げる）"
            }`
          : "",
        stance === "wait"
          ? "・局面スタンス: wait（今は押してはいけない局面 — 申込・クロージング系テンプレは選ばない）"
          : stance === "push"
            ? "・局面スタンス: push（次の一歩を促すテンプレを優先）"
            : "",
        templateHint ? `・Brain推奨テンプレカテゴリ（template_hint）: ${templateHint}（このカテゴリに近いテンプレを優先選択すること）` : "",
      ].filter(Boolean).join("\n");
    }

    // 2. Sonnet でおすすめを判断（ギャップ分析が複雑なため）
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
    });

    // サブカテゴリ情報をテンプレラベルから読み取り可能にする説明を生成
    const subCategoryNote = sub_category
      ? `\n## 検出済みサブカテゴリ: 【${sub_category}】\n優先的にこのサブカテゴリのテンプレを推薦してください。`
      : "";

    const prompt = `あなたは不動産スタッフのLINE返信AIアシスタントです。
AIXで1通目を送信済みです。次に送る続きのテンプレートを推薦してください。

## お客様の希望条件
${customer_conditions ? customer_conditions.slice(0, 400) : "（紐付けなし）"}
${customer_summary ? `\n## お客様プロフィール（AI分析・決まるパターン）\n${customer_summary.slice(0, 300)}\n→ このお客様に刺さる訴求軸（費用・審査・設備・立地等）に合ったテンプレを優先すること` : ""}

## AIXで送った1通目のメッセージ${action_type ? `（アクション: ${action_type}）` : ""}
${(sent_message || "（なし）").slice(0, 800)}
${situationSection ? `\n${situationSection}\n` : ""}
## ギャップ分析（内部判断）
1通目と希望条件を照合し、以下を判断してください：
- 希望条件のうち1通目でカバーできた点（何があったか）
- 希望条件のうち1通目で言及できなかった点（何が足りていなかったか）
- お客様が次に感じるであろう疑問・不安
→ この分析を踏まえて、最も適切な続きのテンプレを選んでください。
${subCategoryNote}

## 直近の会話（古い順）
${conversationHistory}

## 候補テンプレート一覧${category ? `（カテゴリ: ${category}）` : ""}
※ 【】内のタグはサブカテゴリを示します（例:【初回まとめ】【通常内覧】など）
${templates.map((t, i) => {
      const adoptionRate = (t.recommend_shown_count ?? 0) > 0
        ? Math.round(((t.recommend_picked_count ?? 0) / (t.recommend_shown_count ?? 1)) * 100)
        : null;
      const stats = [
        (t.use_count ?? 0) > 0 ? `使用${t.use_count}回` : null,
        t.win_rate != null ? `成約率${Math.round((t.win_rate as number) * 100)}%` : null,
        adoptionRate !== null ? `採用率${adoptionRate}%（おすすめ提示→選択率）` : null,
      ].filter(Boolean).join("・");
      return `[${i}] ${t.label}${stats ? ` (${stats})` : ""}\n${(t.text || "").slice(0, 300)}`;
    }).join("\n\n")}

## 指示
希望条件・1通目の内容・今回の状況（送付実績・購買シグナル）・ギャップ分析を踏まえて、
続けて送るのに最も適切なテンプレートを上位3件まで選び、理由を簡潔に答えてください。
※「今回の状況」の制約（複数送付前提テンプレの可否・押す／待つ・Brain推奨カテゴリ）は希望条件の合致より優先すること。
理由には「○○の希望に応えるため」「△△が伝えられていないため補足として」のように
ギャップ分析の内容を含めてください。

出力形式（JSON配列のみ・他のテキスト禁止）:
[{"index": 0, "score": 95, "reason": "家賃条件はカバー済み・エリアの補足が必要なため"}]`;

    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1200,
      system: "あなたは賃貸仲介サービス「スモラ」のLINE営業アシスタントです。指定されたJSON形式のみで回答し、説明文は一切付けないでください。",
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text ?? "[]";

    // JSON抽出（前後に余計なテキストがあっても配列部分だけ取り出す）
    const match = text.match(/\[[\s\S]*\]/);
    let ranked: RankedItem[] = [];
    try {
      ranked = match ? (JSON.parse(match[0]) as RankedItem[]) : [];
    } catch {
      ranked = [];
    }

    const recommendations = ranked
      .filter(
        (r) =>
          typeof r.index === "number" &&
          r.index >= 0 &&
          r.index < templates.length,
      )
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 3)
      .map((r) => ({
        id: templates[r.index].id,
        score: r.score ?? 0,
        reason: r.reason ?? "",
      }));

    return NextResponse.json({ ok: true, recommendations });
  } catch (e) {
    console.error("[recommend-templates] error:", e);
    return NextResponse.json({ ok: false, recommendations: [] });
  }
}
