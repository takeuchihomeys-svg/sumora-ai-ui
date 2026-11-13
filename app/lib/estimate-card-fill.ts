// app/lib/estimate-card-fill.ts — 見積の記録（estimate_records）の空の金額を、一緒に送った「見積の札」の文から埋める（純関数・DB/LLM なし）
//
// 2026-11-14 作業員G（材料と受け取る側・統括役の頼み「材料が本当に無いか、DB にあるのに受け取っていないか」）:
//   AIX【物件確認した】＋御見積書同封（estimate_sent=true）の記録は source=check_names で、金額の欄（initial_cost_yen・discount_yen）が
//   30日で 93行すべて空だった。estimate-record-items.ts の 10/08 の注記は「金額は画像の中だけ」だったが、本番の DB で確かめると
//   同じ AIX で送った通（messages・is_aix_generated）に「【物件名 号室】 初期費用さらに 🌟N円割引させて頂き 初期費用：N円」の札の文が
//   58ログ中 58ログにあった（AIX のログより 5〜24秒前に messages に入っている＝ログを書く時に読める）。
//   ＝「材料はあるのに欄が空」（届いていない理由: 欄はあるが配線が無い）。
//   困る所: ブレインの指す物の欄（REF_RESOLVE の estimatesFromRecords は金額の無い行を拾わない）・文の統括の値（COMPOSE_ASKS_FACTS）・
//   調べ役（brain-researcher）がどれも estimate_records の金額を読む。14日の「見積の金額が無い」自己申告（申込前 35件）のうち、
//   その前に札の文で金額を送っていた会話は 16件・記録に金額があった会話は 7件だけ。
// 決まり:
//   ・札の文は parseEstimateItems（【】の見出しごと・「初期費用：N円」「N円割引」）で読む（見積書の本文と同じ読み）
//   ・名前（全角半角・空白を揃えて、どちらかがもう一方を含む）と号室（両方ある時は一致）で当てる。当たらない行は空のまま（作らない）
//   ・金額が既にある行は変えない
// 既定 on（2026-11-14 統括役の決め: 下見 95行中91行・目で見た12件で誤り0・戻す ESTIMATE_CARD_FILL=off）。過去の行は scripts/backfill-estimate-card-costs.ts で 11/14 07:36 に 91行を書いた。
import { parseEstimateItems } from "./estimate-profit";
import { normalizeRoom } from "./own-property-match";

type Env = Record<string, string | undefined>;
export function estimateCardFillOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.ESTIMATE_CARD_FILL ?? "").trim().toLowerCase() !== "off";
}

/** 札の文か（読む価値がある通だけ・DB の読みの後の絞り） */
export const ESTIMATE_CARD_RE = /初期費用\s*[:：]\s*[¥￥]?\s*[0-9０-９,，]{4,}\s*円/;

export type FillableItem = { propertyName: string; roomNo: string | null; discountYen: number | null; initialCostYen: number | null };
export type CardCost = { name: string; room: string | null; initialCostYen: number | null; discountYen: number | null };

const nameKey = (s: string) => String(s ?? "").normalize("NFKC").replace(/号室/g, "").replace(/[\s・\-－‐()（）【】]/g, "").toLowerCase();

/** 札の文（複数の通）→ 物件ごとの金額（同じ物件は後の通を採る） */
export function cardCostsOf(texts: ReadonlyArray<string | null | undefined>): CardCost[] {
  const out: CardCost[] = [];
  for (const t of texts) {
    if (!t || !ESTIMATE_CARD_RE.test(t.normalize("NFKC"))) continue;
    for (const it of parseEstimateItems(t)) {
      if (!it.propertyName || it.initialCostYen == null) continue;
      const i = out.findIndex((c) => nameKey(c.name) === nameKey(it.propertyName) && (c.room ?? "") === (it.roomNo ?? ""));
      const c: CardCost = { name: it.propertyName, room: it.roomNo, initialCostYen: it.initialCostYen, discountYen: it.discountYen };
      if (i >= 0) out[i] = c; else out.push(c);
    }
  }
  return out;
}

function sameProperty(item: FillableItem, c: CardCost): boolean {
  const a = nameKey(item.propertyName), b = nameKey(c.name);
  if (!a || !b) return false;
  if (!(a === b || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))))) return false;
  const ra = item.roomNo ? normalizeRoom(item.roomNo) : null;
  const rb = c.room ? normalizeRoom(c.room) : null;
  if (ra && rb) return ra === rb;
  // 片方だけ号室がある時: 同じ建物の札が1つだけなら当てる（号室違いの2札は決めない）
  return true;
}

/** 金額の空の行を札で埋める（新しい配列を返す・埋めた数も）。当たる札が2つ以上（号室が決まらない）なら埋めない */
export function fillItemsFromCards<T extends FillableItem>(items: ReadonlyArray<T>, cards: ReadonlyArray<CardCost>): { items: T[]; filled: number } {
  let filled = 0;
  const outItems = items.map((it) => {
    if (it.initialCostYen != null || !it.propertyName) return it;
    const hits = cards.filter((c) => sameProperty(it, c));
    if (hits.length !== 1) return it;
    filled++;
    return { ...it, initialCostYen: hits[0].initialCostYen, discountYen: it.discountYen ?? hits[0].discountYen, roomNo: it.roomNo ?? hits[0].room };
  });
  return { items: outItems, filled };
}
