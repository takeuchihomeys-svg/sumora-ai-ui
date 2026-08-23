// @ts-nocheck
// ── エリアモード自動分類 cron ─────────────────────────────────────────
// 毎日 JST 12:00 に実行。area_mode = 'auto' の顧客を全件チェックし、
// desired_area のトークンが「駅のみ」なら station / 「地域のみ」なら ward に自動設定する。
//
// 知識源は resolve-area API（物件検索の脳）と同一のテーブルを使用：
//   ① line_stations  → seed-maps で投入された大阪府全路線の駅名マスタ（駅判定に使用）
//   ② station_map    → AI学習済み駅名マッピング（token → ward, realpro_lines 等）
//   ③ region_map     → AI学習済み地域マッピング（token → ward）
// ward_codes は未投入のため参照しない。
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 60;

// ── 駅名・地域名を一括ロード（resolve-area と同じテーブル群）───────────────
async function loadKnowledge(): Promise<{
  stationNames: Set<string>;
  learnedStations: Set<string>;
  learnedRegions: Set<string>;
}> {
  const [
    { data: lsRows },
    { data: smRows },
    { data: rmRows },
  ] = await Promise.all([
    supabase.from("line_stations").select("station_name"),
    supabase.from("station_map").select("token").gt("confidence", 0),  // 信頼度0超のみ
    supabase.from("region_map").select("token"),
  ]);

  return {
    stationNames:  new Set((lsRows  || []).map(r => r.station_name)),
    learnedStations: new Set((smRows || []).map(r => r.token)),
    learnedRegions:  new Set((rmRows || []).map(r => r.token)),
  };
}

// ── トークン単純分解（サーバーサイド軽量版）─────────────────────────────────
const PFX_RE = /^(?:阪急|阪神|南海|近鉄|JR|京阪|大阪メトロ|地下鉄)/;

function tokenizeArea(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[,、・\/\s　]+/)
    .map(t =>
      t
        .replace(/駅$|周辺$|付近$|近く$|近辺$|沿線$|エリア$|あたり$/, "")
        .trim()
    )
    .filter(t => t.length >= 2 && !/^[0-9０-９]/.test(t));
}

// ── 1トークンが駅かどうか判定（resolve-area と同一知識源）─────────────────
function isStation(
  token: string,
  { stationNames, learnedStations }: { stationNames: Set<string>; learnedStations: Set<string> }
): boolean {
  const variants = [
    token,
    token.replace(/[町村]$/, ""),
    token.replace(PFX_RE, ""),
    token.replace(PFX_RE, "").replace(/[町村]$/, ""),
  ];
  return variants.some(v => stationNames.has(v) || learnedStations.has(v));
}

// ── 1トークンが地域かどうか判定 ────────────────────────────────────────────
function isRegion(
  token: string,
  { learnedRegions }: { learnedRegions: Set<string> }
): boolean {
  return learnedRegions.has(token) || learnedRegions.has(token + "市");
}

export async function GET(req: NextRequest) {
  // Vercel Cron 認証
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ① 知識ベースをまとめてロード（resolve-area と同じ3テーブル）
  const knowledge = await loadKnowledge();

  if (knowledge.stationNames.size === 0) {
    // seed-maps が未実行で line_stations が空の場合はスキップ
    console.warn("[classify-area-modes] line_stations が空。/api/seed-maps を実行してください。");
    return NextResponse.json({ skipped: true, reason: "line_stations is empty" });
  }

  // ② area_mode = 'auto' かつ desired_area がある顧客を全件取得
  const { data: customers, error } = await supabase
    .from("property_customers")
    .select("id, desired_area, area")
    .eq("area_mode", "auto")
    .or("desired_area.not.is.null,area.not.is.null")
    .neq("status", "lost");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!customers || customers.length === 0) {
    return NextResponse.json({ updated: 0, message: "対象顧客なし" });
  }

  // ③ 各顧客のエリアを分類
  const updates: { id: string; area_mode: string }[] = [];

  for (const c of customers) {
    const rawArea = (c.desired_area || c.area || "").trim();
    if (!rawArea) continue;

    const tokens = tokenizeArea(rawArea);
    // 路線名トークン（〜線）は駅でも地域でもないためカウントから除外
    const meaningful = tokens.filter(t => !t.endsWith("線"));
    if (meaningful.length === 0) continue;

    const stCount = meaningful.filter(t => isStation(t, knowledge)).length;
    const rgCount = meaningful.filter(t => isRegion(t, knowledge)).length;

    // 駅のみ → station / 地域のみ → ward / 混在・不明 → auto のまま
    if (stCount > 0 && rgCount === 0 && stCount === meaningful.length) {
      updates.push({ id: c.id, area_mode: "station" });
    } else if (rgCount > 0 && stCount === 0) {
      updates.push({ id: c.id, area_mode: "ward" });
    }
    // 混在・全不明は area_mode を変更しない（auto のまま = resolve-area の動的判定に委ねる）
  }

  // ④ バッチ更新
  let updated = 0;
  for (const u of updates) {
    const { error: ue } = await supabase
      .from("property_customers")
      .update({ area_mode: u.area_mode })
      .eq("id", u.id);
    if (!ue) updated++;
  }

  const log = `[classify-area-modes] ${customers.length}件チェック → station:${updates.filter(u => u.area_mode === "station").length}件 ward:${updates.filter(u => u.area_mode === "ward").length}件 更新`;
  console.log(log);
  return NextResponse.json({
    checked: customers.length,
    updated,
    station: updates.filter(u => u.area_mode === "station").length,
    ward: updates.filter(u => u.area_mode === "ward").length,
    knowledge: {
      line_stations: knowledge.stationNames.size,
      learned_stations: knowledge.learnedStations.size,
      learned_regions: knowledge.learnedRegions.size,
    },
  });
}
