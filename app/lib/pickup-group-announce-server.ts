// app/lib/pickup-group-announce-server.ts（サーバー専用・DB・LINE。画面側から import しない）
// AIXツールの解析（まとめ＝自動の読み取り＋順位＋👑）が終わった時に、★物件出し★グループ（pickup_group_id）へ1回だけアナウンスする。
// 決まり（いつ・何を）は pickup-group-announce.ts（純関数）。呼ぶのは finishCompleteGroup（pickup-complete-server.ts）
//
// 二重に送らない: property_pickup_completions.announced_item_ids（知らせた行）と announced_at を条件付き UPDATE で先に取ってから送る
//   （Cron・拡張の alarm・詳細を開いた時・止まったまとめのやり直しが重なっても送るのは1つだけ）。
//   先に取ってから送るので、LINE が失敗した時は announce_error に残す（送り直しはしない＝同じ文が2回届くより、1回抜ける方を選ぶ）
// dry: 取る・送るをせず、送る文だけ返す（確かめ用・グループに送らない）
import { supabase } from "@/app/lib/supabase";
import { announcePlan, buildAnnouncement, announceLink, type AnnounceItem } from "@/app/lib/pickup-group-announce";

const HANBANCYO_TOKEN = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN;
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? "https://sumora-ai-ui.vercel.app";

/** ★物件出し★グループ（merge-pdfs の getGroupId と同じ: pickup_group_id → 無ければ group_id） */
async function pickupGroupId(): Promise<string | null> {
  const { data } = await supabase.from("hanbancyo_settings").select("key, value").in("key", ["pickup_group_id", "group_id"]);
  const m = new Map(((data ?? []) as Array<{ key: string; value: string | null }>).map((r) => [r.key, r.value]));
  return (m.get("pickup_group_id") || m.get("group_id") || null) as string | null;
}

export type AnnounceResult = {
  sent: boolean;
  dry: boolean;
  skipped: string | null;
  update: boolean;
  newIds: number[];
  text: string | null;
  error: string | null;
};

type RankedRow = AnnounceItem & { batch_id?: string | null; created_at?: string | null; site?: string | null };

/**
 * まとめ1つのアナウンス。order＝まとめの順位の id の並び（rankCompleteGroup.order）・rows＝点を付け直した行（finishCompleteGroup の rows）。
 * 失敗しても投げない
 */
export async function announceCompleteGroup(input: {
  groupId: string;
  propertyCustomerId: string;
  order: ReadonlyArray<number> | null;
  bestId: number | null;
  rows: ReadonlyArray<RankedRow>;
  stopped?: boolean;
  dry?: boolean;
}): Promise<AnnounceResult> {
  const out: AnnounceResult = { sent: false, dry: !!input.dry, skipped: null, update: false, newIds: [], text: null, error: null };
  try {
    const ids = input.rows.map((r) => r.id);
    if (!ids.length) { out.skipped = "no_rows"; return out; }
    // 印（group_notice）と説明文・名前はまとめの select に無いので引き直す
    const [flagsRes, compRes] = await Promise.all([
      supabase.from("property_pickups").select("id, group_notice, summary_text, customer_name, batch_id, created_at, site").in("id", ids),
      supabase.from("property_pickup_completions").select("announced_item_ids, announced_at").eq("group_id", input.groupId).maybeSingle(),
    ]);
    if (flagsRes.error) {
      // 列（group_notice）を本番に足す前: merge-pdfs は印を付けられず、今まで通り検索のたびに送っている＝ここは何もしない
      out.skipped = /group_notice/.test(flagsRes.error.message) ? "no_column" : "read_error";
      if (out.skipped === "read_error") out.error = flagsRes.error.message;
      return out;
    }
    if (compRes.error) { out.skipped = /announced/.test(compRes.error.message) ? "no_column" : "read_error"; out.error = compRes.error.message; return out; }
    const flags = (flagsRes.data ?? []) as Array<{ id: number; group_notice: string | null; summary_text: string | null; customer_name: string | null; batch_id: string | null; created_at: string | null; site: string | null }>;
    const comp = (compRes.data ?? null) as { announced_item_ids: number[] | null; announced_at: string | null } | null;
    const plan = announcePlan(flags, comp?.announced_item_ids ?? null);
    out.update = plan.update; out.newIds = plan.newIds;
    if (!plan.send) { out.skipped = flags.some((f) => f.group_notice) ? "already" : "not_deferred"; return out; }

    const byId = new Map(flags.map((f) => [f.id, f]));
    const rowById = new Map(input.rows.map((r) => [r.id, r]));
    const orderIds = input.order && input.order.length ? input.order : ids;
    // 2026-09-30 v2.5.42 このお客様に届けた部屋（完全一致・★物件出し★への共有は除く）の印。読めない時は付けない（今まで通り）
    let sentBefore = new Set<number>();
    try {
      const { sentRoomsFor } = await import("@/app/lib/sent-rooms-server");
      const { buildSentRoomIndex, pickSentRooms } = await import("@/app/lib/sent-room-match");
      const sr = await sentRoomsFor(supabase as never, input.propertyCustomerId, { customerOnly: true });
      if (!sr.error && sr.rooms.length) {
        const idx = buildSentRoomIndex(sr.rooms);
        sentBefore = new Set(pickSentRooms(input.rows.map((r) => ({ id: r.id, property_name: (r as { property_name?: string | null }).property_name ?? null, room_no: (r as { room_no?: string | null }).room_no ?? null })), idx).map((x) => x.id));
      }
    } catch { /* 印なしで続ける */ }
    const items: AnnounceItem[] = orderIds.map((id) => {
      const r = rowById.get(id);
      const f = byId.get(id);
      return { ...(r ?? { id }), id, summary_text: f?.summary_text ?? r?.summary_text ?? null, sent_before: sentBefore.has(id) };
    });
    const sites: Record<string, number> = {};
    for (const f of flags) { const k = f.site ?? "unknown"; sites[k] = (sites[k] ?? 0) + 1; }
    const first = [...flags].sort((a, z) => String(a.created_at ?? "").localeCompare(String(z.created_at ?? "")) || a.id - z.id)[0];
    const customerName = [...flags].reverse().find((f) => f.customer_name)?.customer_name ?? null;
    // 2026-09-29 見張り: この回の検索の注意（条件が入り切っていない・0件の疑い）を1行ずつ（読めない時は出さない）
    const watchNotes = await import("@/app/lib/screen-watch-server").then((m) => m.watchNoticeLines(input.propertyCustomerId, first?.created_at ?? null)).catch(() => [] as string[]);
    const text = buildAnnouncement({
      customerName, sites, items, bestId: input.bestId, update: plan.update, stopped: input.stopped, watchNotes,
      link: announceLink(BASE_URL, input.propertyCustomerId, first?.batch_id ?? null),
    });
    out.text = text;
    if (input.dry) return out;

    if (!HANBANCYO_TOKEN) { out.error = "LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN が未設定"; return out; }
    const groupId = await pickupGroupId();
    if (!groupId) { out.error = "hanbancyo_settings に pickup_group_id / group_id が無い"; return out; }

    // 先に取る（条件付き UPDATE・前の値と同じ時だけ）。取れなかった＝他の呼び出しが送った
    const at = new Date().toISOString();
    let q = supabase.from("property_pickup_completions").update({ announced_item_ids: plan.announcedAfter, announced_at: at, announce_error: null }).eq("group_id", input.groupId);
    q = comp?.announced_at ? q.eq("announced_at", comp.announced_at) : q.is("announced_at", null);
    const { data: took, error: tErr } = await q.select("group_id");
    if (tErr) { out.error = tErr.message; return out; }
    if (!took?.length) { out.skipped = "taken"; return out; }

    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${HANBANCYO_TOKEN}` },
      body: JSON.stringify({ to: groupId, messages: [{ type: "text", text }] }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      out.error = `LINE API エラー HTTP ${res.status}: ${body.slice(0, 200)}`;
      await supabase.from("property_pickup_completions").update({ announce_error: out.error }).eq("group_id", input.groupId).then(() => undefined, () => undefined);
      return out;
    }
    out.sent = true;
    return out;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    return out;
  } finally {
    console.log(JSON.stringify({ tag: "property-pickups:group-announce", group: input.groupId, sent: out.sent, dry: out.dry, skipped: out.skipped, update: out.update, new_items: out.newIds.length, stopped: !!input.stopped, error: out.error }));
  }
}

/**
 * 2026-09-29 見張り（screen-watch）: ★物件出し★グループ（pickup_group_id）だけに1通送る。
 *   売上番長グループ（group_id）へは送らない＝pickup_group_id が無い・group_id と同じ時は送らずに理由を返す（merge-pdfs の getGroupId のような group_id への逃げはしない）
 */
export async function pushPickupGroupNotice(text: string): Promise<{ sent: boolean; error: string | null }> {
  try {
    if (!HANBANCYO_TOKEN) return { sent: false, error: "LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN が未設定" };
    const { data, error } = await supabase.from("hanbancyo_settings").select("key, value").in("key", ["pickup_group_id", "group_id"]);
    if (error) return { sent: false, error: error.message };
    const m = new Map(((data ?? []) as Array<{ key: string; value: string | null }>).map((r) => [r.key, r.value]));
    const pick = (m.get("pickup_group_id") ?? "").trim();
    if (!pick) return { sent: false, error: "pickup_group_id が無い（売上番長グループには送らない）" };
    if (pick === (m.get("group_id") ?? "").trim()) return { sent: false, error: "pickup_group_id が group_id と同じ（売上番長グループには送らない）" };
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${HANBANCYO_TOKEN}` },
      body: JSON.stringify({ to: pick, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
    });
    if (!res.ok) return { sent: false, error: `LINE API エラー HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}` };
    return { sent: true, error: null };
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : String(e) };
  }
}
