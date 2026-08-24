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

// ── 1トークンの分類シグナルを判定（Chrome拡張 classifyAreaTokens と同じ優先順）
// シグナル:
//   "station" … 鉄道会社プレフィックス / 〜線 / DB(line_stations・station_map)で確認できる駅名
//   "area"    … 市区郡サフィックス / DB(region_map)で確認できる地域名
//   "unknown" … どちらにも当たらない
type TokenType = "station" | "area" | "unknown";

function classifyToken(
  token: string,
  knowledge: { stationNames: Set<string>; learnedStations: Set<string>; learnedRegions: Set<string> }
): TokenType {
  // ① 鉄道会社プレフィックス → 駅（明確）
  if (PFX_RE.test(token)) return "station";
  // ② 〜線で終わる → 路線（駅系）
  if (token.endsWith("線")) return "station";
  // ③ 市区郡サフィックス → 地域（明確）
  if (/[市区郡]$/.test(token)) return "area";

  // の→ノ・ヶ→ケ の表記ゆれを正規化してDBと突合
  const normKana = token.replace(/の/g, "ノ").replace(/ヶ/g, "ケ");
  const variants = [
    token,
    normKana,
    token.replace(/[町村]$/, ""),
    normKana.replace(/[町村]$/, ""),
    token.replace(PFX_RE, ""),
    token.replace(PFX_RE, "").replace(/[町村]$/, ""),
  ];

  // ④ line_stations / station_map に存在 → 駅
  const inStation = variants.some(v => knowledge.stationNames.has(v) || knowledge.learnedStations.has(v));
  // ⑤ region_map に存在（市サフィックス補完含む）→ 地域
  const inRegion = knowledge.learnedRegions.has(token) || knowledge.learnedRegions.has(token + "市")
    || knowledge.learnedRegions.has(normKana);

  if (inStation && !inRegion) return "station";
  if (!inStation && inRegion) return "area";
  if (inStation && inRegion)  return "station"; // 両方ヒット → 駅優先（Chrome拡張と同じルール）
  return "unknown";
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
    if (tokens.length === 0) continue;

    // 各トークンを独立分類
    const classified = tokens.map(t => classifyToken(t, knowledge));
    const stCount = classified.filter(t => t === "station").length;
    const rgCount = classified.filter(t => t === "area").length;
    const unkCount = classified.filter(t => t === "unknown").length;

    // 曖昧トークンのコンテキスト解決（Chrome拡張の多数決と同じルール）
    // unknown が station・area どちらかに引き寄せられる（同数は駅優先）
    const resolvedStCount = stCount + (stCount >= rgCount ? unkCount : 0);
    const resolvedRgCount = rgCount + (rgCount > stCount ? unkCount : 0);

    // 駅が1つでも → station / 地域のみ → ward / 全不明 → auto のまま
    // 混在（駅+区レベル地名）でも区優先: Chrome拡張の setupAreaModeSelector と同じルール
    const hasSpecificWard = tokens.some((t, i) =>
      classified[i] === "area" && /[区郡]$/.test(t)
    );
    if (resolvedStCount > 0 && !hasSpecificWard) {
      updates.push({ id: c.id, area_mode: "station" });
    } else if (resolvedStCount > 0 && hasSpecificWard) {
      updates.push({ id: c.id, area_mode: "ward" }); // 駅+区レベル地域の混在 → ward優先
    } else if (resolvedRgCount > 0) {
      updates.push({ id: c.id, area_mode: "ward" });
    }
    // 全不明 は auto のまま
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

  const log = `[classify-area-modes] ${customers.length}件チェック → station:${updates.filter(u => u.area_mode === "station").length}件 ward:${updates.filter(u => u.area_mode === "ward").length}件 更新（の→ノ正規化・市区郡判定・コンテキスト多数決 適用済み）`;
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
