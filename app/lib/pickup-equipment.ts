// app/lib/pickup-equipment.ts（純関数・画面とサーバーで共用。fs・DB・サーバーの部品は import しない）
// 売上サポのピックアップ1回分に「資料の設備欄 × お客様の条件」の照合を付ける。
//
// 2026-09-24 竹内（HONOKA さん・property_pickups id 50〜67）:
//   「宅配BOX付きなども条件なのにそこちゃんと入れていない」「設備の項目は資料の設備欄に記載ある。設備面も見るように」
//   「階数は 202号室なら2階、301号室なら3階」「ちゃんと条件埋めれるように」
// 決まり:
//   - 読むのは PDF の文字層（listing-equipment.ts の決定論・DeepSeek 0円）。書いていない物は「－（記載なし）」で、無いとは読まない
//   - 同じ建物の別の部屋（同じ回で落とした部屋も含む）の資料に書いてある建物単位の設備（エレベーター・宅配ボックス・オートロック・
//     ネット無料・駐車場）は「○〔建〕」で補う（mergeBuildingEquipment）
//   - 保存する形（property_pickups.equipment）は画面がそのまま読める要約（全 35 項目は持たない＝記載のあった物と手がかりだけ）
import {
  parseListingEquipment, mergeBuildingEquipment, parseEquipmentWants, matchEquipment, formatEquipmentMatch,
  type ListingEquipment, type EquipmentMatch, type EquipmentWants, type CustomerConditionsLike, type EquipKey, type EquipStatus,
} from "./listing-equipment";

/** property_pickups.equipment に残す形（版を変えたら v を上げる） */
export type PickupEquipment = {
  v: 1;
  format: ListingEquipment["format"];
  hasText: boolean;
  room: string | null;
  floor: number | null;
  floorSource: ListingEquipment["floorSource"];
  roomFloor: number | null;
  totalFloors: number | null;
  basement: boolean;
  /** 記載のあった設備だけ（s=ok/ng・ev=根拠・fb=同じ建物から補った・d=可/相談/空きなし 等・hint=近い言葉） */
  facts: Partial<Record<EquipKey, { s: EquipStatus; ev: string | null; fb?: true; d?: string; hint?: string }>>;
  /** 希望ごとの照合（画面の1行・理由の札の元） */
  match: Array<{ key: string; label: string; mode: "must" | "ng"; strong: boolean; result: "ok" | "ng" | "unlisted"; mark: string; why: string; fromBuilding?: true }>;
  ok: number; ng: number; unlisted: number; strongNg: boolean;
  /** どの設備にも当たらない部屋・建物の条件（照らせない条件） */
  uncovered: string[];
  /** 「2階以上○ エレベーター○〔建〕 宅配ボックス－」 */
  line: string;
};

/** 照合を保存の形にする */
export function toPickupEquipment(facts: ListingEquipment, m: EquipmentMatch, wants: EquipmentWants): PickupEquipment {
  const f: PickupEquipment["facts"] = {};
  for (const [k, v] of Object.entries(facts.items) as Array<[EquipKey, ListingEquipment["items"][EquipKey]]>) {
    if (v.status === "unlisted" && !v.hint) continue;
    f[k] = { s: v.status, ev: v.evidence, ...(v.fromBuilding ? { fb: true as const } : {}), ...(v.detail ? { d: v.detail } : {}), ...(v.hint ? { hint: v.hint } : {}) };
  }
  return {
    v: 1, format: facts.format, hasText: facts.hasText, room: facts.room, floor: facts.floor, floorSource: facts.floorSource,
    roomFloor: facts.roomFloor, totalFloors: facts.totalFloors, basement: facts.basement, facts: f,
    match: m.rows.map((r) => ({
      key: r.want.key, label: r.label, mode: r.want.mode, strong: r.want.strong, result: r.result, mark: r.mark, why: r.why,
      ...(r.fromBuilding ? { fromBuilding: true as const } : {}),
    })),
    ok: m.ok, ng: m.ng, unlisted: m.unlisted, strongNg: m.strongNg,
    uncovered: wants.uncovered.map((u) => u.text),
    line: formatEquipmentMatch(m),
  };
}

/** key＝結果を引く鍵（回の中で一意）。label＝補いの根拠に出す名前（数字なら「#id」・文字ならそのまま「【3】」）。無ければ key */
export type EquipmentBatchRow = { key: string | number; pdfText: string | null; label?: string | number };
export type EquipmentBatchResult = { key: string | number; facts: ListingEquipment; match: EquipmentMatch; saved: PickupEquipment };

/**
 * 1回分の全部の行（同じ建物で落とした部屋も含める＝補いの材料）の文字層を読み、同じ建物で補い、お客様の条件と照らす。
 * 文字層が無い行も返す（全部「記載なし」＝点は動かない）。wants が空でも facts は返す（所在階の表示に使う）。
 */
export function buildBatchEquipment(rows: ReadonlyArray<EquipmentBatchRow>, customer: CustomerConditionsLike | null | undefined): { wants: EquipmentWants; rows: EquipmentBatchResult[] } {
  const wants = parseEquipmentWants(customer ?? null);
  const merged = mergeBuildingEquipment(rows.map((r) => ({ id: r.label ?? r.key, key: r.key, facts: parseListingEquipment(r.pdfText) })));
  return {
    wants,
    rows: merged.map((r) => {
      const match = matchEquipment(wants, r.facts);
      return { key: r.key, facts: r.facts, match, saved: toPickupEquipment(r.facts, match, wants) };
    }),
  };
}

/**
 * 拡張から呼ばれる判定（PDF が無い）: 説明文から読めた分だけで照らす。記載なし（－）の行は落とす
 * （説明文には設備欄が無いので、全部「要確認」の札になるのを避ける。号室から推した階・説明文に書いてある設備だけが残る）
 */
export function matchFromSummary(summary: string | null | undefined, wants: EquipmentWants): EquipmentMatch | null {
  if (!wants.wants.length) return null;
  const facts = parseListingEquipment(String(summary ?? "").replace(/^【[^】]*】\s*/u, ""));
  const m = matchEquipment(wants, facts);
  const rows = m.rows.filter((r) => r.result !== "unlisted");
  if (!rows.length) return null;
  return { rows, ok: rows.filter((r) => r.result === "ok").length, ng: rows.filter((r) => r.result === "ng").length, unlisted: 0, strongNg: rows.some((r) => r.result === "ng" && r.want.strong) };
}

/** 画面の所在階の言い方（「9階（所在階）」「5階（号室から推定）」「地下」） */
export function floorLabel(e: Pick<PickupEquipment, "floor" | "floorSource" | "basement"> | null | undefined): string | null {
  if (!e) return null;
  if (e.basement) return "地下";
  if (e.floor == null) return null;
  const src = e.floorSource === "所在階" ? "所在階" : e.floorSource === "階部分" ? "階部分" : e.floorSource === "号室" ? "号室から推定" : null;
  return src ? `${e.floor}階（${src}）` : `${e.floor}階`;
}
