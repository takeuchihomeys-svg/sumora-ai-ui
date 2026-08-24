// @ts-nocheck
import { supabase } from "@/app/lib/supabase";

// ── 型定義 ──────────────────────────────────────────────────────────────────

export interface CustomerConditions {
  id: string;
  customerName: string;
  desiredArea: string | null;
  areaMode: "station" | "ward" | "both" | "auto" | null;
  rentMin: number | null;
  rentMax: number | null;
  floorPlan: string | null;
  floorAreaMin: number | null;
  floorAreaMax: number | null;
  walkMinutes: number | null;
  commuteStation: string | null;
  commuteMinutes: number | null;
  moveInTime: string | null;
  pet: boolean | null;
  initialCostLimit: number | null;
  buildingAge: number | null;
  preferences: string | null;
  ngPoints: string | null;
  otherRequests: string | null;
  personalityProfile: string | null;
  aiSummaryJson: Record<string, unknown> | null;
  lastPropertySentAt: string | null;
  propertySendCount: number;
}

export interface SentPropertyRecord {
  propertyName: string;
  roomNo: string;
  sentAt: string;
  rent: number | null;
  customerReaction: "interested" | "rejected" | "no_response" | null;
  recruitmentStatus: "open" | "move_out_planned" | "occupied" | "closed" | null;
  applicantRank: number | null;
  propertyUrl: string | null;
}

export interface AreaKnowledge {
  // station_map でマッチした駅名（学習済み）
  resolvedStations: string[];
  // region_map でマッチした市区名（学習済み）
  resolvedWards: string[];
  // line_stations から ±2駅展開した周辺駅
  nearbyStations: string[];
}

export interface LearnedPattern {
  title: string;
  principle: string;
  pattern: string | null;
}

export interface PropertyBrainContext {
  customer: CustomerConditions;
  // 直近30件（sent_at降順）
  sentHistory: SentPropertyRecord[];
  // desired_area を RAG 検索した結果
  areaKnowledge: AreaKnowledge;
  // brain_meta_insights から物件検索関連の学習パターン
  learnedPatterns: LearnedPattern[];
}

// ── エリアトークン分解 ───────────────────────────────────────────────────────
// classify-area-modes / inferAreaMode と同一ロジック（単一化せずコピー保持 — import chain 循環防止）
function tokenizeArea(raw: string): string[] {
  return raw
    .split(/[,、・\/\s　]+|又は|もしくは/)
    .map(t => t.replace(/駅$|周辺$|付近$|近く$|近辺$|沿線$|エリア$|あたり$/, "").trim())
    .filter(t => t.length >= 2 && !/^[0-9０-９]/.test(t) && !t.endsWith("線"));
}

// ── 隣駅展開（±N駅） ────────────────────────────────────────────────────────
async function expandNearbyStations(stationName: string, range = 2): Promise<string[]> {
  const { data: anchor } = await supabase
    .from("line_stations")
    .select("line_name, order_idx")
    .eq("station_name", stationName)
    .limit(1)
    .maybeSingle();
  if (!anchor) return [];

  const { data: nearby } = await supabase
    .from("line_stations")
    .select("station_name")
    .eq("line_name", anchor.line_name)
    .gte("order_idx", anchor.order_idx - range)
    .lte("order_idx", anchor.order_idx + range)
    .neq("station_name", stationName);

  return (nearby ?? []).map((r: { station_name: string }) => r.station_name);
}

// ── メイン: コンテキスト組み立て ────────────────────────────────────────────
export async function buildPropertyBrainContext(
  customerId: string
): Promise<PropertyBrainContext | null> {

  // ── Step 1: 顧客条件 / 送付履歴 / 学習パターンを並列取得 ──
  const [
    { data: pc },
    { data: sentRows },
    { data: patternRows },
  ] = await Promise.all([
    supabase
      .from("property_customers")
      .select(
        "id, customer_name, desired_area, area_mode, " +
        "rent_min, rent_max, floor_plan, floor_area_min, floor_area_max, " +
        "walk_minutes, commute_station, commute_minutes, " +
        "move_in_time, pet, initial_cost_limit, building_age, " +
        "preferences, ng_points, other_requests, " +
        "personality_profile, ai_summary_json, " +
        "last_property_sent_at, property_send_count"
      )
      .eq("id", customerId)
      .single(),

    supabase
      .from("sent_properties")
      .select(
        "property_name, room_no, sent_at, rent, " +
        "customer_reaction, recruitment_status, applicant_rank, property_url"
      )
      .eq("property_customer_id", customerId)
      .order("sent_at", { ascending: false })
      .limit(30),

    supabase
      .from("brain_meta_insights")
      .select("title, principle, pattern")
      .eq("impact", "high")
      .in("category", ["quality_improvement", "architecture"])
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  if (!pc) return null;

  // ── Step 2: desired_area を RAG 検索（station_map / region_map） ──
  const areaKnowledge: AreaKnowledge = {
    resolvedStations: [],
    resolvedWards: [],
    nearbyStations: [],
  };

  if (pc.desired_area) {
    const tokens = tokenizeArea(pc.desired_area as string);

    if (tokens.length > 0) {
      const [{ data: stationMatches }, { data: regionMatches }] = await Promise.all([
        supabase
          .from("station_map")
          .select("token, ward")
          .in("token", tokens)
          .gt("confidence", 0),
        supabase
          .from("region_map")
          .select("token, ward")
          .in("token", tokens),
      ]);

      areaKnowledge.resolvedStations = (stationMatches ?? []).map(
        (r: { token: string }) => r.token
      );
      areaKnowledge.resolvedWards = [
        ...new Set((regionMatches ?? []).map((r: { ward: string }) => r.ward)),
      ];

      // 解決済み駅の周辺駅を展開（最大5駅まで展開対象）
      if (areaKnowledge.resolvedStations.length > 0) {
        const nearbyArrays = await Promise.all(
          areaKnowledge.resolvedStations.slice(0, 5).map(s => expandNearbyStations(s))
        );
        areaKnowledge.nearbyStations = [
          ...new Set(nearbyArrays.flat()),
        ].filter(s => !areaKnowledge.resolvedStations.includes(s));
      }
    }
  }

  // ── Step 3: 型変換して返す ──
  const customer: CustomerConditions = {
    id: pc.id as string,
    customerName: pc.customer_name as string,
    desiredArea: (pc.desired_area as string | null) ?? null,
    areaMode: (pc.area_mode as CustomerConditions["areaMode"]) ?? null,
    rentMin: (pc.rent_min as number | null) ?? null,
    rentMax: (pc.rent_max as number | null) ?? null,
    floorPlan: (pc.floor_plan as string | null) ?? null,
    floorAreaMin: (pc.floor_area_min as number | null) ?? null,
    floorAreaMax: (pc.floor_area_max as number | null) ?? null,
    walkMinutes: (pc.walk_minutes as number | null) ?? null,
    commuteStation: (pc.commute_station as string | null) ?? null,
    commuteMinutes: (pc.commute_minutes as number | null) ?? null,
    moveInTime: (pc.move_in_time as string | null) ?? null,
    pet: (pc.pet as boolean | null) ?? null,
    initialCostLimit: (pc.initial_cost_limit as number | null) ?? null,
    buildingAge: (pc.building_age as number | null) ?? null,
    preferences: (pc.preferences as string | null) ?? null,
    ngPoints: (pc.ng_points as string | null) ?? null,
    otherRequests: (pc.other_requests as string | null) ?? null,
    personalityProfile: (pc.personality_profile as string | null) ?? null,
    aiSummaryJson: (pc.ai_summary_json as Record<string, unknown> | null) ?? null,
    lastPropertySentAt: (pc.last_property_sent_at as string | null) ?? null,
    propertySendCount: (pc.property_send_count as number) ?? 0,
  };

  const sentHistory: SentPropertyRecord[] = (sentRows ?? []).map(r => ({
    propertyName: r.property_name as string,
    roomNo: r.room_no as string,
    sentAt: r.sent_at as string,
    rent: (r.rent as number | null) ?? null,
    customerReaction: (r.customer_reaction as SentPropertyRecord["customerReaction"]) ?? null,
    recruitmentStatus: (r.recruitment_status as SentPropertyRecord["recruitmentStatus"]) ?? null,
    applicantRank: (r.applicant_rank as number | null) ?? null,
    propertyUrl: (r.property_url as string | null) ?? null,
  }));

  const learnedPatterns: LearnedPattern[] = (patternRows ?? []).map(r => ({
    title: r.title as string,
    principle: r.principle as string,
    pattern: (r.pattern as string | null) ?? null,
  }));

  return { customer, sentHistory, areaKnowledge, learnedPatterns };
}

// ── テキスト形式でブレインプロンプトに注入できる文字列に変換 ─────────────────
export function formatContextForPrompt(ctx: PropertyBrainContext): string {
  const { customer: c, sentHistory, areaKnowledge } = ctx;

  const lines: string[] = [];

  // 顧客条件
  lines.push("【顧客条件】");
  if (c.desiredArea) lines.push(`エリア: ${c.desiredArea}（モード: ${c.areaMode ?? "auto"}）`);
  if (c.rentMin || c.rentMax) lines.push(`家賃: ${c.rentMin ?? "下限なし"}〜${c.rentMax ?? "上限なし"}円`);
  if (c.floorPlan)    lines.push(`間取り: ${c.floorPlan}`);
  if (c.floorAreaMin || c.floorAreaMax) lines.push(`広さ: ${c.floorAreaMin ?? ""}〜${c.floorAreaMax ?? ""}㎡`);
  if (c.walkMinutes)  lines.push(`駅徒歩: ${c.walkMinutes}分以内`);
  if (c.commuteStation) lines.push(`通勤先: ${c.commuteStation}（${c.commuteMinutes ?? "?"}分）`);
  if (c.moveInTime)   lines.push(`入居時期: ${c.moveInTime}`);
  if (c.pet)          lines.push("ペット: 可");
  if (c.initialCostLimit) lines.push(`初期費用上限: ${c.initialCostLimit.toLocaleString()}円`);
  if (c.buildingAge)  lines.push(`築年数: ${c.buildingAge}年以内`);
  if (c.preferences)  lines.push(`こだわり: ${c.preferences}`);
  if (c.ngPoints)     lines.push(`NG条件: ${c.ngPoints}`);
  if (c.otherRequests) lines.push(`その他: ${c.otherRequests}`);

  // エリア知識
  if (areaKnowledge.resolvedStations.length > 0) {
    lines.push(`\n【エリア知識（RAG）】`);
    lines.push(`解決済み駅: ${areaKnowledge.resolvedStations.join("・")}`);
    if (areaKnowledge.resolvedWards.length > 0)
      lines.push(`解決済み区: ${areaKnowledge.resolvedWards.join("・")}`);
    if (areaKnowledge.nearbyStations.length > 0)
      lines.push(`周辺駅: ${areaKnowledge.nearbyStations.join("・")}`);
  }

  // 送付履歴
  if (sentHistory.length > 0) {
    lines.push(`\n【送付履歴（直近${sentHistory.length}件）】`);
    for (const s of sentHistory.slice(0, 10)) {
      const reaction = s.customerReaction === "interested" ? "興味あり"
        : s.customerReaction === "rejected" ? "見送り" : "反応なし";
      const status = s.recruitmentStatus === "open" ? "募集中"
        : s.recruitmentStatus === "closed" ? "募集終了" : s.recruitmentStatus ?? "";
      lines.push(
        `・${s.propertyName} ${s.roomNo}` +
        (s.rent ? ` ${s.rent.toLocaleString()}円` : "") +
        ` [${reaction}]${status ? ` [${status}]` : ""}`
      );
    }
    if (sentHistory.length > 10) lines.push(`  …他${sentHistory.length - 10}件`);

    const interested = sentHistory.filter(s => s.customerReaction === "interested").length;
    const rejected   = sentHistory.filter(s => s.customerReaction === "rejected").length;
    lines.push(`興味あり: ${interested}件 / 見送り: ${rejected}件 / 合計: ${sentHistory.length}件`);
  } else {
    lines.push("\n【送付履歴】なし（初回検索）");
  }

  return lines.join("\n");
}
