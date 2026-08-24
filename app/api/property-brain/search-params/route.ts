// @ts-nocheck
// GET /api/property-brain/search-params?customerId=xxx
//
// Chrome拡張が物件検索を実行するときに呼ぶ統合エンドポイント。
// ① RAGコンテキスト（顧客条件 + 送付履歴 + エリア知識）を組み立て
// ② resolve-area で station_names / city_codes / route_ids を解決
// ③ 送付履歴から excludePropertyKeys（重複送付防止リスト）を生成
// → Chrome拡張はこの1本を呼ぶだけで全検索パラメータが揃う

import { NextRequest, NextResponse } from "next/server";
import { buildPropertyBrainContext } from "@/app/lib/property-brain-rag";

export const maxDuration = 20;

export async function GET(req: NextRequest) {
  const customerId = req.nextUrl.searchParams.get("customerId");
  if (!customerId) {
    return NextResponse.json({ error: "customerId required" }, { status: 400 });
  }

  // ── Step 1: RAGコンテキスト組み立て ──────────────────────────────────────
  const ctx = await buildPropertyBrainContext(customerId);
  if (!ctx) {
    return NextResponse.json({ error: "customer not found" }, { status: 404 });
  }

  const { customer: c, sentHistory, areaKnowledge } = ctx;

  // ── Step 2: resolve-area でフル解決（station_names / city_codes / route_ids）──
  let resolvedArea = null;
  if (c.desiredArea) {
    const baseUrl =
      process.env.NEXT_PUBLIC_SITE_URL ??
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

    try {
      const res = await fetch(`${baseUrl}/api/resolve-area`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ desired_area: c.desiredArea, area_mode: c.areaMode ?? "auto" }),
        signal: AbortSignal.timeout(12_000),
      });
      if (res.ok) resolvedArea = await res.json();
    } catch (e) {
      console.warn("[property-brain/search-params] resolve-area timeout or error:", e.message);
    }
  }

  // ── Step 3: 送付履歴 → 除外リスト生成 ─────────────────────────────────────
  // 「募集中かつ顧客が興味あり」は再送可（除外しない）
  const excludePropertyKeys: string[] = sentHistory
    .filter(s => !(s.recruitmentStatus === "open" && s.customerReaction === "interested"))
    .map(s => `${s.propertyName}_${s.roomNo}`);

  // 過去の反応サマリー（UIヒント用）
  const sentSummary = {
    total: sentHistory.length,
    interested: sentHistory.filter(s => s.customerReaction === "interested").length,
    rejected: sentHistory.filter(s => s.customerReaction === "rejected").length,
    noResponse: sentHistory.filter(s => s.customerReaction === "no_response" || !s.customerReaction).length,
  };

  // ── Step 4: 検索推奨度（Chrome拡張の hold 警告用）───────────────────────────
  const daysSinceLastSent = c.lastPropertySentAt
    ? Math.floor((Date.now() - new Date(c.lastPropertySentAt).getTime()) / 86_400_000)
    : null;

  const recommendation: "search_now" | "hold" | "normal" =
    c.propertySendCount >= 2 && (daysSinceLastSent ?? 999) < 3
      ? "hold"
      : (daysSinceLastSent === null || daysSinceLastSent >= 7)
      ? "search_now"
      : "normal";

  // ── Step 5: レスポンス組み立て ───────────────────────────────────────────────
  return NextResponse.json({
    // エリアモード
    area_mode: c.areaMode ?? "auto",

    // リアプロ（resolve-area と同一 snake_case キー → popup.js の apiData.realpro.* がそのまま動く）
    realpro: {
      station_names: resolvedArea?.realpro?.station_names ?? areaKnowledge.resolvedStations,
      city_codes:    resolvedArea?.realpro?.city_codes    ?? [],
      route_ids:     resolvedArea?.realpro?.route_ids     ?? [],
    },

    // itandi（同上）
    itandi: {
      line_names:    resolvedArea?.itandi?.line_names    ?? [],
      station_names: resolvedArea?.itandi?.station_names ?? [],
      ward_names:    resolvedArea?.itandi?.ward_names    ?? [],
    },

    // レインズ（同上）
    reins: {
      station_pairs: resolvedArea?.reins?.station_pairs ?? [],
      ward_names:    resolvedArea?.reins?.ward_names    ?? [],
    },

    // 顧客条件フォールバック（調整フォームが空のとき popup.js が使う）
    conditions: {
      rent_min:        c.rentMin,
      rent_max:        c.rentMax,
      floor_plan:      c.floorPlan,
      floor_area_min:  c.floorAreaMin,
      walk_minutes:    c.walkMinutes,
      building_age:    c.buildingAge,
      pet:             c.pet,
      commute_station: c.commuteStation,
      commute_minutes: c.commuteMinutes,
      preferences:     c.preferences,
      ng_points:       c.ngPoints,
    },

    // 送付履歴 & 重複送付防止（これが brain 統合の主な付加価値）
    exclude_property_keys: excludePropertyKeys,
    sent_summary: sentSummary,

    // 検索推奨ステータス
    recommendation,          // "search_now" | "hold" | "normal"
    property_send_count:  c.propertySendCount,
    days_since_last_sent: daysSinceLastSent,

    // 周辺駅ヒント（広げて検索ボタン用）
    nearby_stations: areaKnowledge.nearbyStations,

    // resolve-area の学習データ（resolve-area と同じキー → popup.js の学習キャッシュ更新がそのまま動く）
    new_stations:    resolvedArea?.new_stations    ?? [],
    new_regions:     resolvedArea?.new_regions     ?? [],
    normalized_area: resolvedArea?.normalized_area ?? null,
    suggested_walk_minutes: resolvedArea?.suggested_walk_minutes ?? null,
  });
}
