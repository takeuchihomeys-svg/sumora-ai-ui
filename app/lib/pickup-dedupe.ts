// app/lib/pickup-dedupe.ts
// 売上サポに記録する1回分（ピックアップ）から、同じ建物の「ほぼ同じ広さの部屋」を落とす（純関数・DB 依存なし・画面からも使える）。
//
// 2026-09-24 竹内「同じ建物だと平米数2㎡以内だと家賃がひくい部屋をここにいれて、他の部屋は売上サポに飛ばさなくて大丈夫。
//   同じマンションの部屋何個もお客さんに送らないので」
//
// 実例（2026-09-24 の1回分・10件）: エスリード難波AGREA が8件（号室なし）。21.09㎡ ×5・21.83㎡ ×3、家賃 73,100〜77,000円
//   → どれも差は 2㎡以内なので、残すのは 73,100円（【5🌟】）の1件だけ。10件 → 3件（7件を落とす）
//
// 線引き（誤削除 0 の側に倒す＝迷う物は残す）:
//   - 同じ建物 = 名前の完全一致（normalizePropertyName ＋ ローマ数字 Ⅰ〜Ⅻ→I〜XII・「号棟」→「棟」）。似ている度は使わない
//     （「エスリード難波AGREA」と「エスリード難波グランデ」、Ⅰ と Ⅱ は別の建物）
//   - 面積・家賃・建物名のどれかが読めない物は比べずに残す
//   - 間取りが両方読めて違う（1K と 1LDK）なら、面積が近くても別の部屋として残す
//   - 数珠つなぎにしない: 建物ごとに「家賃が低い順」に並べ、**残した部屋**と 2㎡以内なら落とす
//     （20.0・21.5・23.0 で 20.0 が一番安い → 21.5 は落とし、23.0 は 20.0 と 3㎡違うので残す）
//   - 家賃が同じ時: 家賃＋管理費が低い → AD（円）が高い（利益）→ 面積が広い → 元の順位が上
//   - 落とした部屋の 🌟 / 🌟★ は、残した部屋に強い方を引き継ぐ（🌟 の部屋の AD の段が残す部屋より高い時は落とさない・2026-09-25）
//   - 送付済みの部屋（isSent）は残す部屋の候補の最後に回す（2026-09-25）
// ⚠ LINE グループへの送信・結合 PDF・sent_properties には使わない（売上サポの記録だけ・merge-pdfs は変えない）
import { parseSummaryHead } from "./sent-property-filter";
import { normalizePropertyName } from "./property-name-match";
import { parseRentFromSummary } from "./property-summary-parse";
import { parsePropertyFacts } from "./property-brain";
import { parseRecommendMark } from "./property-pickups";
import { isGenericBuildingName } from "./generic-building-name";

/** 同じ建物で「同じ部屋とみなす」面積の差（㎡）。竹内「平米数2㎡以内」 */
export const SAME_BUILDING_AREA_DIFF_SQM = 2;

const toHalf = (s: string) => s.replace(/[Ａ-Ｚａ-ｚ０-９．，]/g, (c) => c === "．" ? "." : c === "，" ? "," : String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/** 説明文から専有面積（㎡）。名前の行は見ない（名前に数字が入る物件がある）。ありえない値（5㎡未満・300㎡超）は null */
export function parseAreaSqm(summary: string | null | undefined): number | null {
  const lines = String(summary ?? "").split("\n").slice(1);
  for (const line of lines) {
    const m = toHalf(line).match(/(\d+(?:\.\d+)?)\s*(?:㎡|m²|m2|平米|平方メートル)/i);
    if (!m) continue;
    const v = parseFloat(m[1]);
    if (Number.isFinite(v) && v >= 5 && v <= 300) return v;
  }
  return null;
}

const ROMAN: Record<string, string> = {
  "Ⅰ": "I", "Ⅱ": "II", "Ⅲ": "III", "Ⅳ": "IV", "Ⅴ": "V", "Ⅵ": "VI", "Ⅶ": "VII", "Ⅷ": "VIII", "Ⅸ": "IX", "Ⅹ": "X", "Ⅺ": "XI", "Ⅻ": "XII",
  "ⅰ": "I", "ⅱ": "II", "ⅲ": "III", "ⅳ": "IV", "ⅴ": "V", "ⅵ": "VI", "ⅶ": "VII", "ⅷ": "VIII", "ⅸ": "IX", "ⅹ": "X", "ⅺ": "XI", "ⅻ": "XII",
};

/**
 * 名前だけでは建物を決められない一般名。2026-09-24 竹内「前回の反証で出た点も直す」: 名前が読めず「物件」になった説明文どうしが
 *   同じ建物と見なされ、別の建物の部屋が落ちる穴があった（parsePropertyFacts は名前が無い時「物件」を入れる）→ 比べない（残す側）
 * 決まりは generic-building-name.ts に1つ（property-brain の送付済みの照合と同じ線）
 */
export { isGenericBuildingName };

/** 建物の鍵（完全一致で同じ建物）。空なら比べない。一般名（「物件」等）も空＝比べない */
export function buildingKey(name: string | null | undefined): string {
  if (isGenericBuildingName(name)) return "";
  const s = String(name ?? "").replace(/[Ⅰ-Ⅻⅰ-ⅻ]/g, (c) => ROMAN[c] ?? c).replace(/号棟/g, "棟");
  return normalizePropertyName(s);
}

/** 家賃の行の2つ目の金額（「78,000円 7,000円」の 7,000）。「管理費」の言葉があればそちらが正 */
function adminFeeOf(summary: string, rentYen: number | null): number | null {
  const facts = parsePropertyFacts(summary);
  if (facts.adminFeeYen != null) return facts.adminFeeYen;
  for (const line of String(summary ?? "").split("\n").slice(1)) {
    const amounts = [...toHalf(line).replace(/,/g, "").matchAll(/(\d+)\s*円/g)].map((m) => parseInt(m[1], 10));
    if (amounts.length >= 2 && rentYen != null && amounts[0] === rentYen && amounts[1] < rentYen && amounts[1] <= 100_000) return amounts[1];
  }
  return null;
}

export type DedupeRoom = {
  index: number;
  rank: number;
  name: string;
  key: string;
  areaSqm: number | null;
  rentYen: number | null;
  adminFeeYen: number | null;
  adYen: number | null;
  floorPlan: string | null;
  recommended: number;
};

/** 1件ずつの読み（テスト・ログ用に export） */
export function readDedupeRoom(summary: string, index: number): DedupeRoom {
  const head = parseSummaryHead(summary);
  const mark = parseRecommendMark(summary);
  const facts = parsePropertyFacts(summary);
  const rentYen = parseRentFromSummary(summary);
  const adYen = facts.adYen ?? (facts.adMonths != null && rentYen != null ? Math.round(facts.adMonths * rentYen) : null);
  const name = head?.propertyName ?? "";
  return {
    index, rank: mark.rank ?? index + 1, name, key: buildingKey(name),
    areaSqm: parseAreaSqm(summary), rentYen, adminFeeYen: adminFeeOf(summary, rentYen), adYen,
    floorPlan: facts.floorPlan, recommended: mark.recommended,
  };
}

export type DedupeDrop = {
  index: number; rank: number; name: string; areaSqm: number; rentYen: number;
  keptIndex: number; keptRank: number; reason: "same_building_within_2sqm";
};
export type DedupeResult = {
  /** 残す番号（元の並び・昇順） */
  keep: number[];
  dropped: DedupeDrop[];
  /** 残した番号 → 引き継ぐ印（落とした部屋の 🌟=1 / 🌟★=2 と自分の強い方）。引き継ぎが無い物は入らない */
  inheritMark: Map<number, number>;
  /** 残した番号 → 落とした件数 */
  droppedCount: Map<number, number>;
};

/** 家賃が低い順（同じなら 家賃＋管理費 → AD 高 → 面積 広 → 順位 上） */
function cheaperFirst(a: DedupeRoom, z: DedupeRoom): number {
  return ((a.rentYen as number) - (z.rentYen as number))
    || (((a.rentYen as number) + (a.adminFeeYen ?? 0)) - ((z.rentYen as number) + (z.adminFeeYen ?? 0)))
    || ((z.adYen ?? 0) - (a.adYen ?? 0))
    || ((z.areaSqm as number) - (a.areaSqm as number))
    || (a.rank - z.rank);
}

/**
 * AD の段（property-brain の AD の札と同じ区切り）: 0＝なし・読めない ／ 1＝1ヶ月未満 ／ 2＝1ヶ月以上 ／ 3＝2ヶ月以上 ／ 4＝3ヶ月以上。
 * 円は家賃で月数に直す（円のままだと家賃が高い部屋ほど AD が高く見える）
 */
export function adTier(r: Pick<DedupeRoom, "adYen" | "rentYen">): number {
  const m = r.adYen != null && r.rentYen ? r.adYen / r.rentYen + 1e-6 : null;
  if (m == null || m <= 0) return 0;
  return m >= 3 ? 4 : m >= 2 ? 3 : m >= 1 ? 2 : 1;
}

export function dedupeSameBuilding(summaries: ReadonlyArray<string>, opts?: {
  maxAreaDiffSqm?: number;
  /**
   * このお客様に送付済みの部屋か（元の並びの番号）。2026-09-25 YUMA テスト（お客様B）: 送付済みの 710号室が一番安いので残り、
   *   まだ送っていない同じ建物の部屋（907号室 AD 2.5ヶ月など）を落としていた＝売上サポに「送付済み（保留）」しか残らない。
   *   送付済みの部屋は残す部屋の候補の最後に回す（全部が送付済みなら今まで通り一番安い部屋）
   */
  isSent?: (index: number) => boolean;
}): DedupeResult {
  const maxDiff = opts?.maxAreaDiffSqm ?? SAME_BUILDING_AREA_DIFF_SQM;
  const rooms = summaries.map((s, i) => readDedupeRoom(s, i));
  const dropped: DedupeDrop[] = [];
  const dropSet = new Set<number>();
  const inheritMark = new Map<number, number>();
  const droppedCount = new Map<number, number>();
  // 読めない物（建物名・面積・家賃のどれか）は比べない＝残す
  const comparable = rooms.filter((r) => r.key && r.areaSqm != null && r.rentYen != null);
  const byBuilding = new Map<string, DedupeRoom[]>();
  for (const r of comparable) byBuilding.set(r.key, [...(byBuilding.get(r.key) ?? []), r]);
  for (const group of byBuilding.values()) {
    if (group.length < 2) continue;
    const kept: DedupeRoom[] = [];
    const sentLast = (a: DedupeRoom, z: DedupeRoom) => (opts?.isSent ? Number(opts.isSent(a.index)) - Number(opts.isSent(z.index)) : 0);
    for (const r of group.slice().sort((a, z) => sentLast(a, z) || cheaperFirst(a, z))) {
      const nears = kept.filter((k) =>
        Math.abs((k.areaSqm as number) - (r.areaSqm as number)) <= maxDiff + 1e-9
        && !(k.floorPlan && r.floorPlan && k.floorPlan !== r.floorPlan));
      if (!nears.length) { kept.push(r); continue; }
      let near = nears[0];
      // 2026-09-25 YUMA テスト（お客様A・itandi の回）: 🌟★ は AD 2.5ヶ月の 907号室に付いたのに、2,000円安い 413号室（AD 0.5ヶ月・利益が出ない）を残して
      //   🌟★ を引き継ぎ、売上サポで「一番オススメ」が保留（PROFIT_NEGATIVE）の物件に付いていた（印と点が矛盾）。
      //   → 🌟 の付いた部屋が、残す部屋より AD の段（判定の AD の札と同じ段）が高い時は落とさない（迷う物は残す側）。印も引き継がない。
      //   ただし同じ段以上の部屋をもう残していれば、そちらに寄せて印を引き継ぐ（同じ建物を 3部屋・4部屋と並べない・お客様C の回）
      if (r.recommended > 0 && adTier(r) > adTier(near)) {
        const peer = nears.find((k) => adTier(k) >= adTier(r));
        if (!peer) { kept.push(r); continue; }
        near = peer;
      }
      dropSet.add(r.index);
      dropped.push({ index: r.index, rank: r.rank, name: r.name, areaSqm: r.areaSqm as number, rentYen: r.rentYen as number, keptIndex: near.index, keptRank: near.rank, reason: "same_building_within_2sqm" });
      droppedCount.set(near.index, (droppedCount.get(near.index) ?? 0) + 1);
      if (r.recommended > Math.max(near.recommended, inheritMark.get(near.index) ?? 0)) inheritMark.set(near.index, r.recommended);
    }
  }
  const keep = rooms.map((r) => r.index).filter((i) => !dropSet.has(i));
  return { keep, dropped: dropped.sort((a, z) => a.index - z.index), inheritMark, droppedCount };
}

/** 残した行に添える一文（reasons_ja）。竹内さんがスタッフに見せる形 */
export function dedupeNoteJa(n: number): string {
  return `同じ建物の近い広さ（${SAME_BUILDING_AREA_DIFF_SQM}㎡以内）の部屋を ${n}件省略（家賃が高い方）`;
}
