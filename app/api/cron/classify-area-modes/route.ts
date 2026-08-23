// @ts-nocheck
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 60;

// desired_area を簡易トークン分解（サーバーサイド版・parseAreaTokens の軽量版）
function tokenizeArea(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[,、・\/\s　]+/)
    .map(t =>
      t
        .replace(/駅$|周辺$|付近$|近く$|近辺$|沿線$|エリア$|あたり$|まで.{0,5}分.*/g, "")
        .trim()
    )
    .filter(t => t.length >= 2 && !/^[0-9０-９]/.test(t));
}

// line_stations テーブルで駅名を一括照合
async function classifyTokens(tokens: string[]): Promise<{
  stationTokens: Set<string>;
  regionTokens: Set<string>;
}> {
  const stationTokens = new Set<string>();
  const regionTokens  = new Set<string>();
  if (tokens.length === 0) return { stationTokens, regionTokens };

  // ── 駅名チェック（line_stations: 登録済み大阪府路線駅）──────────────────────
  // 「JR」「阪急」などの会社名プレフィックスを除去したバリアントも同時検索
  const pfxRe = /^(?:阪急|阪神|南海|近鉄|JR|京阪|大阪メトロ|地下鉄)/;
  const lookupSet = new Set<string>();
  for (const t of tokens) {
    lookupSet.add(t);
    lookupSet.add(t.replace(/[町村]$/, ""));
    lookupSet.add(t.replace(pfxRe, ""));
    lookupSet.add(t.replace(pfxRe, "").replace(/[町村]$/, ""));
  }
  const lookupArr = [...lookupSet].filter(Boolean);
  const { data: stRows } = await supabase
    .from("line_stations")
    .select("station_name")
    .in("station_name", lookupArr);
  const knownStations = new Set((stRows || []).map(r => r.station_name));

  for (const t of tokens) {
    const vs = [t, t.replace(/[町村]$/, ""), t.replace(pfxRe, ""), t.replace(pfxRe, "").replace(/[町村]$/, "")];
    if (vs.some(v => knownStations.has(v))) {
      stationTokens.add(t);
      continue;
    }
    // 「〜線」で終わるトークンは路線名扱い（地域でも駅でもない）
    if (t.endsWith("線")) continue;
  }

  // ── 地域チェック（region_map + ward_codes）────────────────────────────────
  const nonStation = tokens.filter(t => !stationTokens.has(t) && !t.endsWith("線"));
  if (nonStation.length > 0) {
    const [{ data: regionRows }, { data: wardRows }] = await Promise.all([
      supabase.from("region_map").select("token").in("token", nonStation),
      supabase.from("ward_codes").select("area_name").in("area_name", nonStation),
    ]);
    const knownRegions = new Set([
      ...(regionRows || []).map(r => r.token),
      ...(wardRows  || []).map(r => r.area_name),
    ]);
    for (const t of nonStation) {
      if (knownRegions.has(t) || knownRegions.has(t + "市")) regionTokens.add(t);
    }
  }

  return { stationTokens, regionTokens };
}

export async function GET(req: NextRequest) {
  // Vercel Cron 認証
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // area_mode = 'auto' かつ desired_area がある顧客を全件取得
  const { data: customers, error } = await supabase
    .from("property_customers")
    .select("id, desired_area, area")
    .eq("area_mode", "auto")
    .or("desired_area.is.not.null,area.is.not.null")
    .neq("status", "lost"); // 失注済みは除外

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!customers || customers.length === 0) {
    return NextResponse.json({ updated: 0, message: "対象顧客なし" });
  }

  let updated = 0;
  const updates: { id: string; area_mode: string }[] = [];

  for (const c of customers) {
    const rawArea = (c.desired_area || c.area || "").trim();
    if (!rawArea) continue;

    const tokens = tokenizeArea(rawArea);
    if (tokens.length === 0) continue;

    const { stationTokens, regionTokens } = await classifyTokens(tokens);
    const meaningfulCount = tokens.filter(t => !t.endsWith("線")).length;
    if (meaningfulCount === 0) continue;

    // 判定: 意味あるトークン全てが駅 → station / 全て地域 → ward / 混在/不明 → auto
    const stCount = tokens.filter(t => stationTokens.has(t)).length;
    const rgCount = tokens.filter(t => regionTokens.has(t)).length;
    const lineCount = tokens.filter(t => t.endsWith("線")).length;

    let newMode: string | null = null;
    if (stCount > 0 && rgCount === 0 && stCount + lineCount === tokens.length) {
      newMode = "station"; // 駅名（+路線名）のみ
    } else if (rgCount > 0 && stCount === 0) {
      newMode = "ward";   // 地域のみ
    }
    // 混在・不明は auto のまま（強制変更しない）

    if (newMode) updates.push({ id: c.id, area_mode: newMode });
  }

  // バッチ更新（50件ずつ）
  for (let i = 0; i < updates.length; i += 50) {
    const chunk = updates.slice(i, i + 50);
    for (const u of chunk) {
      await supabase.from("property_customers")
        .update({ area_mode: u.area_mode })
        .eq("id", u.id);
    }
    updated += chunk.length;
  }

  console.log(`[classify-area-modes] ${customers.length}件チェック → ${updated}件更新`);
  return NextResponse.json({
    checked: customers.length,
    updated,
    details: updates.slice(0, 20), // 先頭20件だけログ
  });
}
