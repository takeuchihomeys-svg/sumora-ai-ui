import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";

interface ParsedProperty {
  property_name: string;
  area: string;         // 区・市名（例: 西淀川区）
  station: string;      // 最寄り駅（例: 姫島駅）
  nearby_areas: string[]; // 周辺エリア・駅（複数）
  walk_minutes: number | null;
  rent: number | null;  // 万円
  floor_plan: string;   // 間取り
  size: number | null;  // ㎡
  building_age: number | null;
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
      max_tokens: 600,
      system: `あなたは賃貸物件資料を読み取るAIです。画像から物件情報を正確に抽出してJSON形式で返してください。

【重要な読み取りルール】
- 家賃: 管理費込みの月額。万円単位の数値のみ（例: 6.5）
- 広さ: ㎡の数値のみ（例: 28.5）。「28.50m²」→ 28.5
- 築年数: 「2020年築」→ 2024-2020=4（現在年から引いた年数）。「築5年」→ 5
- 最寄り駅: 「〇〇線 △△駅」の場合は駅名のみ（例:「姫島」「天王寺」）。「駅」は含めない
- エリア: 区・市名（例:「西淀川区」「阿倍野区」）
- nearby_areas: 最寄り駅の区・周辺エリア・路線名など関連キーワードを配列で（2〜5個）
- 徒歩分数: 「歩3分」「徒歩3分」→ 3

出力フォーマット（JSONのみ・説明文不要）:
{
  "property_name": "物件名",
  "area": "区・市名",
  "station": "最寄り駅名（駅なし）",
  "nearby_areas": ["関連エリア1", "関連エリア2"],
  "walk_minutes": 徒歩分数か null,
  "rent": 家賃万円か null,
  "floor_plan": "間取り",
  "size": 広さ㎡か null,
  "building_age": 築年数か null
}`,
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

// エリアキーワードのトークン化（「区」「市」「駅」除去）
function toAreaTokens(s: string): string[] {
  return s
    .split(/[、,\s・　／/\n]/)
    .map(t => t.replace(/[区市駅町村]/g, "").trim())
    .filter(t => t.length >= 2);
}

// お客様の希望条件と物件がマッチするか判定
function matchScore(customer: Record<string, unknown>, prop: ParsedProperty): { matched: boolean; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  let hardNG = false;

  // ── エリア・駅マッチ ──
  const customerAreaRaw = ((customer.desired_area || customer.area || "") as string);
  const customerTokens = toAreaTokens(customerAreaRaw);

  // 物件側の全エリアキーワード（駅・区・周辺エリア）
  const propAreaSources = [prop.area, prop.station, ...(prop.nearby_areas ?? [])].filter(Boolean);
  const propTokens = propAreaSources.flatMap(toAreaTokens);

  const areaMatch = customerTokens.some(ct =>
    propTokens.some(pt => pt.includes(ct) || ct.includes(pt))
  );
  if (areaMatch) {
    score += 3;
    const matchedStation = prop.station || prop.area;
    reasons.push(`エリア一致（${matchedStation}${prop.walk_minutes ? ` 徒歩${prop.walk_minutes}分` : ""}）`);
  }

  // ── 家賃マッチ（超過は即NG） ──
  const rentMax = (customer.rent_max || customer.max_rent) as number | null;
  if (prop.rent && rentMax) {
    const limitWan = rentMax / 10000;
    if (prop.rent > limitWan) {
      hardNG = true;
      reasons.push(`家賃超過（${prop.rent}万 > 上限${limitWan.toFixed(1)}万）`);
    } else {
      score += 2;
      reasons.push(`家賃OK（${prop.rent}万 ≤ 上限${limitWan.toFixed(1)}万）`);
    }
  }

  // ── ㎡マッチ ──
  const sizeMin = customer.floor_area_min as number | null;
  const sizeMax = customer.floor_area_max as number | null;
  if (prop.size) {
    if (sizeMin && prop.size < sizeMin) {
      hardNG = true;
      reasons.push(`広さ不足（${prop.size}㎡ < 最小${sizeMin}㎡）`);
    } else if (sizeMax && prop.size > sizeMax) {
      // 広すぎはNGにしない（お客様にとって広い分には問題ない場合が多い）
      score += 1;
      reasons.push(`広さOK（${prop.size}㎡）`);
    } else if (sizeMin || sizeMax) {
      score += 2;
      reasons.push(`広さOK（${prop.size}㎡）`);
    } else {
      // 希望㎡なしなら参考表示のみ
      reasons.push(`広さ: ${prop.size}㎡`);
    }
  }

  // ── 間取りマッチ ──
  const customerFloor = (customer.floor_plan || customer.layout || "") as string;
  if (prop.floor_plan && customerFloor) {
    const normalize = (s: string) => s.replace(/\s/g, "").toUpperCase();
    if (normalize(customerFloor).includes(normalize(prop.floor_plan)) ||
        normalize(prop.floor_plan).includes(normalize(customerFloor))) {
      score += 2;
      reasons.push(`間取り一致（${prop.floor_plan}）`);
    }
  }

  // ── 築年数マッチ（超過は即NG） ──
  const ageLim = customer.building_age as number | null;
  if (prop.building_age && ageLim) {
    if (prop.building_age > ageLim) {
      hardNG = true;
      reasons.push(`築年数超過（築${prop.building_age}年 > 上限築${ageLim}年）`);
    } else {
      score += 1;
      reasons.push(`築年数OK（築${prop.building_age}年）`);
    }
  }

  // ── 徒歩分数マッチ（超過は即NG） ──
  const walkLim = customer.walk_minutes as number | null;
  if (prop.walk_minutes && walkLim) {
    if (prop.walk_minutes > walkLim) {
      hardNG = true;
      reasons.push(`徒歩超過（${prop.walk_minutes}分 > 上限${walkLim}分）`);
    } else {
      reasons.push(`徒歩OK（${prop.walk_minutes}分）`);
    }
  }

  if (hardNG) return { matched: false, reasons };
  return { matched: score >= 2, reasons };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { base64?: string; mediaType?: string; property?: ParsedProperty };

    let prop: ParsedProperty | null = body.property ?? null;

    if (!prop && body.base64 && body.mediaType) {
      prop = await parsePropertyFromImage(body.base64, body.mediaType);
    }

    if (!prop) {
      return NextResponse.json({ ok: false, error: "物件情報を読み取れませんでした" }, { status: 400 });
    }

    const { data: customers } = await supabase
      .from("property_customers")
      .select("id, customer_name, desired_area, area, rent_max, max_rent, floor_plan, layout, building_age, walk_minutes, floor_area_min, floor_area_max, status")
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
