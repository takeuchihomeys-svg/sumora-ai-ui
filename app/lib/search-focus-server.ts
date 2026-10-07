// app/lib/search-focus-server.ts — 「📌 会話から物件検索」の印を置く・印のお客様の決め手の条件を拡張に渡す（サーバー専用）
//
// 2026-10-07 竹内「それにする　設計知見と協力しておこなう」:
//   AIX【物件を探す】（property_search）を送った時、拡張の自動検索に積む代わりに（自動検索は 10/01 から停止中）、
//   そのお客様を拡張のお客様一覧の一番上「📌 会話から物件検索」に出す印（property_search_focus・v2.5.86 の仕組み）を置く。
//   置く所は送信の記録（/api/log-aix-usage・AIX を送った後に画面が1回だけ呼ぶ）。予約送信（まだ送っていない）は置かない。
//   失敗しても送信・記録は止めない（呼ぶ側が waitUntil の中で握る）。
//   決め手の条件（closing-target・「家賃−5千」「カウンターキッチン」等）は、印を開いた時に拡張が GET ?customer_id= で読み、
//   一時調整の欄に「この回だけ」入れる（登録の条件は変えない）。サイトで絞れない設備は欄に入れず帯に出す（採点は property-brain が加点）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { FOCUS_TTL_MS, shouldPlaceAutoFocus, type FocusDevice } from "@/app/lib/search-focus";
import { closingSearchOverride, GAP_KIND_JA, type ClosingTargetState, type CurrentConditions } from "@/app/lib/closing-target";
import { sanitizeSearchOverride } from "@/app/lib/search-override-read";
import type { SearchOverride } from "@/app/lib/search-override";

export function isMissingFocusTable(msg: string | undefined | null): boolean {
  return /property_search_focus/.test(String(msg ?? "")) && /does not exist|schema cache|Could not find/i.test(String(msg ?? ""));
}

/** 会話に紐付いたお客様（物件出しのお客様）。無ければ customer=null */
export async function resolveFocusCustomer(db: SupabaseClient, conversationId: string) {
  const { data: conv } = await db.from("conversations").select("id, property_customer_id, customer_name").eq("id", conversationId).maybeSingle();
  const pcId = (conv as { property_customer_id?: string | null } | null)?.property_customer_id ?? null;
  if (!pcId) return { conv, customer: null as null | { id: string; customer_name: string | null; status: string | null } };
  const { data: pc } = await db.from("property_customers").select("id, customer_name, status").eq("id", pcId).maybeSingle();
  return { conv, customer: (pc as { id: string; customer_name: string | null; status: string | null } | null) ?? null };
}

export type PlaceFocusResult =
  | { ok: true; placed: true; customerId: string; at: string }
  | { ok: true; placed: false; reason: "no-customer" | "recent-mark"; customerId?: string }
  | { ok: false; error: string };

/**
 * AIX を送った時に印を置く（自動）。お客様ごとに1行（upsert）・FOCUS_DEDUPE_MS 以内に置かれた印があれば置かない（二重に置かない）。
 *   by: 押した人（画面にログインが無いので AIX の種類を入れる）
 */
export async function placeSearchFocus(
  db: SupabaseClient,
  o: { conversationId: string; device: FocusDevice; by?: string | null; now?: Date },
): Promise<PlaceFocusResult> {
  try {
    const { customer } = await resolveFocusCustomer(db, o.conversationId);
    if (!customer) return { ok: true, placed: false, reason: "no-customer" };
    const now = o.now ?? new Date();
    const { data: cur, error: curErr } = await db.from("property_search_focus").select("requested_at").eq("property_customer_id", customer.id).maybeSingle();
    if (curErr) return { ok: false, error: isMissingFocusTable(curErr.message) ? "table-missing" : curErr.message };
    if (!shouldPlaceAutoFocus(cur as { requested_at?: string | null } | null, now.getTime())) return { ok: true, placed: false, reason: "recent-mark", customerId: customer.id };
    const at = now.toISOString();
    const { error } = await db.from("property_search_focus").upsert({
      property_customer_id: customer.id,
      conversation_id: o.conversationId,
      requested_at: at,
      requested_by: o.by ? String(o.by).slice(0, 40) : null,
      device: o.device,
    }, { onConflict: "property_customer_id" });
    if (error) return { ok: false, error: isMissingFocusTable(error.message) ? "table-missing" : error.message };
    return { ok: true, placed: true, customerId: customer.id, at };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 拡張に渡す決め手の条件（お客様の言葉そのもの＝evidence・rationale は認証なしの GET に出さない） */
export type FocusClosing = {
  v: string;
  kind: string;
  /** 型の日本語（「家賃」「設備」…） */
  kinds_ja: string[];
  status: "active" | "partial";
  /** 気に入った部屋（基準）。「バウスフラッツ新大阪 1002」 */
  favorite: string | null;
  /** その回だけ一時調整の欄に入れる上書き（サイトで絞れる欄だけ）。無ければ null */
  search_override: SearchOverride | null;
  /** サイトで絞れない決め手の設備（帯に出す・採点で上げる） */
  equipment: string[];
};

/** 像 → 拡張に渡す形（純）。見つかった像（found）・何も無い時は null */
export function focusClosingFrom(st: ClosingTargetState | null, cur: CurrentConditions | null): FocusClosing | null {
  if (!st || st.status === "found") return null;
  const t = st.target;
  const ov = cur ? sanitizeSearchOverride(closingSearchOverride(t, cur)) : null;
  const equipment = (t.want.equipment ?? []).map((e) => e.label).filter(Boolean);
  if (!ov && !equipment.length) return null;
  const fav = t.favorite ? `${t.favorite.name}${t.favorite.room ? ` ${t.favorite.room}` : ""}` : null;
  return {
    v: t.v,
    kind: t.kind,
    kinds_ja: (t.kinds?.length ? t.kinds : [t.kind]).map((k) => GAP_KIND_JA[k] ?? k),
    status: st.status,
    favorite: fav,
    search_override: ov,
    equipment,
  };
}

/**
 * 効いている印（24時間以内）のお客様だけ、今の決め手の条件を作る（読むだけ）。印が無いお客様は null（読まない＝DB を叩かない）
 */
export async function loadFocusClosing(db: SupabaseClient, propertyCustomerId: string, now: Date = new Date()): Promise<{ marked: boolean; closing: FocusClosing | null }> {
  const { data: mark } = await db.from("property_search_focus").select("requested_at").eq("property_customer_id", propertyCustomerId).maybeSingle();
  const at = Date.parse(String((mark as { requested_at?: string } | null)?.requested_at ?? ""));
  if (!Number.isFinite(at) || now.getTime() - at >= FOCUS_TTL_MS) return { marked: false, closing: null };
  const { loadClosingTargetState } = await import("@/app/lib/closing-target-server");
  const st = await loadClosingTargetState(db, { propertyCustomerId }, { now });
  if (!st || st.status === "found") return { marked: true, closing: null };
  const { data: cur } = await db.from("property_customers").select("rent_max, floor_plan, floor_area_min, walk_minutes, building_age, desired_area, preferences, area_mode").eq("id", propertyCustomerId).maybeSingle();
  return { marked: true, closing: focusClosingFrom(st, (cur as CurrentConditions | null) ?? null) };
}
