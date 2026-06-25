import { NextRequest, NextResponse } from "next/server";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { supabase } from "@/app/lib/supabase";

const model = new ChatAnthropic({
  model: "claude-haiku-4-5-20251001",
  maxTokens: 400,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
});

const SYSTEM = `あなたは賃貸仲介の営業アシスタントです。
担当者がLINEを送る直前に確認する「このお客さんの特徴まとめ」を作成してください。

ルール：
・4〜6項目の箇条書き（「・」で始める）
・条件の羅列は禁止（エリア・家賃・間取り等はすでに画面表示済み）
・必ず以下の2つをカバーする：
  ①お客さんの性格・タイプ・感情状態・営業上のヒント（条件ではなく人物像）
  ②【決まるパターン認識】会話・状況を読んで「今どうすれば成約に繋がるか」を1行で書く
・前回の要約がある場合は、変わっていない情報はそのまま維持し、変化した部分のみ更新すること
・入力にない情報は書かない
・各項目は1行以内で簡潔に

【②決まるパターン認識の判断基準 — 必ずどれか1つを選んで「★決まるパターン: 〜」の形で書く】
・条件が絞られていて合う物件がまだない → 「★決まるパターン: 条件に合う1件を出せば申込む。物件探しが鍵」
・気に入った物件があって内覧前 → 「★決まるパターン: 内覧に誘えば決まる。日程提案が最優先」
・物件は気に入っているが迷っている → 「★決まるパターン: 申込みでお部屋を抑えるよう促せば動く」
・交渉が失敗した直後・NGが出た → 「★決まるパターン: 別物件の内覧に誘導すればリカバリーできる」
・申込み済みで書類待ち → 「★決まるパターン: 書類（身分証・緊急連絡先）を揃えれば次に進む」
・物件送付後まだ反応が薄い → 「★決まるパターン: 追客LINEを送って反応を確認する」
・条件が厳しくて物件がない → 「★決まるパターン: 条件緩和を提案して再ピックアップが鍵」
・内覧済みで申込み前 → 「★決まるパターン: 今すぐ申込みを促せば決まる」`;

const STATUS_LABEL: Record<string, string> = {
  new_inquiry:     "新規問い合わせ",
  hot:             "毎日物件出し中",
  property_search: "物件探し中",
  pending:         "検討中",
};

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
  previous_summary?:    string | null;
  fetch_from_db?:       boolean;
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as SummaryRequest;

    // fetch_from_db: page.tsx からの自動更新など customer_id のみ渡す場合にDBから全データ取得
    let c: SummaryRequest = body;
    if (body.fetch_from_db && body.customer_id) {
      const { data: dbC } = await supabase
        .from("property_customers")
        .select("customer_name, status, desired_area, floor_plan, floor_area_min, rent_min, rent_max, walk_minutes, move_in_time, building_age, initial_cost_limit, preferences, ng_points, other_requests, property_memo, property_send_count, additional_conditions")
        .eq("id", body.customer_id)
        .single();
      if (dbC) {
        c = { ...body, ...(dbC as Partial<SummaryRequest>) };
      }
    }

    // 会話履歴を取得（conversation_id がある場合のみ）
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

    // 学習済み成約パターンを取得（直近10件）
    const { data: learnedPatterns } = await supabase
      .from("ai_reply_knowledge")
      .select("content")
      .eq("category", "pattern")
      .ilike("title", "成約パターン_%")
      .order("created_at", { ascending: false })
      .limit(10);

    const learnedPatternsNote = learnedPatterns && learnedPatterns.length > 0
      ? `\n\n【過去の実際の成約パターン（学習済み・最優先で参照すること）】\n${
          (learnedPatterns as Array<{ content: string }>).map(p => p.content).join("\n\n---\n")
        }`
      : "";

    const rentStr = (c.rent_min || c.rent_max)
      ? `${c.rent_min ? Math.floor(c.rent_min / 10000) + "万〜" : "〜"}${c.rent_max ? Math.floor(c.rent_max / 10000) + "万" : ""}`
      : null;

    // 前回要約がある場合は引き継ぎ指示として追加
    const prevSummaryNote = c.previous_summary
      ? `\n\n【前回の要約（引き継いで更新すること）】\n${c.previous_summary}`
      : "";

    const info = [
      `名前: ${c.customer_name}`,
      learnedPatternsNote && learnedPatternsNote,
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
    ].filter(Boolean).join("\n") + prevSummaryNote + conversationHistory;

    const res = await model.invoke([
      new SystemMessage(SYSTEM),
      new HumanMessage(info),
    ]);

    const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
    const summary = text.trim();

    if (c.customer_id) {
      await supabase.from("property_customers").update({
        ai_summary: summary,
        ai_summary_at: new Date().toISOString(),
      }).eq("id", c.customer_id);
    }

    return NextResponse.json({ summary });
  } catch (e) {
    console.error("customer-summary error:", e);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
