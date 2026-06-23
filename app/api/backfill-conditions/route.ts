import { NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY ?? "").replace(/\s/g, "");
const HAIKU = "claude-haiku-4-5-20251001";

// webhook と同じ条件メッセージ判定ロジック
function isConditionMessage(text: string): boolean {
  if (!text || text.length < 5) return false;
  if ((text.match(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮]/g) ?? []).length >= 2) return true;

  const conditionKeywords = [
    "入居時期", "希望家賃", "家賃", "希望地域", "希望エリア", "間取り", "徒歩",
    "初期費用", "築年数", "エリア", "LDK", "DK", "1K", "2K", "3K", "1R",
    "万以内", "万円以内", "万円まで", "万に", "万円に", "以下", "以内", "㎡", "平米",
    "ペット可", "ペット不可", "駐車場", "独立洗面", "バストイレ別",
    "オートロック", "駅近", "築浅", "築", "NG", "希望条件", "こだわり",
  ];
  const changeKeywords = [
    "変えたい", "変更", "に変えて", "に変更", "にしたい", "やっぱり", "修正", "更新",
    "広げ", "せばめ", "上げ", "下げ",
  ];

  const condMatches = conditionKeywords.filter((k) => text.includes(k)).length;
  const hasChange = changeKeywords.some((k) => text.includes(k));
  if (hasChange && condMatches >= 1) return true;
  if (condMatches >= 2) return true;
  return false;
}

async function parseConditionText(text: string): Promise<Record<string, unknown> | null> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: HAIKU,
      max_tokens: 512,
      messages: [{
        role: "user",
        content: `日本の賃貸物件の希望条件をJSONで返してください。
【家賃ルール】1万円=10000円。「11万」→ rent_max: 110000
不明な項目は null にする。JSONのみ返す。

{
  "move_in_time": null, "rent_min": null, "rent_max": null,
  "desired_area": null, "walk_minutes": null, "floor_plan": null,
  "initial_cost_limit": null, "building_age": null, "floor_area_min": null,
  "preferences": null, "ng_points": null, "other_requests": null
}

テキスト:
${text}`,
      }],
    }),
  });

  if (!res.ok) return null;
  const data = await res.json() as { content?: Array<{ text: string }> };
  const raw = (data.content?.[0]?.text ?? "").replace(/```json?\s*/gi, "").replace(/```/g, "").trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    // 家賃バリデーション
    for (const f of ["rent_min", "rent_max", "initial_cost_limit"]) {
      const v = parsed[f];
      if (typeof v === "number" && v > 0 && v <= 300) parsed[f] = v * 10000;
    }
    return parsed;
  } catch {
    return null;
  }
}

// GET: 対象件数の確認
export async function GET() {
  const { data: targets, count } = await supabase
    .from("property_customers")
    .select("id", { count: "exact" })
    .is("rent_max", null)
    .is("desired_area", null)
    .is("floor_plan", null)
    .is("move_in_time", null)
    .not("line_user_id", "is", null);

  return NextResponse.json({ ok: true, target_count: count ?? 0, sample_ids: (targets ?? []).slice(0, 5).map((r) => r.id) });
}

// POST: 条件未入力のお客様を遡りスキャンして条件を反映
export async function POST() {
  // 条件フィールドが全て空のお客様を取得（最大100件）
  const { data: targets } = await supabase
    .from("property_customers")
    .select("id, customer_name, line_user_id")
    .is("rent_max", null)
    .is("desired_area", null)
    .is("floor_plan", null)
    .is("move_in_time", null)
    .not("line_user_id", "is", null)
    .limit(100);

  if (!targets?.length) return NextResponse.json({ ok: true, processed: 0, updated: 0 });

  let updated = 0;
  const results: { name: string; found: boolean; fields?: string[] }[] = [];

  for (const customer of targets) {
    const lineUserId = customer.line_user_id as string;

    // この顧客のLINE会話からメッセージを取得
    const { data: conv } = await supabase
      .from("conversations")
      .select("id")
      .eq("line_user_id", lineUserId)
      .limit(1)
      .maybeSingle();

    if (!conv?.id) {
      results.push({ name: customer.customer_name as string, found: false });
      continue;
    }

    // お客様が送ったメッセージを時系列順に取得
    const { data: messages } = await supabase
      .from("messages")
      .select("text, created_at")
      .eq("conversation_id", conv.id as string)
      .eq("sender", "customer")
      .order("created_at", { ascending: true })
      .limit(50);

    // 条件らしいメッセージを抽出
    const condMsgs = (messages ?? []).filter((m) => isConditionMessage(m.text as string ?? ""));
    if (!condMsgs.length) {
      results.push({ name: customer.customer_name as string, found: false });
      continue;
    }

    // 全条件メッセージを結合してAIで解析
    const combinedText = condMsgs.map((m) => m.text as string).join("\n");
    const parsed = await parseConditionText(combinedText);
    if (!parsed) {
      results.push({ name: customer.customer_name as string, found: false });
      continue;
    }

    // 有効なフィールドだけ抽出
    const fieldsToUpdate: Record<string, unknown> = { updated_at: new Date().toISOString() };
    const updatedFields: string[] = [];
    for (const f of ["move_in_time", "rent_min", "rent_max", "desired_area", "walk_minutes", "floor_plan", "initial_cost_limit", "building_age", "floor_area_min", "preferences", "ng_points", "other_requests"]) {
      if (parsed[f] !== null && parsed[f] !== undefined) {
        fieldsToUpdate[f] = parsed[f];
        updatedFields.push(f);
      }
    }

    if (!updatedFields.length) {
      results.push({ name: customer.customer_name as string, found: false });
      continue;
    }

    await supabase.from("property_customers").update(fieldsToUpdate).eq("id", customer.id as string);
    updated++;
    results.push({ name: customer.customer_name as string, found: true, fields: updatedFields });

    // レート制限対策（Haiku でも連続呼び出しを少し待つ）
    await new Promise((r) => setTimeout(r, 200));
  }

  return NextResponse.json({
    ok: true,
    processed: targets.length,
    updated,
    results,
  });
}
