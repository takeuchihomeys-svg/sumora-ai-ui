// 物件選定の学習データ（property_selection_patterns）を蓄積する。
//
// 正解ラベルは「スタッフが顧客条件を見て選び、物件オススメとして送った」事実そのもの（selection_label='selected'）。
// 同時の候補プールにあって選ばれなかった物件が負例（'not_selected'）。
// 顧客反応（customer_reaction）は正誤ではなく補助シグナル: 送った時点では pending、反応評価後に同期する。
//
// 反応評価（72h 待ち・申込中除外）とは独立して毎回実行する。旧実装は反応評価のバッチに相乗りしていたため、
// 機能追加前の送信・申込に進んだ会話への送信（最良の正例）が学習から漏れていた。
import { supabase } from "@/app/lib/supabase";
import { extractRecommendationReason, deriveCustomerProfileTags } from "@/app/lib/knowledge-utils";

// ── セリングポイント抽出（オススメ文 → タグ配列）。LLM不要の正規表現 ──
const SELLING_POINT_TAGS: Array<{ re: RegExp; tag: string }> = [
  { re: /敷金礼金なし|敷礼0|敷礼ゼロ|敷金・礼金なし|敷礼無し|初期費用.*抑え/, tag: "敷礼0円" },
  { re: /新築/,                                                                   tag: "新築" },
  { re: /築浅|年築|築\d{4}年/,                                                    tag: "築浅" },
  { re: /ペット可|ペット相談/,                                                     tag: "ペット可" },
  { re: /インターネット無料|WiFi無料|Wi-Fi無料|ネット無料|光回線/,                 tag: "ネット無料" },
  { re: /駐車場/,                                                                  tag: "駐車場" },
  { re: /オートロック/,                                                            tag: "オートロック" },
  { re: /宅配ボックス/,                                                            tag: "宅配ボックス" },
  { re: /バス.*トイレ.*別|バストイレ別|風呂.*トイレ.*別/,                          tag: "バストイレ別" },
  { re: /エアコン/,                                                                tag: "エアコン付" },
  { re: /管理費.*込|管理費なし/,                                                   tag: "管理費込" },
  { re: /角部屋/,                                                                  tag: "角部屋" },
  { re: /南向き|陽当り|日当た/,                                                    tag: "日当たり良好" },
  { re: /モニター.*インターホン|テレビ.*インターホン|カメラ付/,                    tag: "モニター付インターホン" },
  { re: /退去.*予定|解約.*予定/,                                                   tag: "退去予定あり" },
  { re: /広々|ゆとり|広め/,                                                        tag: "広い間取り" },
];

export function extractSellingPoints(text: string): string[] {
  if (!text) return [];
  const sectionMatch = text.match(/（オススメポイント）([\s\S]*?)(?:\n\n[^・]|$)/);
  const section = sectionMatch ? sectionMatch[1] : text;
  const tagSet = new Set<string>();
  for (const { re, tag } of SELLING_POINT_TAGS) {
    if (re.test(section)) tagSet.add(tag);
  }
  return [...tagSet];
}

// 1回の実行で新規に取り込む送信数（推薦理由の LLM 抽出を含むため上限を設ける。バックログは日次で消化）
const NEW_PER_RUN = 60;
// 未学習の送信を探す走査範囲（古い順）
const SCAN_LIMIT = 2000;
const IN_CHUNK = 200;
const REASON_CONCURRENCY = 10;

export type PropertySelectionResult = {
  selected_inserted: number;
  not_selected_inserted: number;
  reaction_synced: number;
  backlog_remaining: number;
  skipped_unlinked: number;
};

type Reaction = "interested" | "no_response" | "pending";
const reactionOf = (v: boolean | null | undefined): Reaction =>
  v === true ? "interested" : v === false ? "no_response" : "pending";

async function selectIn<T>(table: string, cols: string, col: string, ids: string[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data } = await supabase.from(table).select(cols).in(col, ids.slice(i, i + IN_CHUNK));
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

export async function accumulatePropertySelections(): Promise<PropertySelectionResult> {
  const result: PropertySelectionResult = {
    selected_inserted: 0, not_selected_inserted: 0, reaction_synced: 0, backlog_remaining: 0, skipped_unlinked: 0,
  };

  // ── 1. 未学習の物件オススメ送信（古い順）。スタッフ選定＝正解なので顧客反応・会話ステータスでは除外しない ──
  const { data: recLogs, error: recErr } = await supabase
    .from("aix_usage_logs")
    .select("id, conversation_id, generated_text, created_at, customer_reacted")
    .eq("aix_type", "property_recommendation")
    .order("created_at", { ascending: true })
    .limit(SCAN_LIMIT);
  if (recErr) throw new Error(`aix_usage_logs: ${recErr.message}`);
  const logs = (recLogs ?? []) as Array<{
    id: string; conversation_id: string | null; generated_text: string | null; created_at: string; customer_reacted: boolean | null;
  }>;

  const learned = new Set(
    (await selectIn<{ aix_usage_log_id: string }>("property_selection_patterns", "aix_usage_log_id", "aix_usage_log_id", logs.map((l) => l.id)))
      .map((r) => r.aix_usage_log_id),
  );
  const unlearned = logs.filter((l) => !learned.has(l.id) && l.conversation_id);

  // 物件顧客に紐付かない会話は条件が無く学習できない。スライス前に除外しないと毎回枠を占有して飢餓する
  const convRows = await selectIn<{ id: string; property_customer_id: string | null; suggested_aix_meta: Record<string, unknown> | null }>(
    "conversations", "id, property_customer_id, suggested_aix_meta", "id",
    [...new Set(unlearned.map((l) => l.conversation_id as string))],
  );
  const convToPc = new Map<string, string>();
  const convToMeta = new Map<string, Record<string, unknown> | null>();
  for (const c of convRows) {
    if (c.property_customer_id) convToPc.set(c.id, c.property_customer_id);
    convToMeta.set(c.id, c.suggested_aix_meta ?? null);
  }
  const eligible = unlearned.filter((l) => convToPc.has(l.conversation_id as string));
  result.skipped_unlinked = unlearned.length - eligible.length;
  const batch = eligible.slice(0, NEW_PER_RUN);
  result.backlog_remaining = eligible.length - batch.length;

  if (batch.length > 0) {
    const pcRows = await selectIn<Record<string, unknown>>(
      "property_customers", "id, rent_max, max_rent, floor_plan, layout, walk_minutes, desired_area, area, preferences", "id",
      [...new Set(batch.map((l) => convToPc.get(l.conversation_id as string) as string))],
    );
    const pcMap = new Map(pcRows.map((pc) => [pc.id as string, pc]));
    const customerCols = (pc: Record<string, unknown> | undefined) => ({
      customer_rent_max:     pc ? ((pc.rent_max as number | null) ?? (pc.max_rent as number | null) ?? null) : null,
      customer_floor_plan:   pc ? ((pc.floor_plan as string | null) ?? (pc.layout as string | null) ?? null) : null,
      customer_walk_minutes: pc ? ((pc.walk_minutes as number | null) ?? null) : null,
      customer_area:         pc ? ((pc.desired_area as string | null) ?? (pc.area as string | null) ?? null) : null,
      customer_preferences:  pc ? ((pc.preferences as string | null) ?? null) : null,
    });

    // 推薦理由（LLM）を並列抽出
    const reasonMap = new Map<string, string | null>();
    for (let i = 0; i < batch.length; i += REASON_CONCURRENCY) {
      await Promise.all(batch.slice(i, i + REASON_CONCURRENCY).map(async (l) => {
        const reason = l.generated_text ? await extractRecommendationReason(l.generated_text).catch(() => null) : null;
        reasonMap.set(l.id, reason);
      }));
    }

    // ── 1a. 正例: スタッフが選んで送った物件 ──
    const selectedRows = batch.map((l) => {
      const pcId = convToPc.get(l.conversation_id as string) as string;
      const pc = pcMap.get(pcId);
      const meta = convToMeta.get(l.conversation_id as string) as { closing_strategy?: string | null; key_topics?: string[] | null; preferences?: string | null } | null;
      const profileTags = deriveCustomerProfileTags(meta, (pc?.preferences as string | null) ?? null);
      return {
        property_customer_id:  pcId,
        conversation_id:       l.conversation_id,
        aix_usage_log_id:      l.id,
        ...customerCols(pc),
        selling_points:        extractSellingPoints(l.generated_text ?? ""),
        selection_label:       "selected",
        customer_reaction:     reactionOf(l.customer_reacted),
        recommendation_reason: reasonMap.get(l.id) ?? null,
        customer_profile_tags: profileTags.length > 0 ? profileTags : null,
      };
    });
    const { data: ins, error: insErr } = await supabase
      .from("property_selection_patterns")
      .upsert(selectedRows, { onConflict: "aix_usage_log_id", ignoreDuplicates: true })
      .select("id");
    if (insErr) console.warn("[property-selection] selected insert失敗:", insErr.message);
    else result.selected_inserted = ins?.length ?? 0;

    // ── 1b. 負例: 同時（±24h）の候補プールにあって選ばれなかった物件 ──
    const convIds = [...new Set(batch.map((l) => l.conversation_id as string))];
    const pcIds = [...new Set(convIds.map((c) => convToPc.get(c) as string))];
    const [genLogRows, poolRows, doneRows] = await Promise.all([
      selectIn<{ conversation_id: string; action_type: string; property_details: { name?: string | null } | null }>(
        "aix_generate_log", "conversation_id, action_type, property_details", "conversation_id", convIds),
      selectIn<{ property_customer_id: string; candidates: unknown; sent_at: string }>(
        "property_candidate_pools", "property_customer_id, candidates, sent_at", "property_customer_id", pcIds),
      selectIn<{ conversation_id: string; selection_label: string }>(
        "property_selection_patterns", "conversation_id, selection_label", "conversation_id", convIds),
    ]);
    const extractedName = new Map<string, string>();
    for (const g of genLogRows) {
      if (g.action_type !== "property_recommendation" || !g.property_details?.name) continue;
      if (!extractedName.has(g.conversation_id)) extractedName.set(g.conversation_id, g.property_details.name.toLowerCase());
    }
    const contrastDone = new Set(doneRows.filter((r) => r.selection_label === "not_selected").map((r) => r.conversation_id));

    const negRows: Array<Record<string, unknown>> = [];
    for (const l of batch) {
      const convId = l.conversation_id as string;
      if (contrastDone.has(convId)) continue;
      contrastDone.add(convId); // 同じ会話の候補を二重に積まない
      const pcId = convToPc.get(convId) as string;
      const sendTime = new Date(l.created_at).getTime();
      const pool = poolRows
        .filter((p) => p.property_customer_id === pcId && Math.abs(new Date(p.sent_at).getTime() - sendTime) <= 24 * 3600 * 1000)
        .sort((a, b) => Math.abs(new Date(a.sent_at).getTime() - sendTime) - Math.abs(new Date(b.sent_at).getTime() - sendTime))[0];
      if (!pool) continue;
      const candidates = (pool.candidates as Array<{ name?: string; floor_plan?: string; walk_minutes?: number; ad_months?: number }>) ?? [];
      const picked = extractedName.get(convId) ?? null;
      const textLower = (l.generated_text ?? "").toLowerCase();
      for (const c of candidates) {
        const name = (c.name ?? "").trim().toLowerCase();
        if (!name) continue;
        const wasSelected = picked ? picked.includes(name) || name.includes(picked) : textLower.includes(name);
        if (wasSelected) continue;
        const features: string[] = [];
        if ((c.ad_months ?? 0) >= 2) features.push("広告料2ヶ月以上");
        else if ((c.ad_months ?? 0) >= 1) features.push("広告料1ヶ月");
        if (c.walk_minutes != null && c.walk_minutes <= 5) features.push("駅5分以内");
        else if (c.walk_minutes != null && c.walk_minutes <= 10) features.push("駅10分以内");
        if (c.floor_plan) features.push(c.floor_plan);
        if (features.length === 0) continue;
        negRows.push({
          property_customer_id: pcId,
          conversation_id:      convId,
          aix_usage_log_id:     null,
          ...customerCols(pcMap.get(pcId)),
          selling_points:       features,
          selection_label:      "not_selected",
          customer_reaction:    null, // 送っていない物件に顧客反応は存在しない
        });
      }
    }
    if (negRows.length > 0) {
      const { data: negIns, error: negErr } = await supabase.from("property_selection_patterns").insert(negRows).select("id");
      if (negErr) console.warn("[property-selection] not_selected insert失敗:", negErr.message);
      else result.not_selected_inserted = negIns?.length ?? 0;
    }
  }

  // ── 2. 顧客反応の同期（補助シグナル）: pending の正例を反応評価済みの値で更新 ──
  const { data: pend } = await supabase
    .from("property_selection_patterns")
    .select("id, aix_usage_log_id")
    .eq("customer_reaction", "pending")
    .not("aix_usage_log_id", "is", null)
    .limit(1000);
  const pendRows = (pend ?? []) as Array<{ id: string; aix_usage_log_id: string }>;
  if (pendRows.length > 0) {
    const reacted = new Map(
      (await selectIn<{ id: string; customer_reacted: boolean | null }>("aix_usage_logs", "id, customer_reacted", "id", pendRows.map((r) => r.aix_usage_log_id)))
        .map((r) => [r.id, r.customer_reacted]),
    );
    for (const react of ["interested", "no_response"] as const) {
      const ids = pendRows.filter((r) => reactionOf(reacted.get(r.aix_usage_log_id)) === react).map((r) => r.id);
      for (let i = 0; i < ids.length; i += IN_CHUNK) {
        const { error } = await supabase.from("property_selection_patterns").update({ customer_reaction: react }).in("id", ids.slice(i, i + IN_CHUNK));
        if (!error) result.reaction_synced += Math.min(IN_CHUNK, ids.length - i);
      }
    }
  }

  return result;
}
