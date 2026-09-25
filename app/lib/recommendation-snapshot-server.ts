// app/lib/recommendation-snapshot-server.ts
// 🌟（AIX 物件オススメ）を送った時点の「候補一覧」を記録する（サーバー専用・DB を読む。画面から import しない）。
//
// 2026-09-25 竹内「候補の記憶を太くする。会話を見たりオススメしている部分を見ればギャップが分かる」
//   🌟は「物件の画像を何枚か送った後に、その中から1件を押す」流れが中心なのに、その時の候補一覧が残っていなかった。
//   ここで、同じ会話でお客様に直近に送った物件（sent_properties・お客様に届いた行だけ）を候補として、🌟の物件と一緒に
//   recommendation_snapshots に1行残す。候補の値は ①送付記録 ②送った画像1枚ごとの読み取り（sent_image_properties.facts）
//   ③同じお客様の拡張の回（property_candidate_pools）④売上サポの行（property_pickups・資料の文字層）の順に、
//   空いている項目だけ埋める（candidate-facts.fillMissing）。建物名の照合は2文字組の近さ 0.75 以上で一番近い物（bestBuildingMatch）。
//
// ■ 決めたこと
//   ・送信の本文・お客様に届く物は一切変えない。記録の失敗で送信を止めない（呼び出し側は waitUntil の中で握る）。
//   ・🌟の本文から読んだ値（star_text_facts）は候補の値に混ぜない。混ぜると🌟だけ材料が多くなり、
//     「ブレインの点で🌟が何位か」が🌟に有利に歪む（監査で比べる時は同じ出どころの値だけで点を付ける）。
//   ・お客様の発言そのものは写さない（希望の話題 customer_wants だけ残す＝個人情報を別の表に増やさない）。
//   ・同じ AIX の記録（aix_usage_log_id）・同じメッセージ（message_id）で2行目を作らない（一意の索引）。

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  enrichCandidate, fillMissing, parseFactsFromText, sameBuildingName, bestBuildingMatch, nameKey, deriveFacts, toHalf, FACTS_VERSION,
  type CandidateFacts, type ParsedFacts,
} from "./candidate-facts";
import { starHeadOf, appealTopics, customerWants, type WantHit, type TopicKey } from "./recommendation-gaps";
import { isGenericBuildingName } from "./generic-building-name";
import { isCustomerRow } from "./sent-delivery";
import { parseListingTerms } from "./listing-terms";
import { parseListingEquipment } from "./listing-equipment";

type Row = Record<string, unknown>;
const H = 3600_000, D = 24 * H;

/** 送付の窓: 🌟の 72時間前〜送信の3分後（同じ時刻の送付記録＝🌟自身の行も拾う） */
export const SENT_WINDOW_MS = 72 * H;
/** 候補の値を探す窓（拡張の回・売上サポの行）: 🌟の14日前まで */
export const FACTS_WINDOW_MS = 14 * D;

// 資料の設備（listing-equipment の鍵）→ candidate-facts の設備の語
const EQUIP_KEY_LABEL: Record<string, string> = {
  elevator: "エレベーター", delivery_box: "宅配ボックス", autolock: "オートロック", net_free: "ネット無料", parking: "駐車場",
  bath_toilet: "バス・トイレ別", washbasin: "独立洗面台", laundry_in: "室内洗濯機置場", corner: "角部屋", pet: "ペット相談",
  south: "南向き", aircon: "エアコン", system_kitchen: "システムキッチン", counter_kitchen: "対面キッチン", reheating: "追い焚き",
  bath_dryer: "浴室乾燥機", washlet: "温水洗浄便座", walk_in_closet: "ウォークインクローゼット", burner2: "2口コンロ",
  flooring: "フローリング", bike_parking: "駐輪場", garbage24: "24時間ゴミ出し", monitor_intercom: "モニター付インターホン", top_floor: "最上階",
};

/** 売上サポの行（説明文・資料の文字層・🌟の順位）→ 候補の値 */
export function factsFromPickup(p: Row, now: Date | string = new Date()): ParsedFacts & { star?: "🌟" | "🌟★" | null; pdf_url?: string | null } {
  const out: ParsedFacts & { star?: "🌟" | "🌟★" | null; pdf_url?: string | null } = {};
  const summary = String(p.summary_text ?? "");
  Object.assign(out, parseFactsFromText(summary));
  const pdf = String(p.pdf_text ?? "");
  if (pdf.trim()) {
    const fromPdf = parseFactsFromText(pdf);
    for (const [k, v] of Object.entries(fromPdf)) if ((out as Row)[k] == null && v != null) (out as Row)[k] = v;
    try {
      const t = parseListingTerms(pdf, { today: now });
      if (t.hasText) {
        if (t.depositMonths != null) out.deposit_months = t.depositMonths;
        if (t.keyMoneyMonths != null) out.key_money_months = t.keyMoneyMonths;
        if (t.depositYen != null) out.deposit_yen = t.depositYen;
        if (t.keyMoneyYen != null) out.key_money_yen = t.keyMoneyYen;
        if (t.builtYear != null) out.built_ym = t.builtMonth ? `${t.builtYear}-${String(t.builtMonth).padStart(2, "0")}` : String(t.builtYear);
        if (t.buildingAgeYears != null) out.building_age = t.buildingAgeYears;
        if (out.area_sqm == null && t.areaSqm != null) out.area_sqm = t.areaSqm;
        if (out.admin_fee_yen == null && t.adminFeeYen != null) out.admin_fee_yen = t.adminFeeYen;
      }
    } catch { /* 読めない資料は飛ばす */ }
    try {
      const e = parseListingEquipment(pdf);
      if (e.hasText) {
        const ok = Object.entries(e.items ?? {}).filter(([, f]) => f?.status === "ok").map(([k]) => EQUIP_KEY_LABEL[k]).filter(Boolean);
        if (ok.length) out.equipment = [...new Set([...(out.equipment ?? []), ...ok])];
        if (e.floor != null) out.floor = e.floor;
        if (e.totalFloors != null) out.total_floors = e.totalFloors;
      }
    } catch { /* 同上 */ }
  }
  if (p.room_no) out.room_no = String(p.room_no);
  const first = summary.split("\n")[0] ?? "";
  out.star = /🌟★/u.test(first) ? "🌟★" : (Number(p.recommended ?? 0) > 0 || /🌟/u.test(first)) ? "🌟" : null;
  out.pdf_url = (p.pdf_blob_url as string) || (p.pdf_url as string) || null;
  return out;
}

const roomEq = (a: unknown, b: unknown) => {
  const x = toHalf(String(a ?? "")).replace(/号室?$/, "").replace(/^0+(?=\d)/, "").trim();
  const y = toHalf(String(b ?? "")).replace(/号室?$/, "").replace(/^0+(?=\d)/, "").trim();
  return !!x && !!y && x === y;
};
/** 一覧の中で一番近い同じ建物（号室が両方分かる時は号室も同じ物）。線は candidate-facts の 0.75 */
function pick<T extends Row>(name: string, room: string | null, list: T[], nameKey0: string, roomKey0: string): T | null {
  return bestBuildingMatch(name, room, list, (x) => x[nameKey0], (x) => x[roomKey0]);
}
const candsOf = (pool: Row): Row[] => {
  const c = pool.candidates;
  const arr = typeof c === "string" ? (() => { try { return JSON.parse(c); } catch { return []; } })() : c;
  return Array.isArray(arr) ? (arr as Row[]) : [];
};

export type SnapshotCandidate = CandidateFacts & {
  is_star: boolean;
  sent_at?: string | null;
  channel?: string | null;
  source?: string | null;
  pool_id?: string | null;
  pickup_id?: number | null;
};

export type SnapshotRow = {
  aix_usage_log_id: string | null;
  message_id: string | null;
  conversation_id: string;
  property_customer_id: string | null;
  sent_at: string;
  star_name: string | null;
  star_room: string | null;
  star_text: string;
  star_in_candidates: boolean;
  candidate_count: number;
  candidates: SnapshotCandidate[];
  star_text_facts: ParsedFacts;
  appeal_topics: TopicKey[];
  customer_wants: WantHit[];
  pool_ids: string[];
  pickup_batch_ids: string[];
  source: "live" | "backfill";
  facts_v: number;
};

/** 物件顧客の条件（希望の話題の材料） */
const COND_COLS = "id, rent_max, max_rent, floor_plan, walk_minutes, building_age, initial_cost_limit, pet, move_in_time, floor_area_min, preferences, ng_points, other_requests, additional_conditions, raw_format_text";

/**
 * 🌟の1回の記録を組み立てる（DB は読むだけ）。live（AIX を送った時）と監査・埋め戻しで同じ関数
 */
export async function buildRecommendationSnapshot(sb: SupabaseClient, input: {
  conversationId: string; sentAt: string; starText: string; aixUsageLogId?: string | null; messageId?: string | null; source?: "live" | "backfill";
}): Promise<SnapshotRow | null> {
  const head = starHeadOf(input.starText);
  if (!head) return null;
  const t = Date.parse(input.sentAt);
  if (!Number.isFinite(t)) return null;
  const { data: conv } = await sb.from("conversations").select("property_customer_id").eq("id", input.conversationId).maybeSingle();
  const pc = ((conv as Row | null)?.property_customer_id as string | null) ?? null;

  // ① 直近にお客様へ送った物件（お客様に届いた行だけ・グループ共有は除く）
  const sentQ = sb.from("sent_properties")
    .select("property_name, room_no, rent, ad_months, ad_yen, source, delivery, channel, sent_at, property_url, pickup_id, image_url")
    .gte("sent_at", new Date(t - SENT_WINDOW_MS).toISOString()).lte("sent_at", new Date(t + 3 * 60_000).toISOString())
    .order("sent_at", { ascending: true }).limit(300);
  const { data: sentRaw } = await (pc ? sentQ.or(`conversation_id.eq.${input.conversationId},property_customer_id.eq.${pc}`) : sentQ.eq("conversation_id", input.conversationId));
  const sent = ((sentRaw ?? []) as Row[]).filter((r) => isCustomerRow(r as { delivery?: string | null; source?: string | null }) && r.property_name && !isGenericBuildingName(String(r.property_name)));

  // ② 候補の値の出どころ（同じお客様の拡張の回・売上サポの行・14日）
  const since = new Date(t - FACTS_WINDOW_MS).toISOString(), until = new Date(t + 60_000).toISOString();
  const pools: Row[] = pc
    ? (((await sb.from("property_candidate_pools").select("id, site, sent_at, candidates").eq("property_customer_id", pc).gte("sent_at", since).lte("sent_at", until).order("sent_at", { ascending: false }).limit(60)).data ?? []) as Row[])
    : [];
  const pickups: Row[] = pc
    ? (((await sb.from("property_pickups").select("id, batch_id, created_at, rank, property_name, room_no, summary_text, pdf_text, pdf_url, pdf_blob_url, recommended").eq("property_customer_id", pc).gte("created_at", since).lte("created_at", until).order("created_at", { ascending: false }).limit(200)).data ?? []) as Row[])
    : [];

  // ③ 送った画像1枚ごとの値（sent_image_properties.facts・2026-09-25〜 readPropertyImage が残す）
  const images: Row[] = (((await sb.from("sent_image_properties").select("image_url, property_name, room_no, facts, created_at").eq("conversation_id", input.conversationId)
    .gte("created_at", new Date(t - SENT_WINDOW_MS).toISOString()).lte("created_at", new Date(t + 3 * 60_000).toISOString()).not("facts", "is", null).limit(300)).data ?? []) as Row[]);

  const usedPools = new Set<string>(), usedBatches = new Set<string>();
  const fill = (c: SnapshotCandidate) => {
    const name = String(c.name ?? ""), room = (c.room_no as string | null) ?? null;
    // 送った画像そのものの値が一番近い（同じ画像 → 同じ建物・号室の画像）
    const img = (c.image_url ? images.find((x) => x.image_url === c.image_url) : null) ?? pick(name, room, images, "property_name", "room_no");
    if (img?.facts && typeof img.facts === "object") {
      const { src: _s, model: _m, read_items: _ri, status: _st, vacancy_date: _vd, ...f } = img.facts as Row;
      fillMissing(c, f as ParsedFacts, "image");
    }
    for (const p of pools) {
      const hit = pick(name, room, candsOf(p), "name", "room_no");
      if (hit) {
        const e = enrichCandidate(hit, { now: input.sentAt });
        const { name: _n, rank: _r, src: _s, facts_v: _v, cells: _c, head: _h, bld_text: _b, row_text: _rt, summary: _su, read_mode: _m, ...rest } = e;
        fillMissing(c, rest as ParsedFacts, "pool");
        c.pool_id = String(p.id);
        if (c.pool_rank == null && typeof hit.rank === "number") c.pool_rank = hit.rank;
        usedPools.add(String(p.id));
        break;
      }
    }
    const pk = pick(name, room, pickups, "property_name", "room_no");
    if (pk) {
      fillMissing(c, factsFromPickup(pk, input.sentAt), "pickup");
      c.pickup_id = Number(pk.id);
      usedBatches.add(String(pk.batch_id));
    }
    deriveFacts(c, input.sentAt);
    c.facts_v = FACTS_VERSION;
  };

  // 同じ物件の2回目（同じ建物＋同じ号室／号室が無い同じ建物）は1件にまとめる
  const cands: SnapshotCandidate[] = [];
  for (const r of sent) {
    const name = String(r.property_name), room = r.room_no ? String(r.room_no) : null;
    const dup = cands.find((c) => nameKey(c.name) === nameKey(name) && (room ? roomEq(c.room_no, room) || !c.room_no : true));
    if (dup) { if (!dup.room_no && room) dup.room_no = room; continue; }
    const c: SnapshotCandidate = { name, room_no: room, is_star: false, sent_at: String(r.sent_at ?? ""), channel: (r.channel as string) ?? null, source: (r.source as string) ?? null, image_url: (r.image_url as string) ?? null, src: {} };
    fillMissing(c, { rent: r.rent as number | null, ad_months: r.ad_months as number | null, ad_yen: r.ad_yen as number | null }, "sent");
    if (r.property_url) c.pdf_url = String(r.property_url);
    cands.push(c);
  }
  // 🌟の物件（号室まで合う物 → 建物だけ合う物）
  let star = pick(head.name, head.room, cands as unknown as Row[], "name", "room_no") as SnapshotCandidate | null ?? undefined;
  const starInCandidates = !!star;
  if (!star) {
    star = { name: head.name, room_no: head.room, is_star: true, sent_at: input.sentAt, channel: "recommendation", source: "star_text", src: {} };
    cands.push(star);
  }
  star.is_star = true;
  if (head.room && !star.room_no) star.room_no = head.room;
  for (const c of cands) fill(c);

  // お客様の希望の話題（条件＋🌟の前14日のお客様の発言）
  let cond: Row | null = null;
  if (pc) cond = ((await sb.from("property_customers").select(COND_COLS).eq("id", pc).maybeSingle()).data ?? null) as Row | null;
  const { data: msgs } = await sb.from("messages").select("text").eq("conversation_id", input.conversationId).eq("sender", "customer")
    .gte("created_at", since).lt("created_at", input.sentAt).order("created_at", { ascending: false }).limit(40);
  const wants = customerWants({ conditions: cond as never, messages: ((msgs ?? []) as Row[]).map((m) => String(m.text ?? "")).filter(Boolean) });

  return {
    aix_usage_log_id: input.aixUsageLogId ?? null,
    message_id: input.messageId ?? null,
    conversation_id: input.conversationId,
    property_customer_id: pc,
    sent_at: new Date(t).toISOString(),
    star_name: head.name,
    star_room: head.room,
    star_text: String(input.starText).slice(0, 2000),
    star_in_candidates: starInCandidates,
    candidate_count: cands.length,
    candidates: cands,
    star_text_facts: starTextFacts(input.starText, input.sentAt),
    appeal_topics: appealTopics(input.starText),
    customer_wants: wants,
    pool_ids: [...usedPools],
    pickup_batch_ids: [...usedBatches],
    source: input.source ?? "live",
    facts_v: FACTS_VERSION,
  };
}

/** 🌟の本文から読んだ値（参考・候補の値には混ぜない）。最寄り・徒歩・築年数も導く */
function starTextFacts(text: string, now: string): ParsedFacts {
  const f = parseFactsFromText(String(text).split("\n").slice(1).join("\n")) as CandidateFacts;
  deriveFacts(f, now);
  delete f.src;
  return f as ParsedFacts;
}

/** AIX 物件オススメを送った時に1行残す（失敗は投げずに理由を返す＝送信を止めない） */
export async function recordRecommendationSnapshot(sb: SupabaseClient, input: {
  conversationId: string; sentAt: string; starText: string; aixUsageLogId: string;
}): Promise<{ ok: boolean; candidates?: number; error?: string }> {
  try {
    const row = await buildRecommendationSnapshot(sb, { ...input, source: "live" });
    if (!row) return { ok: false, error: "not_star_text" };
    const { error } = await sb.from("recommendation_snapshots").insert(row);
    if (error) return { ok: false, error: error.message };
    return { ok: true, candidates: row.candidate_count };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 拡張の回（property_candidate_pools の1行）を、同じお客様・同じ時刻の売上サポの行（merge-pdfs が作る property_pickups）で埋める。
 * 回は拡張が送信を始めた時刻、売上サポの行は merge の後なので、回の 1分前〜20分後の batch のうち一番近い物を使う。
 * 候補は順位（rank）が同じで名前も近い物、無ければ名前＋号室で結ぶ。埋めた件数を返す（書き込みは呼び出し側）
 */
export function fillPoolFromPickups(pool: { sent_at: string; candidates: Row[] }, pickups: Row[]): { candidates: CandidateFacts[]; filled: number; batch: string | null } {
  const t = Date.parse(pool.sent_at);
  const near = pickups.filter((p) => { const d = Date.parse(String(p.created_at)) - t; return d >= -60_000 && d <= 20 * 60_000; });
  const batches = new Map<string, Row[]>();
  for (const p of near) { const k = String(p.batch_id); if (!batches.has(k)) batches.set(k, []); batches.get(k)!.push(p); }
  // 一番多くの候補と名前が合う batch
  let best: string | null = null, bestHit = 0;
  for (const [k, rows] of batches) {
    const hit = pool.candidates.filter((c) => rows.some((p) => sameBuildingName(String(c.name ?? ""), String(p.property_name ?? "")))).length;
    if (hit > bestHit) { bestHit = hit; best = k; }
  }
  let filled = 0;
  const out = pool.candidates.map((raw) => {
    const c = enrichCandidate(raw, { now: pool.sent_at });
    if (!best) return c;
    const rows = batches.get(best)!;
    const pk = rows.find((p) => p.rank === c.rank && sameBuildingName(String(c.name ?? ""), String(p.property_name ?? "")))
      ?? pick(String(c.name ?? ""), (c.room_no as string | null) ?? null, rows, "property_name", "room_no");
    if (pk) {
      const n = fillMissing(c, factsFromPickup(pk, pool.sent_at), "pickup").length;
      deriveFacts(c, pool.sent_at);
      if (n) filled++;
    }
    return c;
  });
  return { candidates: out, filled, batch: best };
}
