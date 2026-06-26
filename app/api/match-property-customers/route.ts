import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";

interface ParsedProperty {
  property_name: string;
  area: string;
  station: string;
  nearby_areas: string[];
  walk_minutes: number | null;
  rent: number | null;       // 万円
  floor_plan: string;
  size: number | null;       // ㎡
  building_age: number | null;
  pet_allowed: boolean | null; // ペット可かどうか
}

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
      max_tokens: 700,
      system: `あなたは賃貸物件資料を読み取るAIです。画像から物件情報を正確に抽出してJSONで返してください。

【読み取りルール】
- 家賃: 管理費込みの月額。万円単位の数値（例: 6.5）
- 広さ: ㎡の数値のみ（例: 28.5）。「28.50m²」→ 28.5
- 築年数: 「2020年築」→ 現在年(2026)から引く → 6。「築5年」→ 5
- 最寄り駅: 駅名のみ（「駅」「線」は含めない）
- area: 区・市名（例: 西淀川区、阿倍野区）
- nearby_areas: 最寄り駅の区・路線名・周辺エリアをなるべく多く（3〜6個）
- pet_allowed: ペット可なら true、ペット不可なら false、不明なら null
- 徒歩分数: 数値のみ

出力（JSONのみ・説明不要）:
{
  "property_name": "物件名",
  "area": "区・市名",
  "station": "最寄り駅名",
  "nearby_areas": ["関連エリア1", "関連エリア2"],
  "walk_minutes": 数値かnull,
  "rent": 万円数値かnull,
  "floor_plan": "間取り",
  "size": ㎡数値かnull,
  "building_age": 築年数数値かnull,
  "pet_allowed": trueかfalseかnull
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

function toAreaTokens(s: string): string[] {
  return s
    .split(/[、,\s・　／/\n]/)
    .map(t => t.replace(/[区市駅町村]/g, "").trim())
    .filter(t => t.length >= 2);
}

interface ScoreResult {
  score: number;      // 0〜5
  matched: boolean;
  hardNG: string | null;
  breakdown: Array<{ label: string; point: number; note: string }>;
}

function calcScore(customer: Record<string, unknown>, prop: ParsedProperty): ScoreResult {
  const breakdown: Array<{ label: string; point: number; note: string }> = [];
  let score = 0;
  let hardNG: string | null = null;

  // ── ペット（ハードNG） ──
  const wantsPet = customer.pet as boolean | null;
  if (wantsPet === true && prop.pet_allowed === false) {
    return { score: 0, matched: false, hardNG: "ペット不可物件", breakdown: [] };
  }

  // ── ① 地域・駅（1点） ──
  const customerAreaRaw = ((customer.desired_area || customer.area || "") as string);
  const customerTokens = toAreaTokens(customerAreaRaw);
  const propAreaSources = [prop.area, prop.station, ...(prop.nearby_areas ?? [])].filter(Boolean);
  const propTokens = propAreaSources.flatMap(toAreaTokens);

  if (customerTokens.length > 0 && propTokens.length > 0) {
    const areaMatch = customerTokens.some(ct => propTokens.some(pt => pt.includes(ct) || ct.includes(pt)));
    const point = areaMatch ? 1 : 0;
    score += point;
    const station = prop.station || prop.area;
    breakdown.push({
      label: "地域・駅",
      point,
      note: areaMatch
        ? `${station}${prop.walk_minutes ? ` 徒歩${prop.walk_minutes}分` : ""}`
        : `希望:${customerAreaRaw} / 物件:${station}`,
    });
    // 徒歩超過はNG
    const walkLim = customer.walk_minutes as number | null;
    if (areaMatch && prop.walk_minutes && walkLim && prop.walk_minutes > walkLim) {
      hardNG = `徒歩超過（${prop.walk_minutes}分 > 上限${walkLim}分）`;
    }
  } else {
    breakdown.push({ label: "地域・駅", point: 0, note: "データなし" });
  }

  // ── ② 家賃（1点） ──
  const rentMax = (customer.rent_max || customer.max_rent) as number | null;
  if (prop.rent && rentMax) {
    const limitWan = rentMax / 10000;
    if (prop.rent > limitWan) {
      hardNG = `家賃超過（${prop.rent}万 > 上限${limitWan.toFixed(1)}万）`;
      breakdown.push({ label: "家賃", point: 0, note: `${prop.rent}万 > 上限${limitWan.toFixed(1)}万` });
    } else {
      score += 1;
      breakdown.push({ label: "家賃", point: 1, note: `${prop.rent}万（上限${limitWan.toFixed(1)}万以内）` });
    }
  } else if (prop.rent) {
    breakdown.push({ label: "家賃", point: 0, note: `${prop.rent}万（上限設定なし）` });
  } else {
    breakdown.push({ label: "家賃", point: 0, note: "読み取り不可" });
  }

  // ── ③ 間取り（1点） ──
  const customerFloor = (customer.floor_plan || customer.layout || "") as string;
  if (prop.floor_plan && customerFloor) {
    const norm = (s: string) => s.replace(/\s/g, "").toUpperCase();
    const floorMatch =
      norm(customerFloor).includes(norm(prop.floor_plan)) ||
      norm(prop.floor_plan).includes(norm(customerFloor));
    const point = floorMatch ? 1 : 0;
    score += point;
    breakdown.push({
      label: "間取り",
      point,
      note: floorMatch ? prop.floor_plan : `希望:${customerFloor} / 物件:${prop.floor_plan}`,
    });
  } else {
    breakdown.push({ label: "間取り", point: 0, note: "データなし" });
  }

  // ── ④ 広さ（1点） ──
  const sizeMin = customer.floor_area_min as number | null;
  const sizeMax = customer.floor_area_max as number | null;
  if (prop.size) {
    if (sizeMin && prop.size < sizeMin) {
      hardNG = `広さ不足（${prop.size}㎡ < 最小${sizeMin}㎡）`;
      breakdown.push({ label: "広さ", point: 0, note: `${prop.size}㎡ < 最小${sizeMin}㎡` });
    } else if (sizeMin || sizeMax) {
      score += 1;
      const range = sizeMin && sizeMax ? `${sizeMin}〜${sizeMax}㎡` : sizeMin ? `${sizeMin}㎡以上` : `${sizeMax}㎡以下`;
      breakdown.push({ label: "広さ", point: 1, note: `${prop.size}㎡（希望${range}）` });
    } else {
      breakdown.push({ label: "広さ", point: 0, note: `${prop.size}㎡（希望設定なし）` });
    }
  } else {
    breakdown.push({ label: "広さ", point: 0, note: "読み取り不可" });
  }

  // ── ⑤ 築年数（1点） ──
  const ageLim = customer.building_age as number | null;
  if (prop.building_age) {
    if (ageLim && prop.building_age > ageLim) {
      hardNG = `築年数超過（築${prop.building_age}年 > 上限築${ageLim}年）`;
      breakdown.push({ label: "築年数", point: 0, note: `築${prop.building_age}年 > 上限${ageLim}年` });
    } else if (ageLim) {
      score += 1;
      breakdown.push({ label: "築年数", point: 1, note: `築${prop.building_age}年（上限${ageLim}年以内）` });
    } else {
      breakdown.push({ label: "築年数", point: 0, note: `築${prop.building_age}年（上限設定なし）` });
    }
  } else {
    breakdown.push({ label: "築年数", point: 0, note: "読み取り不可" });
  }

  if (hardNG) return { score: 0, matched: false, hardNG, breakdown };
  return { score, matched: score >= 1, hardNG: null, breakdown };
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
      .select("id, customer_name, desired_area, area, rent_max, max_rent, floor_plan, layout, building_age, walk_minutes, floor_area_min, floor_area_max, pet, status")
      .in("status", ["hot", "property_search", "new_inquiry"]);

    const results: Array<{
      id: string;
      customer_name: string;
      score: number;
      breakdown: Array<{ label: string; point: number; note: string }>;
    }> = [];

    for (const c of (customers ?? [])) {
      const r = calcScore(c as Record<string, unknown>, prop);
      if (r.matched) {
        results.push({ id: c.id as string, customer_name: c.customer_name as string, score: r.score, breakdown: r.breakdown });
      }
    }

    // スコア降順で並び替え
    results.sort((a, b) => b.score - a.score);

    return NextResponse.json({ ok: true, property: prop, matched: results, total: (customers ?? []).length });
  } catch (e) {
    console.error("[match-property-customers]", e);
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
