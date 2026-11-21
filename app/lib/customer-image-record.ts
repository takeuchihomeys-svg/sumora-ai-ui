// app/lib/customer-image-record.ts — お客様の画像1枚 → 記録の1行（customer_image_records）の形を決める（純関数・DB/LLM なし）
//
// 2026-11-21 作業員G（竹内さん 11/21「画像の把握の部分を、打ち合わせした時のように細かく行う」・memory/image_understanding_map.md の E ②）:
//   お客様の画像の読み（種類・物件・照合・関連・聞いている事）は、ブレインが動く度に customer-image-link で作り直していて、どこにも残っていなかった。
//   画像ごとに1行で残し、物件ごとの記録（property-thread の「お客様が送ってきた」・KB 2dab3589）と監査がそれを読めるようにする。
//   入れない物（KB 33a30792・個人情報）: 書き起こし・お客様の文そのもの・見積書の宛名。書類（本人確認・収入・契約）は種類だけ。
//   2026-11-21 から既定 on（CUSTOMER_IMAGE_RECORD=off で止める）。記録だけで、ブレインの判断・返信は変えない。
import type { ImageLink } from "./customer-image-link";
import { savedImageKind } from "./image-label";
import { propertyKey } from "./property-key";

type Env = Record<string, string | undefined>;
export function customerImageRecordOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  // 2026-11-21 作業員G（統括役の決め・記録だけなので試験なし）: 既定 on。止める CUSTOMER_IMAGE_RECORD=off
  return (env.CUSTOMER_IMAGE_RECORD ?? "").trim().toLowerCase() !== "off";
}
export const CUSTOMER_IMAGE_RECORD_VERSION = "g1121-1";

export type CustomerImageRecordRow = {
  message_id: string; conversation_id: string; created_at: string;
  kind: string; link_kind: string; part: string | null;
  property_name: string | null; room_no: string | null; name_via: string | null;
  rent_yen: number | null; admin_yen: number | null; madori: string | null; area_sqm: number | null; station: string | null; walk_min: number | null; age_years: number | null;
  certainty: string | null;
  ours_kind: string | null; ours_property_name: string | null; ours_room_no: string | null;
  relation: string | null;
  estimate: { company: "own" | "other"; items: Record<string, number> } | null;
  asks: string[];
  unit_key: string | null;
  read_version: string;
};

/** 1枚の画像の記録の行。text は messages.text（種類の見出しを読むだけ・書き起こしは行に入れない） */
export function customerImageRecordRow(msg: { id: string; conversation_id: string; created_at: string; text: string | null; image_type?: string | null; nameVia?: string | null }, link: ImageLink): CustomerImageRecordRow {
  const kind = link.kind === "document" ? "document" : savedImageKind(msg.text) ?? (/^\s*\[画像\]\s*$/.test(msg.text ?? "") ? "unread" : "unknown");
  const p = link.property;
  const isDoc = link.kind === "document";
  const name = isDoc ? null : p?.name ?? null;
  const room = isDoc ? null : p?.room ?? null;
  const unit = name ? propertyKey(name, room) : link.ours ? propertyKey(link.ours.name, link.ours.room) : null;
  return {
    message_id: msg.id, conversation_id: msg.conversation_id, created_at: msg.created_at,
    kind, link_kind: link.kind, part: link.part,
    property_name: name, room_no: room, name_via: name ? (msg.nameVia ?? null) : null,
    rent_yen: isDoc ? null : p?.rentYen ?? null, admin_yen: isDoc ? null : p?.adminYen ?? null, madori: isDoc ? null : p?.madori ?? null,
    area_sqm: isDoc ? null : p?.areaSqm ?? null, station: isDoc ? null : p?.station ?? null, walk_min: isDoc ? null : p?.walk ?? null, age_years: isDoc ? null : p?.ageYears ?? null,
    certainty: isDoc ? null : p?.certainty ?? null,
    ours_kind: link.ours?.by ?? (p ? "none" : null), ours_property_name: link.ours?.name ?? null, ours_room_no: link.ours?.room ?? null,
    relation: link.kind.startsWith("property") ? link.relation : null,
    // 見積書は会社と数字だけ（会社名・物件名・宛名は入れない）
    estimate: link.estimate ? { company: link.estimate.company, items: Object.fromEntries(Object.entries(link.estimate.items).filter(([, v]) => typeof v === "number")) as Record<string, number> } : null,
    asks: [...link.asks],
    unit_key: isDoc ? null : unit,
    read_version: CUSTOMER_IMAGE_RECORD_VERSION,
  };
}
