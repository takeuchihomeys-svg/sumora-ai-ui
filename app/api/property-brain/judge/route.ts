// app/api/property-brain/judge/route.ts
// 物件検索ブレイン: 拡張（ブレインモード）から物件の配列＋顧客IDを受け、条件・過去の物件出しの傾向・利益で判定して返す。
//
// 2026-09-23 竹内「Deepsheekで物件検索のブレインをつくる…物件検索の拡張ツールでもブレインモードつくる」
//
// ■ 流れ
//   1. お客様の条件（property_customers）・過去にスタッフが送った物件（sent_properties・180日）・
//      選定パターン（property_selection_patterns・selected）・見積書の割引額（aix_usage_logs estimate_sheet の本文）を引く
//   2. 純関数（app/lib/property-brain.ts）で1件ずつ pass / hold / drop
//   3. お客様の希望に画像でしか分からない語（バストイレ別・独立洗面・収納・南向き・2階以上）があり、
//      物件に image_url が付いている時だけ DeepSeek で有無を読む（5枚まで・失敗は判定を変えない）
//   4. 判定を property_brain_judgments に残す（後で「外す候補をスタッフが実際に送ったか」＝誤削除を数える材料）
//
// ■ 落とすかどうか（apply_drop）
//   既定は**影の運用**（PROPERTY_BRAIN_DROP 未設定）: 判定と印だけ返し、拡張は全件送る。
//   PROPERTY_BRAIN_DROP=on で drop を実際に外す（影の運用で誤削除0の線が取れてから）。
//   staff_mode=true の時は必ず apply_drop=false（人が選んだ物は減らさない）。
//
// ■ fail-open
//   ここが落ちても拡張は今までどおり全件送る（拡張側で 30秒タイムアウト・エラーは全件送付）。

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import {
  buildCustomerProfile, parsePropertyFacts, judgeProperty, applyImageFacts, parseDiscountYen,
  formatBrainNoteLine, countVerdicts,
  type Judgment, type PropertyDataLike, type CustomerLike, type SentRowLike, type PatternRowLike,
} from "@/app/lib/property-brain";
import { readFloorPlanFacts, PROPERTY_BRAIN_IMAGE_MAX_PER_BATCH } from "@/app/lib/property-brain-image";
import { parseEquipmentWants } from "@/app/lib/listing-equipment";
import { matchFromSummary } from "@/app/lib/pickup-equipment";
// 2026-09-24 竹内「AD − 見積書の割引金額が利益。連動する」: 見積書の記録（estimate_records）から割引・利益の中央値
import { loadCustomerProfit } from "@/app/lib/estimate-profit-server";

export const maxDuration = 30;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

type ItemIn = { summary?: string | null; data?: PropertyDataLike | null; url?: string | null; image_url?: string | null };
type Body = {
  property_customer_id?: string | null;
  conversation_id?: string | null;
  items?: ItemIn[];
  site?: string | null;
  staff_mode?: boolean | null;
  /** true なら記録も画像の読み取りもしない（監査・実機確認用） */
  dry_run?: boolean | null;
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/** 画像の読み取りは一度に全部やらず、上限枚数・全体の時間で切る */
const IMAGE_PHASE_BUDGET_MS = 12_000;

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  let body: Body;
  try { body = (await req.json()) as Body; } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400, headers: CORS });
  }
  const items = Array.isArray(body.items) ? body.items.filter((it) => it && typeof it.summary === "string" && it.summary.trim()) : [];
  if (items.length === 0) {
    return NextResponse.json({ ok: false, error: "items required" }, { status: 400, headers: CORS });
  }
  if (items.length > 60) items.length = 60;

  try {
    // ── 誰の判定か ──
    let customerId: string | null = body.property_customer_id ?? null;
    if (!customerId && body.conversation_id) {
      const { data: conv } = await supabase.from("conversations").select("property_customer_id").eq("id", body.conversation_id).maybeSingle();
      customerId = (conv as { property_customer_id?: string | null } | null)?.property_customer_id ?? null;
    }
    if (!customerId) {
      return NextResponse.json({ ok: false, error: "property_customer_id required" }, { status: 400, headers: CORS });
    }

    // ── 材料を並列で引く ──
    const since = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString();
    const [custRes, sentRes, patRes, convsRes] = await Promise.all([
      supabase.from("property_customers")
        .select("rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet")
        .eq("id", customerId).maybeSingle(),
      supabase.from("sent_properties").select("property_name, rent, delivery, source").eq("property_customer_id", customerId).gte("sent_at", since).limit(500),
      supabase.from("property_selection_patterns").select("selling_points, selection_label").eq("property_customer_id", customerId).order("created_at", { ascending: false }).limit(60),
      supabase.from("conversations").select("id").eq("property_customer_id", customerId).limit(10),
    ]);
    const customer = custRes.data as CustomerLike | null;
    if (!customer) {
      return NextResponse.json({ ok: false, error: "customer not found" }, { status: 404, headers: CORS });
    }

    // 見積書の割引額。2026-09-24 竹内「AD − 見積書の割引金額が利益…連動する」:
    //   ① estimate_records（見積書を物件ごとに残した記録・AD と結び付き済み）の中央値を最優先
    //   ② 無ければ AIX【見積書送る】本文・最新3通の最初に読めた物（旧）
    let discountYen: number | null = null;
    let discountSource = "default";
    const convIds = ((convsRes.data ?? []) as Array<{ id: string }>).map((c) => c.id);
    const profit = await loadCustomerProfit({ propertyCustomerId: customerId, conversationIds: convIds });
    if (profit.discountMedianYen != null) { discountYen = profit.discountMedianYen; discountSource = "estimate_records"; }
    if (discountYen == null && convIds.length > 0) {
      const { data: est } = await supabase.from("aix_usage_logs").select("generated_text")
        .in("conversation_id", convIds).eq("aix_type", "estimate_sheet").order("created_at", { ascending: false }).limit(3);
      for (const r of (est ?? []) as Array<{ generated_text?: string | null }>) {
        const v = parseDiscountYen(r.generated_text);
        if (v != null) { discountYen = v; discountSource = "estimate_sheet_text"; break; }
      }
    }

    const profile = buildCustomerProfile(customer, (sentRes.data ?? []) as SentRowLike[], (patRes.data ?? []) as PatternRowLike[], discountYen);

    // ── 決定論の判定 ──
    // 2026-09-24 竹内「設備面も見るように」「202号室なら2階」: ここ（拡張の判定）は PDF が無いので、説明文から読めた分だけ
    //   （号室から推した階・説明文に書いてある設備）で売上サポと同じ EQUIP_* を付ける。記載なし（要確認）はここでは付けない
    const equipWants = parseEquipmentWants(customer);
    let judgments: Judgment[] = items.map((it, i) => judgeProperty(parsePropertyFacts(it.summary, it.data ?? null), profile, i, { equipment: matchFromSummary(it.summary, equipWants) }));

    // ── 画像でしか分からない有無（要る時だけ・5枚まで・時間で切る） ──
    let imageRead = 0, imageOk = 0;
    if (!body.dry_run && profile.imageWants.length > 0 && (process.env.DEEPSEEK_API_KEY ?? "").trim()) {
      const targets = judgments
        .map((j, i) => ({ j, i, url: items[i].image_url ?? null }))
        .filter((t) => t.j.verdict !== "drop" && t.url && /^https?:\/\//.test(t.url))
        .slice(0, PROPERTY_BRAIN_IMAGE_MAX_PER_BATCH);
      if (targets.length > 0) {
        const left = Math.max(2_000, IMAGE_PHASE_BUDGET_MS - (Date.now() - startedAt));
        const results = await Promise.allSettled(targets.map((t) => readFloorPlanFacts(t.url as string, t.j.imageChecks, { timeoutMs: Math.min(left, 8_000) })));
        results.forEach((r, k) => {
          imageRead++;
          if (r.status === "fulfilled" && r.value.facts) {
            imageOk++;
            const t = targets[k];
            judgments[t.i] = applyImageFacts(t.j, r.value.facts);
          }
        });
      }
    }

    const applyDrop = process.env.PROPERTY_BRAIN_DROP === "on" && body.staff_mode !== true;
    const counts = countVerdicts(judgments);
    const noteLine = formatBrainNoteLine(judgments, applyDrop);

    const out = judgments.map((j) => ({
      index: j.index, rank: j.rank, name: j.name, verdict: j.verdict, score: j.score,
      reason_codes: j.reasonCodes, reasons_ja: j.reasonsJa, confidence: j.confidence, missing: j.missing,
      ad_yen: j.adYen, profit_yen: j.profitYen,
    }));

    const profileSummary = {
      rent_max: profile.rentMax, notes: profile.notes, floor_plan_want: profile.floorPlanWant.raw,
      walk_max: profile.walkMax, building_age_max: profile.buildingAgeMax,
      wants_low_initial_cost: profile.wantsLowInitialCost, low_initial_cost_source: profile.lowInitialCostSource,
      image_wants: profile.imageWants, sent_count: profile.history.sentCount,
      rent_ratio_median: profile.history.rentRatioMedian, discount_yen: profile.discountYen, discount_source: discountSource,
      // 見積書の記録（このお客様）: 件数・AD と結び付いた件数・利益の中央値・利益が出ていない件数
      estimate_records: profit.n > 0 ? { n: profit.n, linked: profit.linked, ad_yen_median: profit.adYenMedian, profit_median_yen: profit.profitMedianYen, negative: profit.negative } : null,
      confidence: profile.confidence,
    };

    // ── 記録（影の運用の材料。失敗しても返す） ──
    console.log(JSON.stringify({
      tag: "property-brain:judge", customer: customerId.slice(0, 8), site: body.site ?? null, n: items.length,
      ...counts, apply_drop: applyDrop, image_read: imageRead, image_ok: imageOk, ms: Date.now() - startedAt,
      items: out.map((o) => ({ r: o.rank, v: o.verdict, s: o.score, c: o.reason_codes.filter((c) => !/_OK$|_UNKNOWN$/.test(c)) })),
    }));
    if (!body.dry_run) {
      const batchKey = `${customerId.slice(0, 8)}:${new Date(startedAt).toISOString().slice(0, 16)}`;
      const rows = judgments.map((j, i) => ({
        property_customer_id: customerId, site: body.site ?? null, batch_key: batchKey, rank: j.rank,
        property_name: j.name, property_url: items[i].url ?? null, verdict: j.verdict, score: j.score,
        reason_codes: j.reasonCodes, facts: { ...j.facts, rawText: undefined }, summary_text: items[i].summary,
        profile_snapshot: profileSummary, ad_yen: j.adYen, profit_yen: j.profitYen,
        apply_drop: applyDrop, staff_mode: body.staff_mode === true, image_used: j.reasonCodes.some((c) => c.startsWith("IMAGE_")),
      }));
      supabase.from("property_brain_judgments").insert(rows).then(({ error }) => {
        if (error) console.warn("[property-brain] judgments insert failed:", error.message);
      });
    }

    return NextResponse.json({
      ok: true, apply_drop: applyDrop, counts, judgments: out, note_line: noteLine,
      profile_summary: profileSummary, image: { read: imageRead, ok: imageOk }, ms: Date.now() - startedAt,
    }, { headers: CORS });
  } catch (e) {
    console.error(JSON.stringify({ tag: "property-brain:judge-failed", error: e instanceof Error ? e.message : String(e) }));
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500, headers: CORS });
  }
}
