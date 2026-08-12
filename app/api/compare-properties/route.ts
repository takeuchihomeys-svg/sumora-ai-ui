import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 120;

// 売上番長グループへの LINE 送信トークン（既存インフラ流用）
const TOKEN =
  process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ??
  process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN ??
  "";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
  timeout: 90_000,
});

// ─── 型定義 ──────────────────────────────────────────────────────────────────

export type PropertyItem = {
  building_name: string;
  room_number?: string;
  rent: number | null; // 円
  management_fee?: number;
  floor_plan?: string;
  area?: number; // m²
  address?: string;
  station_info?: string; // 例: "御堂筋線 江坂駅 徒歩5分"
  available_date?: string;
  building_age?: number | null; // 築年数（年）
  url?: string;
};

type ScoredItem = {
  building_name: string;
  room: string;
  score: number;
  comment: string;
};

type BestItem = {
  building_name: string;
  room: string;
  reason: string;
};

type AIResult = {
  scored: ScoredItem[];
  best: BestItem | null;
};

// ─── LINE 送信ヘルパー ───────────────────────────────────────────────────────

async function getGroupId(overrideId?: string): Promise<string | null> {
  if (overrideId) return overrideId;
  const { data } = await supabase
    .from("hanbancyo_settings")
    .select("value")
    .eq("key", "group_id")
    .maybeSingle();
  return (data?.value as string | null) ?? null;
}

// 修正8: 送信成否を boolean で返す（従来はLINE API 400/401でも呼び出し側が lineSent:true にしていた）
async function pushToLine(to: string, text: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("[compare-properties] LINE push failed:", res.status, errText);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[compare-properties] LINE push error:", e);
    return false;
  }
}

// ─── フォーマットヘルパー ────────────────────────────────────────────────────

function formatRent(rent: number | null): string {
  if (rent === null || rent === 0) return "不明";
  const man = rent / 10000;
  return `${man % 1 === 0 ? man : man.toFixed(1)}万円`;
}

function buildLineMessage(
  customerName: string,
  properties: PropertyItem[],
  scored: ScoredItem[],
  best: BestItem | null,
  sourceLabel?: string,
): string {
  // building_name → PropertyItem の逆引きマップ
  const propMap = new Map<string, PropertyItem>();
  for (const p of properties) {
    propMap.set(p.building_name, p);
  }

  const siteSuffix = sourceLabel ? `（${sourceLabel}）` : "";
  const lines: string[] = [
    `🏠【${customerName}さん 物件検索結果${siteSuffix}】`,
    "",
    `📋 候補物件一覧（${scored.length}件）:`,
    "━━━━━━━━━━━━━━",
  ];

  scored.forEach((s, i) => {
    const prop = propMap.get(s.building_name);
    const isBest = best && s.building_name === best.building_name && s.room === best.room;
    const star = isBest ? "🌟 " : "";
    const roomStr = s.room ? ` ${s.room}` : "";
    const rentStr = prop ? formatRent(prop.rent) : "不明";
    const planStr = prop?.floor_plan ? ` / ${prop.floor_plan}` : "";
    const areaStr = prop?.area ? ` / ${prop.area}㎡` : "";
    const stationStr = prop?.station_info ? `\n   ${prop.station_info}` : "";

    lines.push(`${i + 1}. ${star}${s.building_name}${roomStr} ★${s.score}/10`);
    lines.push(`   ${rentStr}${planStr}${areaStr}${stationStr}`);
    lines.push(`   ${s.comment}`);
    if (isBest && best.reason) {
      lines.push(`   💬 ${best.reason}`);
    }
  });

  return lines.join("\n");
}

// ─── POST ハンドラ ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      properties?: PropertyItem[];
      customerId?: string;
      conditions?: {
        rent_max?: number;
        walk_minutes?: number;
        floor_plan?: string;
        building_age?: number;
        pet_ok?: boolean;
        station_names?: string[];
        desired_area?: string;
      };
      customerName?: string;
      lineGroupId?: string;
      site?: string;
    };

    // ─── バリデーション ──────────────────────────────────────────────────────
    if (!body.properties || body.properties.length === 0) {
      return NextResponse.json(
        { ok: false, error: "properties が必要です" },
        { status: 400 }
      );
    }
    if (!body.customerId) {
      return NextResponse.json(
        { ok: false, error: "customerId が必要です" },
        { status: 400 }
      );
    }
    // 修正1: フィールド形式バリデーション — building_name 欠落は送信側のフィールド名不一致
    // （例: リアプロ経路の name/access/move_in/detail_url 形式のまま送信）を早期検出する
    if (
      typeof body.properties[0]?.building_name !== "string" ||
      body.properties[0].building_name.length === 0
    ) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "properties[0].building_name がありません（フィールド名不一致の可能性: name→building_name / access→station_info / move_in→available_date / detail_url→url の変換を確認）",
        },
        { status: 400 }
      );
    }

    // ─── 1. 顧客情報を Supabase から取得 ────────────────────────────────────
    const { data: customer, error: custErr } = await supabase
      .from("property_customers")
      .select(
        "id, customer_name, rent_max, max_rent, desired_area, walk_minutes, floor_plan, building_age, pet, preferences, ng_points, additional_conditions"
      )
      .eq("id", body.customerId)
      .single();

    if (custErr || !customer) {
      return NextResponse.json(
        { ok: false, error: custErr?.message ?? "顧客が見つかりません" },
        { status: 404 }
      );
    }

    const customerName =
      body.customerName ?? (customer.customer_name as string) ?? "";

    // body.conditions でオーバーライド可能（未指定は DB 値を使用）
    const cond = body.conditions ?? {};
    const rentMax =
      cond.rent_max ??
      (customer.rent_max as number | null) ??
      (customer.max_rent as number | null) ??
      null;
    const walkMin =
      cond.walk_minutes ?? (customer.walk_minutes as number | null) ?? null;
    const floorPlan =
      cond.floor_plan ?? (customer.floor_plan as string | null) ?? null;
    const buildingAge =
      cond.building_age ?? (customer.building_age as number | null) ?? null;
    const petOk =
      cond.pet_ok !== undefined
        ? cond.pet_ok
        : (customer.pet as boolean | null) ?? null;
    const desiredArea =
      cond.desired_area ?? (customer.desired_area as string | null) ?? null;
    const preferences = (customer.preferences as string | null) ?? null;
    const ngPoints = (customer.ng_points as string | null) ?? null;
    const additionalCond =
      (customer.additional_conditions as string | null) ?? null;

    // ─── 2. 物件数を最大 20 件に制限 ────────────────────────────────────────
    const MAX_PROPS = 20;
    const properties = body.properties.slice(0, MAX_PROPS);

    // ─── 3. AI プロンプト構築 ────────────────────────────────────────────────
    const condLines: string[] = [];
    if (rentMax) condLines.push(`- 賃料上限: ${(rentMax / 10000).toFixed(1)}万円`);
    if (desiredArea) condLines.push(`- 沿線・エリア: ${desiredArea}`);
    if (walkMin) condLines.push(`- 徒歩: ${walkMin}分以内`);
    if (floorPlan) condLines.push(`- 間取り: ${floorPlan}`);
    if (buildingAge) condLines.push(`- 築年数: ${buildingAge}年以内`);
    if (petOk !== null) condLines.push(`- ペット: ${petOk ? "可" : "不可"}`);
    if (preferences) condLines.push(`- こだわり: ${preferences}`);
    if (ngPoints) condLines.push(`- NGポイント: ${ngPoints}`);
    if (additionalCond) condLines.push(`- 追加条件: ${additionalCond}`);

    const propListText = properties
      .map((p, i) => {
        const parts: string[] = [
          `${i + 1}. 【${p.building_name}${p.room_number ? ` ${p.room_number}` : ""}】`,
        ];
        if (p.rent !== null)
          parts.push(
            `  賃料: ${formatRent(p.rent)}${p.management_fee ? `（管理費 ${formatRent(p.management_fee)}）` : ""}`
          );
        if (p.floor_plan) parts.push(`  間取り: ${p.floor_plan}`);
        if (p.area) parts.push(`  面積: ${p.area}㎡`);
        if (p.building_age != null) parts.push(`  築年数: 築${p.building_age}年`);
        if (p.station_info) parts.push(`  アクセス: ${p.station_info}`);
        if (p.address) parts.push(`  住所: ${p.address}`);
        if (p.available_date) parts.push(`  入居可能日: ${p.available_date}`);
        return parts.join("\n");
      })
      .join("\n\n");

    const prompt = `お客さんの条件:
${condLines.length > 0 ? condLines.join("\n") : "（条件情報なし）"}

以下の物件をお客さんの条件に照らし合わせて厳密に評価してください。

【スコア基準（1〜10点）】
- 9〜10点: 条件を完全に満たし、積極的にオススメできる最高の選択肢
- 7〜8点: ほぼ条件通り、一部要確認があるが良い選択肢
- 4〜6点: 条件と一部不一致（間取り・家賃・徒歩時間のいずれかが外れる）
- 1〜3点: 条件と大きく外れ、お客さんには合わない

【厳格な減点ルール】
- 賃料上限を超える → 大幅減点（条件外のため推薦不可レベル）
- 間取りが希望と異なる → 4点以下
- 徒歩時間が希望を大きく超える（+5分以上）→ 2点減点
- 築年数が希望より大幅に古い（+10年以上）→ 2点減点
- NGポイントに該当する要素がある → 大幅減点
- ペット条件が合わない → 大幅減点

【コメント】30文字以内で具体的に（例:「家賃・間取り完全一致」「家賃が予算内で広い」「築古だが設備良好」「間取りが条件外」「賃料が上限超過」）

物件一覧:
${propListText}

必ずJSON形式のみで返してください（マークダウン・説明文は一切不要）:
{
  "scored": [{"building_name": "建物名", "room": "部屋番号（なければ空文字）", "score": 8, "comment": "具体的なコメント"}],
  "best": {"building_name": "建物名", "room": "部屋番号（なければ空文字）", "reason": "なぜ最優秀か（50文字以内）"}
}`;

    // ─── 4. Claude Sonnet で比較 ─────────────────────────────────────────────
    // 修正8: max_tokens 2048→8000。Sonnet 5 は適応思考がデフォルトONで、
    // max_tokens は思考+本文の合計上限のため、2048だとJSONが途中切断されるリスクがある
    const aiRes = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
    });

    const stopReason = aiRes.stop_reason;
    if (stopReason === "max_tokens") {
      console.error("[compare-properties] AI応答が max_tokens で途中切断されました");
    }

    const rawText =
      aiRes.content.find(
        (b): b is typeof b & { type: "text"; text: string } => b.type === "text"
      )?.text ?? "";

    // 修正8: AIパース失敗を「scored:[] の静かな成功」ではなく明示的なエラーとして返す
    let aiData: AIResult | null = null;
    try {
      // コードブロックや前置き文を取り除いてJSONだけ抽出
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        aiData = JSON.parse(jsonMatch[0]) as AIResult;
      }
    } catch (e) {
      console.error("[compare-properties] AI JSON parse error:", e, "\nraw:", rawText.slice(0, 500));
    }

    if (!aiData || !Array.isArray(aiData.scored)) {
      return NextResponse.json(
        {
          ok: false,
          error: "ai_parse_failed",
          stop_reason: stopReason,
          raw_head: rawText.slice(0, 300),
        },
        { status: 502 }
      );
    }

    const scored = aiData.scored;
    const best = aiData.best ?? null;

    // ─── 5. LINE グループへ送信 ──────────────────────────────────────────────
    // 修正8: pushToLine の成否を lineSent に反映（従来は失敗しても true）
    let lineSent = false;
    if (TOKEN && scored.length > 0) {
      const groupId = await getGroupId(body.lineGroupId);
      if (groupId) {
        const siteLabel = body.site === "itandi" ? "itandi" : body.site === "realpro" ? "リアプロ" : undefined;
        const lineMsg = buildLineMessage(customerName, properties, scored, best, siteLabel);
        lineSent = await pushToLine(groupId, lineMsg);
      } else {
        console.warn("[compare-properties] LINE group_id 未設定のためスキップ");
      }
    } else if (!TOKEN) {
      console.warn("[compare-properties] LINE トークン未設定のためスキップ");
    }

    return NextResponse.json({
      ok: true,
      scored,
      best,
      customer_name: customerName,
      lineSent,
      stop_reason: stopReason,
    });
  } catch (e) {
    console.error("[compare-properties]", e);
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
