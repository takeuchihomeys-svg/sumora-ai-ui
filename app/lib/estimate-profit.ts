// app/lib/estimate-profit.ts
// 見積書（AIX【見積書送る】の本文）から「どの物件に・いくら割引したか」を取り出し、
// その物件が**物件ピックアップ／物件オススメで送った物件**なら AD（候補プール・送付記録）と結び付けて利益を出す。純関数・DB 依存なし。
//
// 2026-09-24 竹内「物件ピックアップや物件オススメでお客さんにどんな物件を送っているか分かっている。
//   AIX の見積書送るの画像や文からもどれだけ割引しているか分かるし、その物件が物件オススメや物件ピックアップで送った物件なら
//   AD も理解しているはず。この点も踏まえて連動するようにする」
//
// ── 実物（aix_usage_logs estimate_sheet 244通・2026-09-24）──
//   「【アコード中之島 1402号室】 / 初期費用さらに / 🌟26,500円割引させて頂き / 初期費用：208,110円 / …」
//   「①【ドリームネオポリス桜ノ宮】 / … 🌟82,000円割引 … 初期費用：126,180円 / ②【フレンシアノイエ難波南 601号室】 / … 🌟44,000円割引 …」
//   → 【】ごとに1件。号室は【】の中（無い事もある）。割引は「N円割引」、初期費用は「初期費用：N円」。
//   244通のうち 円割引 213・【】218。割引額の記録はこの本文にしか無かった（estimates テーブル 0行・設計知見 2026-09-23）。
//
// ── AD の出所（優先順）──
//   ① property_candidate_pools.candidates（拡張が検索した時の表の文字: name・ad_months・rent）… 同じお客様・見積より前
//   ② sent_properties（送った物件: property_name・room_no・rent・ad_months）
//   AD 円 ＝ ad_months × 家賃。家賃は候補プール → 送付記録 の順（無ければ AD 円は出さず ad_months だけ残す）。
//   ⚠ 名前の照合は property-name-match（0.7）＋シリーズ番号（own-property-match.seriesTokens）。号室が両方にある時は号室も合わせる。
//     近くない物は「分からない」（違うとは言わない）。
import { matchKnownProperty, MATCH_MIN_SCORE } from "./property-name-match";
import { seriesTokens, normalizeRoom } from "./own-property-match";

export type EstimateItem = {
  index: number;
  propertyName: string;
  roomNo: string | null;
  discountYen: number | null;
  initialCostYen: number | null;
};

function toHalfWidth(s: string): string {
  return s.replace(/[０-９Ａ-Ｚａ-ｚ：，．（）]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, " ");
}

/**
 * 見積書の本文から物件ごとの割引・初期費用を取り出す（【】ごとに区切る）。
 * 【】が無い本文は「物件名なし」の1件として割引だけ返す（物件は結び付けられない）。
 */
export function parseEstimateItems(text: string | null | undefined): EstimateItem[] {
  const t = toHalfWidth(String(text ?? "")).replace(/,/g, "");
  if (!t.trim()) return [];
  const blocks: Array<{ head: string | null; body: string }> = [];
  const re = /【([^】\n]{2,80})】/g;
  let last = 0; let m: RegExpExecArray | null; let prevHead: string | null = null;
  while ((m = re.exec(t))) {
    if (prevHead !== null || last > 0) blocks.push({ head: prevHead, body: t.slice(last, m.index) });
    prevHead = m[1].trim(); last = re.lastIndex;
  }
  blocks.push({ head: prevHead, body: t.slice(last) });
  const items: EstimateItem[] = [];
  for (const b of blocks) {
    if (b.head === null && !/円\s*割引/.test(b.body)) continue;   // 見出しの前の前置きは飛ばす
    const disc = b.body.match(/(\d{3,7})\s*円\s*割引/);
    const cost = b.body.match(/初期費用\s*[:：]\s*(\d{4,8})\s*円/);
    let name = b.head ?? "";
    let room: string | null = null;
    const rm = name.match(/^(.+?)\s+([0-9]{2,4}[A-Za-z]?)\s*(?:号室|号)?$/);
    if (rm) { name = rm[1].trim(); room = normalizeRoom(rm[2]); }
    else { const rm2 = name.match(/^(.+?)\s*([0-9]{2,4}[A-Za-z]?)\s*号室$/); if (rm2) { name = rm2[1].trim(); room = normalizeRoom(rm2[2]); } }
    const discountYen = disc ? parseInt(disc[1], 10) : null;
    if (!name && discountYen == null) continue;
    items.push({
      index: items.length,
      propertyName: name,
      roomNo: room,
      discountYen: discountYen != null && discountYen >= 1_000 && discountYen <= 500_000 ? discountYen : null,
      initialCostYen: cost ? parseInt(cost[1], 10) : null,
    });
  }
  return items;
}

export type AdSource = {
  kind: "candidate_pool" | "sent_property";
  name: string;
  roomNo?: string | null;
  adMonths?: number | null;
  adYen?: number | null;
  rent?: number | null;
  /** 検索・送付の時刻（見積より前の物だけ使う。呼び出し側で絞ってもよい） */
  at?: string | null;
};

export type AdLink = {
  adMonths: number | null;
  adYen: number | null;
  rent: number | null;
  source: AdSource["kind"];
  matchedName: string;
  score: number;
};

/**
 * 見積書の1件を AD の出所と結び付ける。候補プール → 送付記録 の順。
 * 号室が両方にあって違う時は同じ建物の別の部屋なので使わない。AD が無い出所は飛ばす。
 */
export function linkAdForEstimate(item: EstimateItem, sources: ReadonlyArray<AdSource>): AdLink | null {
  if (!item.propertyName || item.propertyName.length < 2) return null;
  const order: AdSource["kind"][] = ["candidate_pool", "sent_property"];
  for (const kind of order) {
    const pool = sources.filter((s) => s.kind === kind && s.name && (s.adMonths != null || s.adYen != null));
    if (pool.length === 0) continue;
    const names = [...new Set(pool.map((s) => s.name))];
    const hit = matchKnownProperty(item.propertyName, names, MATCH_MIN_SCORE);
    if (!hit) continue;
    if (seriesTokens(item.propertyName) !== seriesTokens(hit.name)) continue;
    const cands = pool.filter((s) => s.name === hit.name);
    const room = normalizeRoom(item.roomNo);
    const same = cands.filter((s) => { const r = normalizeRoom(s.roomNo); return !room || !r || r === room; });
    if (same.length === 0) continue;
    // 新しい物を優先
    const best = [...same].sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")))[0];
    const rent = best.rent != null && best.rent > 0 ? best.rent
      : (sources.find((s) => s.name === hit.name && s.rent != null && s.rent > 0)?.rent ?? null);
    const adMonths = best.adMonths != null && best.adMonths > 0 && best.adMonths <= 12 ? best.adMonths : null;
    const adYen = best.adYen != null && best.adYen > 0 ? best.adYen : (adMonths != null && rent != null ? Math.round(adMonths * rent) : null);
    return { adMonths, adYen, rent, source: kind, matchedName: hit.name, score: hit.score };
  }
  return null;
}

/** 利益 ＝ AD 円 − 割引。どちらか無ければ null */
export function computeProfitYen(adYen: number | null | undefined, discountYen: number | null | undefined): number | null {
  if (adYen == null || discountYen == null) return null;
  return adYen - discountYen;
}

export type ProfitSummary = {
  n: number;
  discountMedianYen: number | null;
  adYenMedian: number | null;
  profitMedianYen: number | null;
  /** AD と結び付いた件数 */
  linked: number;
  /** 利益が出ていない（AD < 割引）件数 */
  negative: number;
};

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** お客様（または全体）の見積の記録から、割引・AD・利益の中央値 */
export function summarizeEstimateProfit(rows: ReadonlyArray<{ discount_yen?: number | null; ad_yen?: number | null; profit_yen?: number | null }>): ProfitSummary {
  const d = rows.map((r) => r.discount_yen).filter((v): v is number => typeof v === "number" && v > 0);
  const a = rows.map((r) => r.ad_yen).filter((v): v is number => typeof v === "number" && v > 0);
  const p = rows.map((r) => r.profit_yen).filter((v): v is number => typeof v === "number");
  return {
    n: rows.length,
    discountMedianYen: median(d),
    adYenMedian: median(a),
    profitMedianYen: median(p),
    linked: a.length,
    negative: p.filter((v) => v < 0).length,
  };
}

/** ブレイン・判定の材料に渡す1行（数字が無い項目は書かない） */
export function formatProfitNote(s: ProfitSummary): string {
  if (s.n === 0) return "";
  const parts: string[] = [`見積書 ${s.n}件`];
  if (s.discountMedianYen != null) parts.push(`割引の中央値 ${s.discountMedianYen.toLocaleString()}円`);
  if (s.linked > 0 && s.adYenMedian != null) parts.push(`AD と結び付いた ${s.linked}件・AD の中央値 ${s.adYenMedian.toLocaleString()}円`);
  if (s.profitMedianYen != null) parts.push(`利益（AD−割引）の中央値 ${s.profitMedianYen.toLocaleString()}円${s.negative > 0 ? `・利益が出ていない ${s.negative}件` : ""}`);
  return parts.join("／");
}
