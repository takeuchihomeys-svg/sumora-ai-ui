import { NextRequest, NextResponse } from "next/server";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { supabase } from "@/app/lib/supabase";

const model = new ChatAnthropic({
  model: "claude-sonnet-4-6",
  maxTokens: 600,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
});

// ── 構造化JSON出力プロンプト ──────────────────────────────────────────────
const SYSTEM = `あなたは賃貸仲介の営業アシスタントです。
お客さんの会話・条件・メモを深く読み込み、以下のJSON形式のみで出力してください。
説明文・マークダウン・前後のテキストは一切付けず、JSONのみ出力すること。

{
  "situation": "現在の状況を15文字以内（例: 内覧3物件の日程調整中）",
  "inspection": {
    "requested": true,
    "done": false,
    "properties": ["内覧予定or済みの物件名（最大3件）"]
  },
  "estimate": {
    "requested": false
  },
  "requirements": ["お客さんの要望・こだわり（最大3件・各30文字以内・具体的に）"],
  "opinions": ["お客さんの性格・傾向・感情・営業ヒント（最大2件・各30文字以内・具体的に）"],
  "our_actions": ["スタッフがやったこと（最大2件・各20文字以内）"],
  "winning_pattern": "今この瞬間に成約につながる具体的な行動を50文字以内で。物件名・理由・タイミングまで含めて詳しく書く",
  "next_action": "今すぐスタッフが打つべき具体的な次の1手を40文字以内で（いつ・何を・どうする）"
}

品質ルール：
・requirements と opinions は「慎重派」「即決タイプ」などの単語レベルではなく、具体的な根拠や状況を含めて書くこと
  良い例: 「実物を見て複数比較したあとに決めたい慎重派」「割引提示と日程提案に即反応する実行力タイプ」
  悪い例: 「慎重派」「割引に反応」

・winning_pattern は最重要フィールド。以下を必ず含める：
  ① 具体的に何をするか（どの物件・どのアクション）
  ② なぜそれが有効か（お客さんの特性や現状との紐付け）
  ③ そうすればどうなるか（成約への道筋）
  良い例: 「City Spire難波WESTの希望号室の内覧日程を最速提示すれば、セレニテとの実物比較後に申込確定まで繋がる」
  悪い例: 「内覧日程を提案すれば決まる」

・inspection.requested: お客さんが内覧したいと言っている or 内覧日程を調整中なら true
・inspection.done: 実際に内覧済みなら true
・estimate.requested: 初期費用・見積計算を求めているなら true`;

const STATUS_LABEL: Record<string, string> = {
  new_inquiry:     "新規問い合わせ",
  hot:             "毎日物件出し中",
  property_search: "物件探し中",
  pending:         "検討中",
};

// ai_summary_json のスキーマ定義
export type SummaryJson = {
  situation?: string;
  inspection?: { requested?: boolean; done?: boolean; properties?: string[] };
  estimate?: { requested?: boolean };
  requirements?: string[];
  opinions?: string[];
  our_actions?: string[];
  winning_pattern?: string;
  next_action?: string;
};

// JSON → テキスト変換（generate-reply の ★決まるパターン抽出との後方互換を維持）
function jsonToText(j: SummaryJson): string {
  const lines: string[] = [];

  if (j.situation) lines.push(`・${j.situation}`);

  if (j.inspection) {
    const parts: string[] = [];
    if (j.inspection.requested) parts.push(j.inspection.done ? "希望あり・実施済み" : "希望あり・未実施");
    else parts.push("希望なし");
    if (j.inspection.properties && j.inspection.properties.length > 0) {
      parts.push(j.inspection.properties.join("・"));
    }
    lines.push(`・内覧: ${parts.join(" → ")}`);
  }

  if (j.requirements && j.requirements.length > 0) {
    lines.push(`・要望: ${j.requirements.join(" / ")}`);
  }

  if (j.opinions && j.opinions.length > 0) {
    lines.push(`・意見: ${j.opinions.join(" / ")}`);
  }

  if (j.our_actions && j.our_actions.length > 0) {
    lines.push(`・アクション: ${j.our_actions.join(" → ")}`);
  }

  if (j.winning_pattern) {
    lines.push(`★決まるパターン: ${j.winning_pattern}`);
  }

  if (j.next_action) {
    lines.push(`🎯次のアクション: ${j.next_action}`);
  }

  return lines.join("\n");
}

type SummaryRequest = {
  customer_id?:         string;
  customer_name?:       string;
  status?:              string;
  desired_area?:        string | null;
  floor_plan?:          string | null;
  floor_area_min?:      number | null;
  rent_min?:            number | null;
  rent_max?:            number | null;
  walk_minutes?:        number | null;
  move_in_time?:        string | null;
  building_age?:        number | null;
  initial_cost_limit?:  number | null;
  preferences?:         string | null;
  ng_points?:           string | null;
  other_requests?:      string | null;
  property_memo?:       string | null;
  property_send_count?: number | null;
  additional_conditions?: string | null;
  last_message?:        string | null;
  last_message_sender?: string | null;
  conversation_id?:     string | null;
  fetch_from_db?:       boolean;
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as SummaryRequest;

    // fetch_from_db: webhook などから customer_id のみ渡す場合 → DBから全データ取得
    let c: SummaryRequest = body;
    if (body.fetch_from_db && body.customer_id) {
      const { data: dbC } = await supabase
        .from("property_customers")
        .select("customer_name, status, desired_area, floor_plan, floor_area_min, rent_min, rent_max, walk_minutes, move_in_time, building_age, initial_cost_limit, preferences, ng_points, other_requests, property_memo, property_send_count, additional_conditions, ai_summary_at")
        .eq("id", body.customer_id)
        .single();
      if (dbC) {
        c = { ...body, ...(dbC as Partial<SummaryRequest & { ai_summary_at?: string }>) };

        // スロットリング: 2時間以内に生成済みなら会話件数チェック
        const summaryAt = (dbC as Record<string, unknown>).ai_summary_at as string | null;
        if (summaryAt) {
          const ageMs = Date.now() - new Date(summaryAt).getTime();
          if (ageMs < 2 * 60 * 60 * 1000) {
            // 直近の新着メッセージ数を確認（3件未満ならスキップ）
            if (body.conversation_id) {
              const { count } = await supabase
                .from("messages")
                .select("id", { count: "exact", head: true })
                .eq("conversation_id", body.conversation_id)
                .gt("created_at", summaryAt);
              if ((count ?? 0) < 3) {
                const { data: existing } = await supabase
                  .from("property_customers")
                  .select("ai_summary, ai_summary_json")
                  .eq("id", body.customer_id)
                  .single();
                return NextResponse.json({
                  summary: existing?.ai_summary ?? "",
                  summaryJson: existing?.ai_summary_json ?? null,
                  cached: true,
                });
              }
            } else {
              // conversation_id なしのスロットリングは1時間
              if (ageMs < 1 * 60 * 60 * 1000) {
                const { data: existing } = await supabase
                  .from("property_customers")
                  .select("ai_summary, ai_summary_json")
                  .eq("id", body.customer_id)
                  .single();
                return NextResponse.json({
                  summary: existing?.ai_summary ?? "",
                  summaryJson: existing?.ai_summary_json ?? null,
                  cached: true,
                });
              }
            }
          }
        }
      }
    }

    // プロンプト管理UIで上書き可能（なければコード定数をフォールバック）
    const { data: promptRow } = await supabase
      .from("ai_prompts")
      .select("content")
      .eq("key", "customer_summary_system")
      .single();
    const systemPrompt = (promptRow?.content as string | null) ?? SYSTEM;

    // 会話履歴を取得
    let conversationHistory = "";
    if (c.conversation_id) {
      const { data: msgs } = await supabase
        .from("messages")
        .select("sender, text, created_at")
        .eq("conversation_id", c.conversation_id)
        .neq("text", "[画像]")
        .neq("text", "[動画]")
        .not("text", "is", null)
        .order("created_at", { ascending: false })
        .limit(30);
      if (msgs && msgs.length > 0) {
        const lines = (msgs as Array<{ sender: string; text: string }>)
          .reverse()
          .map((m) => `${m.sender === "customer" ? "お客さん" : "スタッフ"}: ${(m.text || "").slice(0, 120)}`)
          .join("\n");
        conversationHistory = `\n\n【直近の会話履歴】\n${lines}`;
      }
    }

    // 過去の成約パターン（学習済み）と next_action 改善ルール を並列取得
    const [learnedPatternsRes, nextActionRulesRes] = await Promise.all([
      supabase
        .from("ai_reply_knowledge")
        .select("content")
        .eq("category", "pattern")
        .ilike("title", "成約パターン_%")
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("ai_reply_knowledge")
        .select("content")
        .eq("category", "next_action_pattern")
        .neq("hypothesis_status", "rejected")
        .order("apply_count", { ascending: false })
        .limit(8),
    ]);

    const learnedPatternsNote = (learnedPatternsRes.data ?? []).length > 0
      ? `\n\n【過去の成約パターン（学習済み・最優先で参照）】\n${
          (learnedPatternsRes.data as Array<{ content: string }>).map(p => p.content).join("\n---\n")
        }`
      : "";

    const nextActionRulesNote = (nextActionRulesRes.data ?? []).length > 0
      ? `\n\n【next_action予測の改善ルール（実際の行動との差分から学習済み・next_action生成時に必ず参照すること）】\n${
          (nextActionRulesRes.data as Array<{ content: string }>).map(p => p.content).join("\n---\n")
        }`
      : "";

    const rentStr = (c.rent_min || c.rent_max)
      ? `${c.rent_min ? Math.floor(c.rent_min / 10000) + "万〜" : "〜"}${c.rent_max ? Math.floor(c.rent_max / 10000) + "万" : ""}`
      : null;

    const info = [
      `名前: ${c.customer_name}`,
      `ステータス: ${STATUS_LABEL[c.status ?? ""] ?? c.status}`,
      c.desired_area         && `希望エリア: ${c.desired_area}`,
      c.floor_plan           && `間取り: ${c.floor_plan}`,
      c.floor_area_min       && `広さ: ${c.floor_area_min}㎡以上`,
      rentStr                && `家賃: ${rentStr}`,
      c.walk_minutes         && `駅徒歩: ${c.walk_minutes}分以内`,
      c.move_in_time         && `入居時期: ${c.move_in_time}`,
      c.building_age         && `築年数: ${c.building_age}年以内`,
      c.initial_cost_limit   && `初期費用: ${Math.floor(c.initial_cost_limit / 10000)}万以内`,
      c.preferences          && `こだわり: ${c.preferences}`,
      c.ng_points            && `NG条件: ${c.ng_points}`,
      c.other_requests       && `その他希望: ${c.other_requests}`,
      c.property_memo        && `社内メモ: ${c.property_memo}`,
      c.property_send_count != null && `物件送付回数: ${c.property_send_count}回`,
      c.additional_conditions && `追加・変更履歴:\n${c.additional_conditions}`,
      c.last_message         && `最後のメッセージ（${c.last_message_sender === "customer" ? "お客さん" : "スタッフ"}）:「${c.last_message}」`,
    ].filter(Boolean).join("\n") + learnedPatternsNote + nextActionRulesNote + conversationHistory;

    const res = await model.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(info),
    ]);

    const rawText = typeof res.content === "string" ? res.content : JSON.stringify(res.content);

    // JSON抽出
    let summaryJson: SummaryJson = {};
    try {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) summaryJson = JSON.parse(match[0]) as SummaryJson;
    } catch {
      // JSON解析失敗時は空オブジェクト
    }

    // テキスト変換（generate-reply との後方互換）
    const summary = jsonToText(summaryJson) || rawText.trim();

    if (c.customer_id) {
      await supabase.from("property_customers").update({
        ai_summary: summary,
        ai_summary_json: summaryJson,
        ai_summary_at: new Date().toISOString(),
      }).eq("id", c.customer_id);

      // next_action 予測をログに保存（差分学習の基準点）
      if (summaryJson.next_action) {
        supabase.from("next_action_logs").insert({
          customer_id: c.customer_id,
          conversation_id: c.conversation_id ?? null,
          predicted_action: summaryJson.next_action,
        }).then(() => {}, () => {});
      }
    }

    return NextResponse.json({ summary, summaryJson });
  } catch (e) {
    console.error("customer-summary error:", e);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
