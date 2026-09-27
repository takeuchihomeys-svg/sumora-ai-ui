// app/lib/pickup-sent-badge.ts
// 売上サポ（PickupReview）の物件カードに「送った」バッジを付ける（純関数・DB に触れない・画面から import してよい）。
//
// 2026-09-27 竹内（野口さんの画面のスクショ・itandi「モノトーン難波 1002」の小さな灰色の「送信済」）:
//   「物件ピックアップや物件オススメで送った物件は、送ったのが分かるバッジみたいなのを付けたら更に分かりやすい」
//
// ■ 出所（実物で確かめた・2026-09-27）
//   ・sent_properties（詳細 API の sent_history＝このお客様の直近40行）: 経路は channel（NULL の古い行は source から＝sent-delivery.rowChannel）
//       ピックアップ … channel=pickup・source=aix:property_send・pickup_id 付き（例: モノトーン難波 1002 → pickup_id 753・9/27 19:52 JST）
//                     画像の読み取りが先に書いた行は source=vision・pickup_id なし（channel=pickup）
//       オススメ     … channel=recommendation・pickup_id は付かない（売上サポの mark_sent は画像の対応を付けない＝画像の読み取りが名前で書く）
//       グループ共有 … delivery=shared（source=line_group）＝お客様には送っていない → バッジにしない
//   ・property_pickups.status=sent・sent_at・sent_by（今は全部 'aix'）: どの AIX で送ったかは分からない → 表で当たらない時だけ「📨 送った」
// ■ 当て方: pickup_id が同じ行、または pickup_id の無い行・別の回の行でも同じ物件（sent-property-record.isSameProperty＝名前 0.95 以上・号室が両方あれば号室で）
//   ＝同じ部屋を別の回・別の AIX で送った時も出す。両方で送った物件は両方出す（ピックアップ → オススメ → その他の順・種類ごとに一番新しい日）
import { isSameProperty } from "./sent-property-record";
import { isCustomerRow, rowChannel } from "./sent-delivery";

export type SentBadgeKind = "pickup" | "recommendation" | "check" | "estimate" | "other";
export type SentBadge = { kind: SentBadgeKind; label: string; at: string | null; color: string; bg: string; border: string };

export type SentHistRowForBadge = {
  property_name: string | null; room_no: string | null; channel: string | null; delivery: string | null; source: string | null;
  sent_at: string | null; pickup_id: number | null;
};
export type PickupForBadge = { id: number; property_name: string; room_no: string | null; room_text?: string | null; status: string; sent_at: string | null };

const STYLE: Record<SentBadgeKind, { icon: string; text: string; color: string; bg: string; border: string }> = {
  pickup: { icon: "📤", text: "ピックアップで送った", color: "#1b5e20", bg: "#e8f5e9", border: "#66bb6a" },
  recommendation: { icon: "🏠", text: "オススメで送った", color: "#0d47a1", bg: "#e3f2fd", border: "#42a5f5" },
  check: { icon: "🔎", text: "物件確認で送った", color: "#4a148c", bg: "#f3e5f5", border: "#ab47bc" },
  estimate: { icon: "🧾", text: "見積書で送った", color: "#e65100", bg: "#fff3e0", border: "#ffa726" },
  other: { icon: "📨", text: "送った", color: "#37474f", bg: "#eceff1", border: "#90a4ae" },
};
const ORDER: SentBadgeKind[] = ["pickup", "recommendation", "check", "estimate", "other"];

/** 日付（JST の M/D）。読めなければ空 */
export function jstMonthDay(iso: string | null | undefined): string {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "";
  const d = new Date(t + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

function kindOfRow(row: SentHistRowForBadge): SentBadgeKind {
  const ch = rowChannel(row);
  if (ch === "pickup") return "pickup";
  if (ch === "recommendation") return "recommendation";
  if (ch === "check") return "check";
  if (ch === "estimate") return "estimate";
  return "other";
}

function badgeOf(kind: SentBadgeKind, at: string | null): SentBadge {
  const s = STYLE[kind];
  const day = jstMonthDay(at);
  return { kind, label: `${s.icon} ${s.text}${day ? ` ${day}` : ""}`, at, color: s.color, bg: s.bg, border: s.border };
}

/** カード1件のバッジ（無ければ空）。history はこのお客様の sent_properties の行（共有の行が混ざっていてよい） */
export function sentBadgesFor(item: PickupForBadge, history: ReadonlyArray<SentHistRowForBadge> | null | undefined): SentBadge[] {
  const room = (item.room_no ?? "").trim() || (item.room_text ?? "").trim() || null;
  const latest = new Map<SentBadgeKind, string | null>();
  for (const h of history ?? []) {
    if (!isCustomerRow(h)) continue;
    const hit = h.pickup_id === item.id
      || isSameProperty({ property_name: item.property_name, room_no: room }, { property_name: h.property_name ?? "", room_no: h.room_no });
    if (!hit) continue;
    const k = kindOfRow(h);
    const prev = latest.get(k);
    if (prev === undefined || (h.sent_at ?? "") > (prev ?? "")) latest.set(k, h.sent_at ?? null);
  }
  // 表で当たらないが送った印はある（表が直近40行で切れた・記録に失敗した）→ どの AIX か分からない「送った」
  if (latest.size === 0 && item.status === "sent") latest.set("other", item.sent_at);
  return ORDER.filter((k) => latest.has(k)).map((k) => badgeOf(k, latest.get(k) ?? null));
}
