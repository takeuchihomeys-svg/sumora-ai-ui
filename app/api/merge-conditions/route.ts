import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

interface CustomerInput {
  move_in_time?: string | null;
  rent_min?: number | null;
  rent_max?: number | null;
  max_rent?: number | null;
  desired_area?: string | null;
  area?: string | null;
  walk_minutes?: number | null;
  floor_plan?: string | null;
  layout?: string | null;
  initial_cost_limit?: number | null;
  building_age?: number | null;
  other_requests?: string | null;
  preferences?: string | null;
  ng_points?: string | null;
  additional_conditions?: string | null;
}

interface MergedConditions {
  move_in_time: string | null;
  rent_min: number | null;
  rent_max: number | null;
  desired_area: string | null;
  walk_minutes: number | null;
  floor_plan: string | null;
  initial_cost_limit: number | null;
  building_age: number | null;
  other_requests: string | null;
  // 欠落していた3フィールドを追加（フロントのマージUIで正しく反映されるようにする）
  ng_points: string | null;
  preferences: string | null;
  floor_area_min: number | null;
}

export async function POST(req: NextRequest) {
  let customer: CustomerInput;
  try {
    const body = await req.json();
    customer = body.customer as CustomerInput;
    if (!customer) throw new Error("missing customer");
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // Build base conditions from original fields
  const base: MergedConditions = {
    move_in_time: customer.move_in_time ?? null,
    rent_min: customer.rent_min ?? null,
    rent_max: customer.rent_max ?? customer.max_rent ?? null,
    desired_area: customer.desired_area ?? customer.area ?? null,
    walk_minutes: customer.walk_minutes ?? null,
    floor_plan: customer.floor_plan ?? customer.layout ?? null,
    initial_cost_limit: customer.initial_cost_limit ?? null,
    building_age: customer.building_age ?? null,
    other_requests: customer.other_requests ?? null,
    ng_points: customer.ng_points ?? null,
    preferences: customer.preferences ?? null,
    floor_area_min: null, // property_customers に floor_area_min カラムが存在するが CustomerInput には未定義
  };

  // No additional conditions → return base as-is
  if (!customer.additional_conditions?.trim()) {
    return NextResponse.json({ merged: base });
  }

  // Merge with additional conditions via AI
  const baseText = [
    base.move_in_time && `入居時期: ${base.move_in_time}`,
    base.rent_min && base.rent_max
      ? `家賃: ${base.rent_min / 10000}万〜${base.rent_max / 10000}万円`
      : base.rent_max
      ? `家賃: 〜${base.rent_max / 10000}万円`
      : null,
    base.desired_area && `エリア: ${base.desired_area}`,
    base.walk_minutes && `徒歩: ${base.walk_minutes}分以内`,
    base.floor_plan && `間取り: ${base.floor_plan}`,
    base.initial_cost_limit && `初期費用上限: ${base.initial_cost_limit / 10000}万円`,
    base.building_age && `築年数: ${base.building_age}年以内`,
    base.ng_points && `NG条件: ${base.ng_points}`,
    base.preferences && `こだわり: ${base.preferences}`,
    base.other_requests && `その他: ${base.other_requests}`,
    base.floor_area_min && `広さ: ${base.floor_area_min}㎡以上`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `以下の元の条件と追加条件を統合して、最新の検索条件をJSONで返してください。
追加条件は元の条件を上書き・補完します。数値は円単位。不明はnull。
返すJSONのみ（説明不要）:
{"move_in_time":null,"rent_min":null,"rent_max":null,"desired_area":null,"walk_minutes":null,"floor_plan":null,"initial_cost_limit":null,"building_age":null,"other_requests":null,"ng_points":null,"preferences":null,"floor_area_min":null}

元の条件:
${baseText || "（なし）"}

追加条件:
${customer.additional_conditions}`,
        },
      ],
    });
    const raw = msg.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text ?? "";
    const match = raw
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim()
      .match(/\{[\s\S]*\}/);
    if (match) {
      const merged = JSON.parse(match[0]) as MergedConditions;
      return NextResponse.json({ merged });
    }
  } catch {
    // fallback to base
  }

  return NextResponse.json({ merged: base });
}
