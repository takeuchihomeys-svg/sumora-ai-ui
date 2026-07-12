import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 120; // 画像複数枚を並列パースするため長め

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const VISION_MODEL = "claude-sonnet-4-6"; // 画像読み取りはSonnetで精度優先

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
    signal: AbortSignal.timeout(60_000),
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType as "image/jpeg" | "image/png" | "image/webp", data: base64 } },
          { type: "text", text: `この賃貸物件の資料画像から情報を読み取って、以下のJSON形式で返してください。

【読み取る項目】
1. property_name: 物件名（マンション名・アパート名）
2. area: 住所の区・市（例: 西淀川区、阿倍野区、北区）
3. station: 最寄り駅名のみ（「駅」「線」は除く。例: 姫島、天王寺、梅田）
4. nearby_areas: 路線名・周辺の区や駅など関連キーワードを3〜5個の配列
5. walk_minutes: 徒歩分数（数値のみ。「徒歩7分」→7）
6. rent: 月額家賃を万円単位の数値（管理費込みの合計。例: 6.5）
7. floor_plan: 間取り（例: 1LDK、2DK）
8. size: 専有面積を㎡の数値（例: 28.5）
9. building_age: 築年数を数値（「2020年築」→2026-2020=6、「築5年」→5）
10. pet_allowed: ペット可→true、ペット不可→false、記載なし→null

【注意】
- JSONのみ返す（説明文・前置き不要）
- 読み取れない項目はnullにする
- 数値フィールドは文字列ではなく数値型で返す

{
  "property_name": "",
  "area": "",
  "station": "",
  "nearby_areas": [],
  "walk_minutes": null,
  "rent": null,
  "floor_plan": "",
  "size": null,
  "building_age": null,
  "pet_allowed": null
}` },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error("[recommend-property/parsePropertyFromImage] Claude API error:", res.status, errBody);
    return null;
  }
  const data = await res.json() as { content: Array<{ type: string; text: string }> };
  const text = data.content[0]?.text ?? "";
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) { console.error("[recommend-property/parsePropertyFromImage] no JSON found in:", text); return null; }
    const parsed = JSON.parse(match[0]) as ParsedProperty;
    return parsed;
  } catch (e) {
    console.error("[recommend-property/parsePropertyFromImage] JSON parse error:", e, "raw:", text);
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
  if (prop.building_age != null) {
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

interface RankedItem {
  index: number;
  label: string;
  property_name: string;
  score: number;
  hardNG: string | null;
  breakdown: Array<{ label: string; point: number; note: string }>;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      customerId?: string;
      images?: Array<{ base64: string; mediaType: string; label?: string }>;
    };

    if (!body.customerId) {
      return NextResponse.json({ ok: false, error: "customerId が必要です" }, { status: 400 });
    }
    if (!body.images || !Array.isArray(body.images) || body.images.length === 0) {
      return NextResponse.json({ ok: false, error: "images が必要です" }, { status: 400 });
    }

    // ① 顧客情報を取得
    const { data: customer, error } = await supabase
      .from("property_customers")
      .select("id, customer_name, desired_area, area, rent_max, max_rent, floor_plan, layout, building_age, walk_minutes, floor_area_min, floor_area_max, pet, preferences")
      .eq("id", body.customerId)
      .single();
    if (error || !customer) {
      return NextResponse.json({ ok: false, error: error?.message || "顧客が見つかりません" }, { status: 404 });
    }

    // ② 全画像を並列でパース（速度優先）
    const parsedList = await Promise.all(
      body.images.map(img => parsePropertyFromImage(img.base64, img.mediaType))
    );

    // ③ スコアリング（パース失敗した画像はスキップ）
    const ranked: RankedItem[] = [];
    parsedList.forEach((prop, i) => {
      if (!prop) {
        console.log(`[recommend-property] 画像${i + 1}（${body.images![i].label || `物件${i + 1}`}）はパースできなかったためスキップ`);
        return;
      }
      const r = calcScore(customer as Record<string, unknown>, prop);
      ranked.push({
        index: i,
        label: body.images![i].label || `物件${i + 1}`,
        property_name: prop.property_name || `物件${i + 1}`,
        score: r.score,
        hardNG: r.hardNG,
        breakdown: r.breakdown,
      });
    });

    if (ranked.length === 0) {
      return NextResponse.json({
        ok: true,
        best: null,
        ranked: [],
        customer_name: (customer.customer_name as string) || "",
      });
    }

    // ④ ソート: hardNGなしをスコア降順で先頭に、hardNGありは末尾に
    ranked.sort((a, b) => {
      if (!!a.hardNG !== !!b.hardNG) return a.hardNG ? 1 : -1;
      return b.score - a.score;
    });

    const top = ranked[0];
    let best: (RankedItem & { summary: string }) | null = null;
    if (!top.hardNG) {
      const okItems = top.breakdown.filter(b => b.point === 1).map(b => `${b.label}✅`);
      const summary = `${top.property_name}が一番おすすめです。${okItems.join(" ")}`.trim();
      best = { ...top, summary };
    }

    return NextResponse.json({
      ok: true,
      best,
      ranked,
      customer_name: (customer.customer_name as string) || "",
    });
  } catch (e) {
    console.error("[recommend-property]", e);
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
