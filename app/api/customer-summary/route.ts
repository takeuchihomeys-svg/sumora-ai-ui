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
・3〜5項目の箇条書き（「・」で始める）
・条件の羅列は禁止（エリア・家賃・間取り等はすでに画面表示済み）
・書くべき内容：お客さんの性格・タイプ・感情状態・次のLINEで確認すべきこと・営業上のヒント
・入力にない情報は書かない
・各項目は1行以内で簡潔に（「〜さんは〜」形式）`;

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
};

export async function POST(req: NextRequest) {
  try {
    const c = await req.json() as SummaryRequest;

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
    ].filter(Boolean).join("\n");

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
