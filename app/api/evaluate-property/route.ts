import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { generateEmbedding } from "@/app/lib/knowledge-utils";

export const maxDuration = 25;

// CORS headers — allow Chrome extension origins
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ─── Levenshtein distance ────────────────────────────────────────────────────
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] =
        a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

function stringSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.trim().toLowerCase();
  const na = norm(a);
  const nb = norm(b);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

// ─── 間取りユーティリティ ────────────────────────────────────────────────────
function parseFloorPlan(fp: string): { rooms: number; type: string } | null {
  const s = fp.trim().toUpperCase().replace(/ワンルーム/g, "1R");
  const m = s.match(/(\d+)\s*(R|K|DK|LDK|SK|SDK|SLDK)/);
  if (!m) return null;
  return { rooms: parseInt(m[1], 10), type: m[2] };
}

// ─── [QW8] profile_tags 動的配点テーブル ────────────────────────────────────
type WeightKey = "budget" | "floor_plan" | "walk" | "ad" | "area_per_rent";
const WEIGHT_PRESETS: Record<string, Record<WeightKey, number>> = {
  "費用重視":   { budget: 55, floor_plan: 15, walk: 15, ad:  5, area_per_rent: 10 },
  "広さ重視":   { budget: 30, floor_plan: 20, walk: 10, ad: 10, area_per_rent: 20 },
  "通勤重視":   { budget: 30, floor_plan: 15, walk: 30, ad: 10, area_per_rent: 10 },
  "築浅重視":   { budget: 35, floor_plan: 20, walk: 15, ad: 15, area_per_rent: 15 },
};
const DEFAULT_WEIGHTS: Record<WeightKey, number> = {
  budget: 40, floor_plan: 20, walk: 15, ad: 15, area_per_rent: 10,
};

// ─── リクエスト型 ────────────────────────────────────────────────────────────
interface PropertyInput {
  name: string;
  room_no: string;
  rent: number;
  admin_fee?: number;
  floor_plan?: string;
  area_sqm?: number;
  walk_minutes?: number;
  deposit?: number;
  key_money?: number;
  ad_months?: number;
  building_age?: number;
}

interface EvaluateRequestBody {
  property_customer_id?: string;
  property?: Partial<PropertyInput>;
}

// ─── OPTIONS (preflight) ─────────────────────────────────────────────────────
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// ─── POST handler ────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let body: EvaluateRequestBody;
  try {
    body = (await req.json()) as EvaluateRequestBody;
  } catch {
    return NextResponse.json(
      { error: "リクエストbodyのJSONが不正です" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const propertyCustomerId = body.property_customer_id;
  const property = body.property;

  if (!propertyCustomerId) {
    return NextResponse.json(
      { error: "property_customer_id は必須です" },
      { status: 400, headers: CORS_HEADERS }
    );
  }
  if (!property || typeof property.rent !== "number") {
    return NextResponse.json(
      { error: "property.rent（家賃・数値）は必須です" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const propertyName = (property.name ?? "").trim();
  const roomNo = (property.room_no ?? "").trim();

  // ── 顧客条件取得 ───────────────────────────────────────────────────────────
  // [QW6] initial_cost_limit を追加
  const { data: customer, error: customerError } = await supabase
    .from("property_customers")
    .select(
      "rent_max, max_rent, walk_minutes, floor_plan, layout, floor_area_min, pet, building_age, desired_area, preferences, ng_points, initial_cost_limit, personality_profile, ai_summary_json, exclusion_areas"
    )
    .eq("id", propertyCustomerId)
    .single();

  // AIX-META取得（最新会話からwinning_pattern/repeated_concernを取得）
  const { data: convRow } = await supabase
    .from("conversations")
    .select("suggested_aix_meta")
    .eq("property_customer_id", propertyCustomerId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const aixMeta = convRow?.suggested_aix_meta as { winning_pattern?: string; repeated_concern?: string } | null;

  if (customerError || !customer) {
    return NextResponse.json(
      { error: `顧客が見つかりません: ${customerError?.message ?? "not found"}` },
      { status: 404, headers: CORS_HEADERS }
    );
  }

  const customerRentMax: number | null =
    (customer.rent_max as number | null) ?? (customer.max_rent as number | null) ?? null;
  const customerWalk: number | null = (customer.walk_minutes as number | null) ?? null;
  const customerFloorPlan: string | null =
    (customer.floor_plan as string | null) ?? (customer.layout as string | null) ?? null;
  const customerAreaMin: number | null = (customer.floor_area_min as number | null) ?? null;
  const customerBuildingAge: number | null = (customer.building_age as number | null) ?? null;
  // [QW1] DeepSeekプロンプト用
  const customerNgPoints: string | null = (customer.ng_points as string | null) ?? null;
  const customerPreferences: string | null = (customer.preferences as string | null) ?? null;
  const customerDesiredArea: string | null = (customer.desired_area as string | null) ?? null;
  // [QW6] 初期費用上限
  const customerInitialCostLimit: number | null = (customer.initial_cost_limit as number | null) ?? null;

  // ── 重複チェック（sent_properties） ───────────────────────────────────────
  const { data: sentRows, error: sentError } = await supabase
    .from("sent_properties")
    .select("property_name, room_no, sent_at")
    .eq("property_customer_id", propertyCustomerId)
    .order("sent_at", { ascending: false });

  if (sentError) {
    return NextResponse.json(
      { error: sentError.message },
      { status: 500, headers: CORS_HEADERS }
    );
  }

  const normalizedRoomNo = roomNo.toLowerCase();
  const isDuplicate = (sentRows ?? []).some((row) => {
    const rowRoom = ((row.room_no as string) ?? "").trim().toLowerCase();
    const rowName = ((row.property_name as string) ?? "").trim();
    if (normalizedRoomNo && rowRoom === normalizedRoomNo) return true;
    if (propertyName && stringSimilarity(rowName, propertyName) >= 0.8) return true;
    return false;
  });

  // ── スコアリング ──────────────────────────────────────────────────────────
  const ngFlags: string[] = [];
  const rent = property.rent;
  // [QW2] 管理費込み月額合計を計算
  const totalMonthly = rent + (property.admin_fee ?? 0);

  // [QW8] profile_tags は後で取得するため、まず DEFAULT_WEIGHTS で計算（後でプロファイル適用）
  const W = DEFAULT_WEIGHTS;

  // budget（0〜W.budget点）[QW2] totalMonthly で比較
  let budgetScore = 0;
  if (customerRentMax == null || customerRentMax <= 0) {
    budgetScore = W.budget;
  } else if (totalMonthly <= customerRentMax) {
    budgetScore = W.budget;
  } else if (totalMonthly <= customerRentMax * 1.05) {
    budgetScore = Math.round(W.budget * 0.625);
  } else if (totalMonthly <= customerRentMax * 1.1) {
    budgetScore = Math.round(W.budget * 0.25);
  } else {
    budgetScore = 0;
    ngFlags.push("予算超過");
  }

  // floor_plan（0〜W.floor_plan点）
  let floorPlanScore = 0;
  if (!customerFloorPlan || !customerFloorPlan.trim()) {
    floorPlanScore = W.floor_plan;
  } else if (!property.floor_plan || !property.floor_plan.trim()) {
    floorPlanScore = Math.round(W.floor_plan * 0.5);
  } else {
    const wantParsed = parseFloorPlan(customerFloorPlan);
    const propParsed = parseFloorPlan(property.floor_plan);
    const normWant = customerFloorPlan.trim().toUpperCase().replace(/\s/g, "");
    const normProp = property.floor_plan.trim().toUpperCase().replace(/\s/g, "");
    if (normWant === normProp) {
      floorPlanScore = W.floor_plan;
    } else if (wantParsed && propParsed && wantParsed.rooms === propParsed.rooms) {
      floorPlanScore = Math.round(W.floor_plan * 0.5);
    } else {
      floorPlanScore = 0;
      ngFlags.push("間取り不一致");
    }
  }

  // walk（0〜W.walk点）
  let walkScore = 0;
  if (customerWalk == null || customerWalk <= 0) {
    walkScore = W.walk;
  } else if (property.walk_minutes == null) {
    walkScore = Math.round(W.walk * 0.5);
  } else if (property.walk_minutes <= customerWalk) {
    walkScore = W.walk;
  } else if (property.walk_minutes <= customerWalk * 1.5) {
    walkScore = Math.round(W.walk * 0.5);
  } else {
    walkScore = 0;
  }

  // ad（0〜W.ad点）
  const adMonths = property.ad_months ?? 0;
  let adScore = 0;
  if (adMonths >= 2) {
    adScore = W.ad;
  } else if (adMonths >= 1) {
    adScore = Math.round(W.ad * 0.5);
  }

  // area_per_rent（0〜W.area_per_rent点）[QW2] totalMonthly で単価計算
  let areaPerRentScore = 0;
  if (property.area_sqm != null && property.area_sqm > 0) {
    const rentPerSqm = totalMonthly / property.area_sqm;
    if (rentPerSqm <= 2000) {
      areaPerRentScore = W.area_per_rent;
    } else if (rentPerSqm <= 2500) {
      areaPerRentScore = Math.round(W.area_per_rent * 0.6);
    } else if (rentPerSqm <= 3000) {
      areaPerRentScore = Math.round(W.area_per_rent * 0.3);
    }
  } else {
    areaPerRentScore = Math.round(W.area_per_rent * 0.5);
  }

  // [QW3] floor_area_min チェック（0-10点）
  let areaMinScore = 0;
  if (!customerAreaMin || customerAreaMin <= 0) {
    areaMinScore = 10;
  } else if (property.area_sqm == null) {
    areaMinScore = 5;
  } else if (property.area_sqm >= customerAreaMin) {
    areaMinScore = 10;
  } else if (property.area_sqm >= customerAreaMin * 0.9) {
    areaMinScore = 5;
  } else {
    areaMinScore = 0;
    ngFlags.push("面積不足");
  }

  // [QW4] building_age スコア（0-10点）
  let buildingAgeScore = 0;
  if (!customerBuildingAge || customerBuildingAge <= 0) {
    buildingAgeScore = 10;
  } else if (property.building_age == null) {
    buildingAgeScore = 5;
  } else if (property.building_age <= 3) {
    buildingAgeScore = 10;
  } else if (property.building_age <= customerBuildingAge * 0.75) {
    buildingAgeScore = 9;
  } else if (property.building_age <= customerBuildingAge) {
    buildingAgeScore = 7;
  } else if (property.building_age <= customerBuildingAge + 3) {
    buildingAgeScore = 3;
  } else {
    buildingAgeScore = 0;
    ngFlags.push("築年数オーバー");
  }

  // [QW6] 初期費用チェック（0-5点）
  let initialCostScore = 0;
  const initialCost = rent * ((property.deposit ?? 0) + (property.key_money ?? 0));
  if (!customerInitialCostLimit || customerInitialCostLimit <= 0) {
    initialCostScore = 5;
  } else if (initialCost <= customerInitialCostLimit) {
    initialCostScore = 5;
  } else if (initialCost <= customerInitialCostLimit * 1.2) {
    initialCostScore = 2;
  } else {
    initialCostScore = 0;
    ngFlags.push("初期費用超過");
  }

  const baseScore =
    budgetScore + floorPlanScore + walkScore + adScore +
    areaPerRentScore + areaMinScore + buildingAgeScore + initialCostScore;

  // ── クロス顧客 + 個人顧客パターン参照（並列取得）────────────────────────
  let patternHints: string[] = [];
  let personalPatterns: string[] = [];
  let noResponsePatterns: string[] = [];  // [QW5] ネガティブシグナル
  let crossProfileTags: string[] = [];
  let ragKnowledge: string[] = [];
  let weightsUsed: string = "default";   // [QW8] 使用配点記録
  try {
    // クロス顧客パターン（家賃帯±15% + 同間取り）
    let crossQ = supabase
      .from("property_selection_patterns")
      .select("selling_points, property_customer_id, customer_profile_tags, customer_reaction")
      .gte("customer_rent_max", Math.round((customerRentMax ?? 0) * 0.85))
      .lte("customer_rent_max", Math.round((customerRentMax ?? 0) * 1.15))
      .limit(200);
    if (customerFloorPlan) crossQ = crossQ.eq("customer_floor_plan", customerFloorPlan);

    // 個人顧客パターン（このお客さん自身の履歴）
    const personalQ = supabase
      .from("property_selection_patterns")
      .select("selling_points, customer_reaction, recommendation_reason")
      .eq("property_customer_id", propertyCustomerId)
      .in("customer_reaction", ["interested", "no_response"])
      .order("created_at", { ascending: false })
      .limit(30);

    // RAG検索クエリ
    const ragQueryStr = [
      customerFloorPlan,
      customerRentMax ? `家賃${Math.round(customerRentMax / 10000)}万円` : null,
      customerWalk ? `駅徒歩${customerWalk}分` : null,
      property.floor_plan,
      property.ad_months ? `広告料${property.ad_months}ヶ月` : null,
    ].filter(Boolean).join(" ");

    // [並列取得] DB3クエリ + RAG embedding を同時実行
    const [crossResult, personalResult, ragResult] = await Promise.all([
      crossQ,
      personalQ,
      ragQueryStr ? (async () => {
        try {
          const embedding = await generateEmbedding(`property_scoring: ${ragQueryStr}`);
          if (!embedding) return null;
          const { data } = await supabase.rpc("match_reply_knowledge", {
            query_embedding: embedding,
            match_count: 10,
            min_importance: 6,
          }) as { data: Array<{ content: string; similarity: number }> | null };
          return (data ?? [])
            .filter(r => r.similarity >= 0.45)
            .slice(0, 5)
            .map(r => r.content);
        } catch { return null; }
      })() : Promise.resolve(null),
    ]) as [
      { data: Array<{ selling_points: string[]; property_customer_id: string; customer_profile_tags: string[] | null; customer_reaction: string }> | null },
      { data: Array<{ selling_points: string[]; customer_reaction: string; recommendation_reason: string | null }> | null },
      string[] | null,
    ];
    ragKnowledge = ragResult ?? [];

    // クロス顧客: 1顧客あたり5件キャップで頻度集計（interested のみ）
    if (crossResult.data && crossResult.data.length > 0) {
      const counts: Record<string, number> = {};
      const seenPerCustomer: Record<string, number> = {};
      const tagCounts: Record<string, number> = {};
      for (const row of crossResult.data) {
        if (row.customer_reaction !== "interested") continue;
        const cid = row.property_customer_id ?? "__unknown__";
        if ((seenPerCustomer[cid] ?? 0) >= 5) continue;
        seenPerCustomer[cid] = (seenPerCustomer[cid] ?? 0) + 1;
        for (const pt of (row.selling_points ?? [])) counts[pt] = (counts[pt] ?? 0) + 1;
        for (const tag of (row.customer_profile_tags ?? [])) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
      }
      patternHints = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([pt]) => pt);
      crossProfileTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
    }

    // 個人顧客: このお客さんが反応したセリングポイント集計
    if (personalResult.data && personalResult.data.length > 0) {
      const personalCounts: Record<string, number> = {};
      // [QW5] ネガティブシグナル集計
      const noResponseCounts: Record<string, number> = {};
      for (const row of personalResult.data) {
        if (row.customer_reaction === "interested") {
          for (const pt of (row.selling_points ?? []))
            personalCounts[pt] = (personalCounts[pt] ?? 0) + 1;
        } else if (row.customer_reaction === "no_response") {
          for (const pt of (row.selling_points ?? []))
            noResponseCounts[pt] = (noResponseCounts[pt] ?? 0) + 1;
        }
      }
      personalPatterns = Object.entries(personalCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([pt]) => pt);
      noResponsePatterns = Object.entries(noResponseCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([pt]) => pt);
    }

    // [QW8] profile_tags が判明した時点で配点を適用し baseScore を再計算
    // クロス顧客から得たタグで最初にマッチしたプリセットを使用
    const matchedTag = crossProfileTags.find(t => WEIGHT_PRESETS[t]);
    if (matchedTag) weightsUsed = matchedTag;
    // ※ 配点プリセット適用は DeepSeek プロンプトの context として渡すのみ
    // （算術スコア再計算は副作用が大きいため、ここでは weights_used の記録のみ）

  } catch { /* ignore */ }

  // ── [QW7] 明確なNG物件は DeepSeek をスキップ ─────────────────────────────
  const isHardNg = ngFlags.includes("予算超過") || ngFlags.includes("間取り不一致");

  // ── DeepSeek 総合採点 ──────────────────────────────────────────────────────
  let score = baseScore;
  let scoreReason: string | null = null;
  let scoreDelta = 0;
  const deepseekKey = process.env.DEEPSEEK_API_KEY ?? "";
  if (deepseekKey && !isHardNg) {
    try {
      const contextParts: string[] = [];
      if (ragKnowledge.length > 0)      contextParts.push(`【物件スコアリングノウハウ】\n${ragKnowledge.join("\n")}`);
      if (patternHints.length > 0)      contextParts.push(`【類似顧客に刺さったポイント】${patternHints.join("・")}`);
      if (personalPatterns.length > 0)  contextParts.push(`【このお客さん自身が反応したポイント】${personalPatterns.join("・")}`);
      // [QW5] ネガティブシグナル
      if (noResponsePatterns.length > 0) contextParts.push(`【このお客さんがスルーした物件の特徴（低評価にすること）】${noResponsePatterns.join("・")}`);
      if (crossProfileTags.length > 0)  contextParts.push(`【類似顧客の傾向】${crossProfileTags.join("・")}（この顧客の配点傾向: ${weightsUsed}）`);
      if (aixMeta?.winning_pattern)    contextParts.push(`【この顧客の成約パターン（スコアに応用）】${aixMeta.winning_pattern}`);
      if (aixMeta?.repeated_concern)   contextParts.push(`【この顧客の繰り返す懸念（懸念を解消できない物件は減点）】${aixMeta.repeated_concern}`);
      if (customer.personality_profile) contextParts.push(`【顧客タイプ】${customer.personality_profile}`);
      if (customer.ai_summary_json) {
        const summaryStr = typeof customer.ai_summary_json === "string"
          ? customer.ai_summary_json
          : JSON.stringify(customer.ai_summary_json);
        contextParts.push(`【顧客AIサマリー】${summaryStr.slice(0, 300)}`);
      }

      const prompt = `以下の情報を踏まえて、この物件をこのお客さんに推薦する総合スコア（0〜100点）と理由を返してください。

【お客さんの条件】
家賃上限: ${customerRentMax ? `${Math.round(customerRentMax / 10000)}万円` : "未設定"}
間取り希望: ${customerFloorPlan ?? "未設定"}
駅徒歩希望: ${customerWalk ? `${customerWalk}分以内` : "未設定"}
希望エリア: ${customerDesiredArea ?? "未設定"}
除外エリア: ${(customer.exclusion_areas as string | null) ?? "なし"}
NG条件（絶対NG）: ${customerNgPoints ?? "なし"}
その他こだわり: ${customerPreferences ?? "なし"}

【物件情報】
家賃: ${Math.round(rent / 10000)}万円
管理費: ${property.admin_fee ? `${property.admin_fee.toLocaleString()}円` : "なし"}（月額合計: ${Math.round(totalMonthly / 10000 * 10) / 10}万円）
間取り: ${property.floor_plan ?? "不明"}
駅徒歩: ${property.walk_minutes != null ? `${property.walk_minutes}分` : "不明"}
広告料: ${property.ad_months ? `${property.ad_months}ヶ月` : "なし"}
敷金: ${property.deposit != null ? `${property.deposit}ヶ月` : "不明"}
礼金: ${property.key_money != null ? `${property.key_money}ヶ月` : "不明"}
築年数: ${property.building_age != null ? `${property.building_age}年` : "不明"}

【算術ベーススコア（参考）】${baseScore}点

${contextParts.join("\n\n")}

`;

      const dsRes = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${deepseekKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-chat",
          max_tokens: 200,
          response_format: { type: "json_object" },
          // systemに静的指示を分離 → DeepSeekの自動プレフィックスキャッシュが効く（キャッシュヒット時74%割引）
          messages: [
            { role: "system", content: "あなたは不動産仲介スタッフのAIアシスタントです。与えられたお客さんの条件・物件情報・スコアリングノウハウをもとに、この物件をこのお客さんに推薦する総合スコア（0〜100点）と理由をJSONで返してください。出力形式: {\"score\": 数値, \"reason\": \"30字以内の理由\", \"ng_flags\": [\"問題点（あれば）\"]}" },
            { role: "user", content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (dsRes.ok) {
        const dsData = await dsRes.json() as { choices?: Array<{ message?: { content?: string } }> };
        const dsText = dsData.choices?.[0]?.message?.content;
        if (dsText) {
          const parsed = JSON.parse(dsText) as { score?: number; reason?: string; ng_flags?: string[] };
          if (typeof parsed.score === "number" && parsed.score >= 0 && parsed.score <= 100) {
            score = Math.round(parsed.score);
            scoreReason = parsed.reason ?? null;
            scoreDelta = score - baseScore;
            if (parsed.ng_flags) ngFlags.push(...parsed.ng_flags.filter(f => !ngFlags.includes(f)));
          }
        }
      }
    } catch { /* DeepSeekエラーは無視・算術スコアにフォールバック */ }
  }

  // [QW9] score_delta をログ記録（追認率モニタリング）
  console.log(JSON.stringify({
    ev: "evaluate-property",
    score,
    base_score: baseScore,
    score_delta: scoreDelta,
    hard_ng: isHardNg,
    fallback: score === baseScore,
    ng_flags: ngFlags,
    weights_used: weightsUsed,
  }));

  return NextResponse.json(
    {
      score,
      base_score: baseScore,
      score_delta: scoreDelta,
      score_reason: scoreReason,
      is_duplicate: isDuplicate,
      recommended: score >= 70 && !isDuplicate,
      ng_flags: ngFlags,
      score_breakdown: {
        budget: budgetScore,
        floor_plan: floorPlanScore,
        walk: walkScore,
        ad: adScore,
        area_per_rent: areaPerRentScore,
        area_min: areaMinScore,
        building_age: buildingAgeScore,
        initial_cost: initialCostScore,
      },
      customer_conditions: {
        rent_max: customerRentMax,
        floor_plan: customerFloorPlan,
        walk_minutes: customerWalk,
        area_min: customerAreaMin,
        building_age: customerBuildingAge,
        desired_area: customerDesiredArea,
      },
      pattern_hints: patternHints,
      personal_patterns: personalPatterns,
      no_response_patterns: noResponsePatterns,
      cross_profile_tags: crossProfileTags,
      weights_used: weightsUsed,
      rag_knowledge: ragKnowledge,
    },
    { headers: CORS_HEADERS }
  );
}
