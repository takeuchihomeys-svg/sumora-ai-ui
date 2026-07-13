import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { parsePropertyFromImage, calcScore } from "@/app/lib/property-scoring";

export const maxDuration = 120; // 画像複数枚を並列パースするため長め

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
    const MAX_IMAGES = 15;
    if (body.images.length > MAX_IMAGES) {
      return NextResponse.json({ ok: false, error: "画像は最大15枚まで" }, { status: 400 });
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
