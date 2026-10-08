// app/lib/estimate-record-items.ts
// 見積書を送った AIX の記録（aix_usage_logs の1行）から、estimate_records に残す物件の行を決める（純関数・DB に触らない）。
//
// 2026-10-08 竹内「大丈夫」（返信の質 8巡目・記録）: 見積書の AIX の送信は全件 estimate_records に残す。
// ── 実データ（直近60日・グループと YUMA を除く・scripts/_tmp で数えた）──
//   見積書の AIX 287通のうち estimate_records にあったのは 195（68%）。9月後半〜10月は 60/115（52%）。
//   抜けの経路:
//     ① AIX【物件確認した】＋御見積書同封（estimate_sent=true）82通 … 本文に【】も「N円割引」も無い（金額は画像の中だけ）
//        → parseEstimateItems が0件で書いていなかった。物件名は property_names（画面で選んだ物件）にある。
//        うち13通は「会話に合わせる」経路で見積書を読み取った費用メモ（prop_cost_notes: 物件名 / 初期費用合計 / 割引額 / 家賃）がある。
//     ② AIX【見積書送る】で本文が空（6通・9/12 の連続）・【】が無い文（4通:「〇〇 101号室の…お見積書をお送り」等）
//        → 1件も書いていなかった。
// ── 決め方（上から最初に取れた物）──
//   1. 本文の【】ごと（従来の parseEstimateItems・source=aix_text）
//   2. 費用メモ（prop_cost_notes）ごと（source=cost_notes・割引・初期費用・家賃も入る）
//   3. 本文の【】は無いが「N円割引」がある（物件名なし・source=aix_text）
//   4. 物件確認の物件名（property_names・募集終了/申込ありの物件は除く・source=check_names・金額は無い＝画像の中）
//   5. 本文の「〇〇 101号室」（source=aix_text_room）
//   6. どれも無い → 物件名なしの1行（source=aix_no_items）＝送った事実だけは残す
// 戻す: ESTIMATE_RECORDS_ALL=off（1 と 3 だけ＝従来の動き）
import { parseEstimateItems, type EstimateItem } from "./estimate-profit";
import { normalizeRoom } from "./own-property-match";

export type EstimateRecordSource = "aix_text" | "cost_notes" | "check_names" | "aix_text_room" | "aix_no_items";
export type EstimateRecordItem = EstimateItem & { rentYen: number | null; source: EstimateRecordSource };

export type EstimateLogInput = {
  aixType: string | null | undefined;
  generatedText: string | null | undefined;
  propertyNames?: ReadonlyArray<string | null | undefined> | null;
  propStatuses?: ReadonlyArray<string | null | undefined> | null;
  propCostNotes?: ReadonlyArray<string | null | undefined> | null;
};

export function estimateRecordsAllEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.ESTIMATE_RECORDS_ALL ?? "").toLowerCase() !== "off";
}

function toHalf(s: string): string {
  return s.replace(/[０-９Ａ-Ｚａ-ｚ：，．（）]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, " ");
}
const yen = (s: string | undefined): number | null => {
  if (!s) return null;
  const n = parseInt(s.replace(/[,，]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
};

/** 「建物 101号室」→ 建物と号室（号室が読めなければ全体を名前に） */
export function splitNameRoom(raw: string): { name: string; room: string | null } {
  const t = toHalf(String(raw ?? "")).replace(/\s+/g, " ").trim();
  const m = t.match(/^(.+?)\s+([0-9]{2,4}[A-Za-z]?)\s*(?:号室|号)?$/) ?? t.match(/^(.+?)\s*([0-9]{2,4}[A-Za-z]?)\s*号室$/);
  if (m && m[1].trim().length >= 2) return { name: m[1].trim(), room: normalizeRoom(m[2]) };
  return { name: t, room: null };
}

/** 費用メモ「物件名 / 初期費用合計: N円 / 割引額: N円 / … / 家賃: N円」→ 1件 */
export function parseCostNote(note: string, index: number): EstimateRecordItem | null {
  const parts = toHalf(String(note ?? "")).split(" / ").map((s) => s.trim());
  const head = parts[0] ?? "";
  if (!head || /^(初期費用|割引|家賃)/.test(head)) return null;
  const pick = (re: RegExp) => { for (const p of parts.slice(1)) { const m = p.match(re); if (m) return yen(m[1]); } return null; };
  const { name, room } = splitNameRoom(head);
  const discount = pick(/^割引額\s*[:：]\s*([\d,]+)\s*円/);
  return {
    index, propertyName: name, roomNo: room,
    discountYen: discount != null && discount >= 1_000 && discount <= 500_000 ? discount : null,
    initialCostYen: pick(/^初期費用合計\s*[:：]\s*([\d,]+)\s*円/),
    rentYen: pick(/^家賃\s*[:：]\s*([\d,]+)\s*円/),
    source: "cost_notes",
  };
}

const ENDED_STATUS = new Set(["unavailable", "ended"]);
const PLACEHOLDER_NAME_RE = /^(?:物件|お部屋)\s*[①-⑳0-9０-９]*$/;

/** 見積書の AIX の1行 → estimate_records に残す物件の行（0件は「見積書の送信ではない」時だけ） */
export function estimateRecordItemsFromLog(log: EstimateLogInput, env: Record<string, string | undefined> = process.env): EstimateRecordItem[] {
  const text = String(log.generatedText ?? "");
  const textItems: EstimateRecordItem[] = parseEstimateItems(text).map((it) => ({ ...it, rentYen: null, source: "aix_text" as const }));
  if (textItems.some((it) => it.propertyName)) return textItems;
  if (!estimateRecordsAllEnabled(env)) return textItems;

  const notes = (log.propCostNotes ?? []).map((n, i) => parseCostNote(String(n ?? ""), i)).filter((x): x is EstimateRecordItem => !!x && !!x.propertyName);
  if (notes.length) return notes.map((n, i) => ({ ...n, index: i }));
  if (textItems.length) return textItems;

  const names = (log.propertyNames ?? []).map((n, i) => ({ n: String(n ?? "").trim(), s: String(log.propStatuses?.[i] ?? "") }))
    .filter((x) => x.n && !PLACEHOLDER_NAME_RE.test(x.n) && !ENDED_STATUS.has(x.s));
  if (names.length) {
    return names.map((x, i) => { const { name, room } = splitNameRoom(x.n); return { index: i, propertyName: name, roomNo: room, discountYen: null, initialCostYen: null, rentYen: null, source: "check_names" as const }; });
  }

  const t = toHalf(text).replace(/,/g, "");
  const rm = t.match(/(?:^|\n)\s*([^\n。！!、]{2,50}?)\s*([0-9]{2,4}[A-Za-z]?)\s*号室/);
  if (rm && !/お見積|御見積|初期費用|割引|ご入居/.test(rm[1])) {
    const dm = t.match(/[¥￥]?\s*(\d{4,7})\s*円[^\n\d]{0,10}割引/);
    const disc = dm ? parseInt(dm[1], 10) : null;
    return [{ index: 0, propertyName: rm[1].trim(), roomNo: normalizeRoom(rm[2]), discountYen: disc != null && disc >= 1_000 && disc <= 500_000 ? disc : null, initialCostYen: null, rentYen: null, source: "aix_text_room" }];
  }
  const dm = t.match(/[¥￥]?\s*(\d{4,7})\s*円[^\n\d]{0,10}割引/);
  const disc = dm ? parseInt(dm[1], 10) : null;
  return [{ index: 0, propertyName: "", roomNo: null, discountYen: disc != null && disc >= 1_000 && disc <= 500_000 ? disc : null, initialCostYen: null, rentYen: null, source: "aix_no_items" }];
}
