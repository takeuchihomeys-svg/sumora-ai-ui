// app/lib/sent-delivery.ts
// 物件送った表（sent_properties）の1行を「共有した／お客様に送った」「どの経路で送ったか」で読む（純関数・DB に触れない）。
//
// 2026-09-24 竹内「売上サポの部分お客さんの物件送った部分のテーブルとも連携されてる形かな？これで送ったのとかも判断できる。
//   どれ物件ピックアップで送ったか物件オススメで送ったかもわかる。ここと拡張ツールも連携されてかなり効率の良いサイクルとなる」
//
// ■ 決めたこと
//   ・既存の source の値と意味は変えない。source='vision' は今までどおり「会話の物件名と照合できなかった読み取り」の印
//     （sent-image-record.ts の already 判定がこれを見ている）。
//   ・経路は channel、共有か送付かは delivery という別の列に持つ（経路と照合結果を1つの列に混ぜない。
//     旧は照合できないと source を 'vision' に落とし、経路が消えていた＝お客様に送った記録の約3%しか経路が分からなかった）。
//   ・delivery='shared' になるのは source='line_group' の時だけ（逆も同じ）。これで SQL は埋め戻しの前でも source で絞れる。
//   ・列が NULL の古い行は source から導く（rowDelivery / rowChannel）。埋め戻しをしなくても読み手は動く。

export type Delivery = "shared" | "customer";
export type Channel = "pickup" | "recommendation" | "check" | "estimate" | "aix_other" | "staff_image" | "extension_group";

/** source → 経路。経路が分からない（vision・null）なら null */
export function channelFromSource(source: string | null | undefined): Channel | null {
  const s = (source ?? "").trim();
  if (!s || s === "vision") return null;
  if (s === "line_group") return "extension_group";
  if (s === "staff_image") return "staff_image";
  if (s === "aix:property_send") return "pickup";
  if (s === "aix:property_recommendation") return "recommendation";
  if (s === "aix:property_check_result") return "check";
  if (s === "aix:estimate_sheet") return "estimate";
  if (s.startsWith("aix:")) return "aix_other";
  return null;
}

/** source → 共有か送付か。line_group（拡張の「売上番長に送る」＝グループに共有した時点）だけが shared */
export function deliveryFromSource(source: string | null | undefined): Delivery {
  return (source ?? "").trim() === "line_group" ? "shared" : "customer";
}

type DeliveryRow = { delivery?: string | null; source?: string | null };
type ChannelRow = { channel?: string | null; source?: string | null };

/** 列を優先し、NULL（古い行）なら source から導く */
export function rowDelivery(row: DeliveryRow): Delivery {
  if (row.delivery === "shared" || row.delivery === "customer") return row.delivery;
  return deliveryFromSource(row.source);
}

/** 列を優先し、NULL なら source から導く */
export function rowChannel(row: ChannelRow): Channel | null {
  const c = (row.channel ?? "").trim();
  if (c) return c as Channel;
  return channelFromSource(row.source);
}

/** お客様に送った行か（グループに共有しただけの行は false） */
export function isCustomerRow(row: DeliveryRow): boolean {
  return rowDelivery(row) === "customer";
}

// ─── 拡張の送済みバッジ ────────────────────────────────────────────────────
export type BadgeKind = "recommend" | "pickup" | "sent" | "shared";
const BADGE_PRIORITY: Record<BadgeKind, number> = { recommend: 4, pickup: 3, sent: 2, shared: 1 };

/** 1行 → バッジの種類 */
export function badgeKindOfRow(row: DeliveryRow & ChannelRow): BadgeKind {
  if (rowDelivery(row) === "shared") return "shared";
  const ch = rowChannel(row);
  if (ch === "recommendation") return "recommend";
  if (ch === "pickup") return "pickup";
  return "sent";
}

/**
 * 同じ物件に当たった行が複数ある時の1件。
 * 優先: オススメで送った ＞ ピックアップで送った ＞ 送った ＞ 共有のみ。同じ種類の中では sent_at が新しい方。
 * （拡張の score-overlay.js に同じ決まりを写している）
 */
export function pickBadge<T extends DeliveryRow & ChannelRow & { sent_at?: string | null }>(rows: T[]): (T & { kind: BadgeKind }) | null {
  let best: (T & { kind: BadgeKind }) | null = null;
  for (const r of rows) {
    const kind = badgeKindOfRow(r);
    if (!best) { best = { ...r, kind }; continue; }
    const pd = BADGE_PRIORITY[kind] - BADGE_PRIORITY[best.kind];
    if (pd > 0 || (pd === 0 && Date.parse(r.sent_at ?? "") > Date.parse(best.sent_at ?? ""))) best = { ...r, kind };
  }
  return best;
}

/**
 * 拡張がカードの本文と物件名を比べる時の鍵。NFKC → 小文字 → 空白と「・･」を除く。3文字未満なら ""（短すぎて誤爆する）。
 * ⚠ chrome-extension/score-overlay.js の nameKey に同じ3行を写している（片方だけ変えない）。
 */
export function badgeNameKey(name: string | null | undefined): string {
  const k = (name ?? "").normalize("NFKC").toLowerCase().replace(/[\s・･]/g, "");
  return k.length >= 3 ? k : "";
}
