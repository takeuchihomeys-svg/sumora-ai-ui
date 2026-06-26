import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";

interface ParsedProperty {
  area: string;        // エリア・最寄り駅（例: 西淀川区、姫島駅）
  station: string;     // 最寄り駅
  walk_minutes: number | null;
  rent: number | null; // 万円
  floor_plan: string;  // 間取り（例: 1LDK）
  size: number | null; // ㎡
  building_age: number | null; // 築年数
  property_name: string;
}

// 画像からプロパティ情報を抽出
async function parsePropertyFromImage(base64: string, mediaType: string): Promise<ParsedProperty | null> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 512,
      system: `あなたは賃貸物件資料を読み取るAIです。画像から物件情報を抽出してJSON形式で返してください。
読み取れない項目はnullにしてください。家賃は万円単位の数値のみ、築年数は数値のみ、広さはm2の数値のみで返してください。

出力フォーマット（JSON）:
{
  "property_name": "物件名",
  "area": "エリア・区名（例: 西淀川区、阿倍野区）",
  "station": "最寄り駅名（例: 姫島駅、天王寺駅）",
  "walk_minutes": 徒歩分数（数値 or null）,
  "rent": 家賃（万円・数値 or null）,
  "floor_plan": "間取り（例: 1LDK, 2DK）",
  "size": 広さ㎡（数値 or null）,
  "building_age": 築年数（数値 or null）
}

JSONのみ出力し、説明文は不要です。`,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType as "image/jpeg" | "image/png" | "image/webp", data: base64 } },
          { type: "text", text: "この物件資料から情報を抽出してJSONで返してください。" },
        ],
      }],
    }),
  });

  if (!res.ok) return null;
  const data = await res.json() as { content: Array<{ type: string; text: string }> };
  const text = data.content[0]?.text ?? "";
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]) as ParsedProperty;
  } catch {
    return null;
  }
}

// お客様の希望条件と物件がマッチするか判定
function matchScore(customer: Record<string, unknown>, prop: ParsedProperty): { matched: boolean; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  // エリア・駅マッチ（キーワード部分一致）
  const customerArea = ((customer.desired_area || customer.area || "") as string).toLowerCase();
  const propAreaTokens = [prop.area, prop.station].filter(Boolean).map(s => s.toLowerCase());
  const areaMatch = propAreaTokens.some(token =>
    token.split(/[、,\s・区市]/).some(t => t.length >= 2 && customerArea.includes(t)) ||
    customerArea.split(/[、,\s・区市]/).some(t => t.length >= 2 && token.includes(t))
  );
  if (areaMatch) { score += 3; reasons.push(`エリア一致（${prop.station || prop.area}）`); }

  // 家賃マッチ
  const rentMax = (customer.rent_max || customer.max_rent) as number | null;
  if (prop.rent && rentMax) {
    if (prop.rent <= rentMax / 10000) { score += 2; reasons.push(`家賃OK（${prop.rent}万≤上限${(rentMax/10000).toFixed(1)}万）`); }
    else { return { matched: false, reasons: [`家賃超過（${prop.rent}万 > 上限${(rentMax/10000).toFixed(1)}万）`] }; }
  }

  // 間取りマッチ
  const customerFloor = (customer.floor_plan || customer.layout || "") as string;
  if (prop.floor_plan && customerFloor) {
    const normalize = (s: string) => s.replace(/\s/g, "").toUpperCase();
    if (normalize(customerFloor).includes(normalize(prop.floor_plan)) ||
        normalize(prop.floor_plan).includes(normalize(customerFloor))) {
      score += 2; reasons.push(`間取り一致（${prop.floor_plan}）`);
    }
  }

  // 築年数マッチ
  const ageLim = customer.building_age as number | null;
  if (prop.building_age && ageLim) {
    if (prop.building_age > ageLim) {
      return { matched: false, reasons: [`築年数超過（築${prop.building_age}年 > 上限築${ageLim}年）`] };
    }
    score += 1; reasons.push(`築年数OK（築${prop.building_age}年）`);
  }

  // 徒歩分数マッチ
  const walkLim = customer.walk_minutes as number | null;
  if (prop.walk_minutes && walkLim) {
    if (prop.walk_minutes > walkLim) {
      return { matched: false, reasons: [`徒歩超過（${prop.walk_minutes}分 > 上限${walkLim}分）`] };
    }
  }

  return { matched: score >= 2, reasons };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { base64?: string; mediaType?: string; property?: ParsedProperty };

    let prop: ParsedProperty | null = body.property ?? null;

    // 画像から物件情報を抽出
    if (!prop && body.base64 && body.mediaType) {
      prop = await parsePropertyFromImage(body.base64, body.mediaType);
    }

    if (!prop) {
      return NextResponse.json({ ok: false, error: "物件情報を読み取れませんでした" }, { status: 400 });
    }

    // hotおよびproperty_searchのお客様を全取得
    const { data: customers } = await supabase
      .from("property_customers")
      .select("id, customer_name, desired_area, area, rent_max, max_rent, floor_plan, layout, building_age, walk_minutes, status")
      .in("status", ["hot", "property_search", "new_inquiry"]);

    const matched: Array<{ id: string; customer_name: string; reasons: string[] }> = [];
    for (const c of (customers ?? [])) {
      const result = matchScore(c as Record<string, unknown>, prop);
      if (result.matched) {
        matched.push({ id: c.id as string, customer_name: c.customer_name as string, reasons: result.reasons });
      }
    }

    return NextResponse.json({ ok: true, property: prop, matched, total: (customers ?? []).length });
  } catch (e) {
    console.error("[match-property-customers]", e);
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
