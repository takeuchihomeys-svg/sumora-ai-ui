// app/lib/pickup-recent-dup.ts（純関数）
// 2026-10-01 竹内「同じ物件が2つ入ってしまうバグ…2回送ってしまったのが原因…ちゃんと分析した時に省かれるようにする」:
//   売上サポ（property_pickups）は merge-pdfs の1回＝1バッチで、同じ回の中の重複（dedupeSameBuilding）は落としていたが、
//   **回をまたいだ重複**（同じ部屋を続けて2回送った）は見ていなかった＝ あかり（4c075f30）の5件が 16:19 と 16:23 に2行ずつ。
//   スタッフモードは「人が選んだ物は減らさない」ので送る側（merge-pdfs）は外さない → 外すのは記録（AIX ツールに入れる所）だけ。
//
// 線（実測・直近30日の property_pickups 1,881行・同じお客様×同じ部屋の2行目 8件）:
//   ・4秒／3分 … 6件（二重送信。あかり 5件・ITANDI カーサ ラピス302 1件）
//   ・1〜3日   … 2件（日を空けた出し直しで、2行目からお客様に送っていた＝ status=sent。消すと送った行が無くなる）
//   → 間の 1時間〜24時間に1件も無い。誤って消さない側の 6時間 を採る（二重送信は全部・出し直しは0件を巻き込む）
import { parseSummaryHead } from "./sent-property-filter";
import { normalizePropertyName } from "./property-name-match";
import { normalizeRoomNo } from "./sent-property-record";

export const RECENT_DUP_WINDOW_MS = 6 * 60 * 60 * 1000;

export type RecentPickupRow = { property_name: string | null; room_no: string | null; pdf_url: string | null; created_at: string };

/** 一時置き場の URL は送るたびに変わるので鍵にしない。リアプロの印刷用 URL（id 付き）はそのまま鍵 */
function urlKey(u: string | null | undefined): string {
  const s = String(u ?? "").trim();
  if (!s || /blob\.vercel-storage\.com/i.test(s)) return "";
  return s;
}

function roomKey(name: string | null | undefined, room: string | null | undefined): string {
  const n = normalizePropertyName(name);
  const r = normalizeRoomNo(room);
  if (!n || n.length < 2 || !r) return "";
  return n + "|" + r;
}

/**
 * この回の物件（説明文と資料 URL・同じ並び）のうち、同じお客様の記録に {window} 以内に同じ部屋がある物の番号。
 * 照合は「印刷用 URL が同じ」か「建物名＋号室が同じ」（号室が無い・名前が読めない物は照合しない＝消さない側）
 */
export function recentDuplicateIndexes(
  summaries: ReadonlyArray<string>,
  pdfUrls: ReadonlyArray<string | null | undefined>,
  rows: ReadonlyArray<RecentPickupRow>,
  nowMs: number,
  windowMs: number = RECENT_DUP_WINDOW_MS,
): Set<number> {
  const urls = new Set<string>();
  const rooms = new Set<string>();
  for (const r of rows) {
    const t = Date.parse(r.created_at);
    if (!Number.isFinite(t) || nowMs - t > windowMs || t > nowMs + 60_000) continue;
    const u = urlKey(r.pdf_url); if (u) urls.add(u);
    const k = roomKey(r.property_name, r.room_no); if (k) rooms.add(k);
  }
  const out = new Set<number>();
  summaries.forEach((s, i) => {
    const u = urlKey(pdfUrls[i]);
    if (u && urls.has(u)) { out.add(i); return; }
    const h = parseSummaryHead(s);
    const k = h ? roomKey(h.propertyName, h.roomNo) : "";
    if (k && rooms.has(k)) out.add(i);
  });
  return out;
}
