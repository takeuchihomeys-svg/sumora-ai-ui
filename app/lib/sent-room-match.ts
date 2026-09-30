// app/lib/sent-room-match.ts（純関数・DB に触れない・画面からも import してよい）
// 「そのお客様に一度送った部屋か」の判定を1か所に（拡張 chrome-extension/sent-skip.js と同じ決まり・四者同名）。
//
// 2026-09-30 v2.5.42 竹内「画面監視して、一度送った物件はお客さんごとに再度送らないようにする形で」:
//   ・拡張（sent-skip.js）… 検索の一覧で選ばない（資料をダウンロードしない）
//   ・見張り（search-audit-check SENT_SELECTED）… 選んだ・ダウンロードした部屋に送付済みが混ざっていないか
//   ・送る側（pickup-review-order・pickup-group-announce）… 送付済みの部屋を既定の候補から外す・手で選んだ時は確かめてから送る
//   の3か所が同じ線で動くように、拡張の写しをここに置き、tests で拡張の関数と同じ答えかを実物の名前で確かめる。
//
// 決まり（迷ったら「送付済みではない」＝新着を漏らさない・別の部屋を外さない）:
//   ・同じ部屋＝建物名が同じ（normalizePropertyName と同じ正規化で完全一致）かつ号室が同じ（数字は先頭の 0 を落とす・英字付きは英字ごと）
//   ・同じ建物の別の部屋・Ⅱ/Ⅲ・「サウス」と「サウスタワー」・名前が「物件」等・号室が読めない行は送付済みにしない
//   ※ 売上サポのバッジ（pickup-sent-badge・isSameProperty＝名前 0.95 のあいまい一致）は「見せる」ための物で、外す・止めるのはこの完全一致だけ

const UNUSABLE = new Set(["物件", "設備・詳細", "詳細", "お気に入り", "印刷用pdf", "図面", "-", "ー", "―"]);

function toHalf(s: string): string {
  return s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 建物名の正規化（property-name-match.ts normalizePropertyName・sent-skip.js normName と同じ） */
export function normRoomName(s: string | null | undefined): string {
  let t = String(s ?? "").trim();
  if (!t) return "";
  t = t.replace(/^\s*(?:【\s*[0-9０-９]{1,2}\s*】|[①-⑳]|[0-9０-９]{1,2}\s*[.．)）])\s*/, "");
  t = toHalf(t);
  t = t.replace(/[・･、。,，（）()「」『』\[\]【】\-−ー_/／　\s]/g, "");
  return t.toLowerCase();
}

/** 号室（sent-property-record.ts normalizeRoomNo・sent-skip.js normRoom と同じ）: 数字だけの号室は先頭の 0 を落とす */
export function normRoomNo(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const m = s.match(/([0-9０-９]{1,5})\s*号?室?\s*$/);
  const digits = toHalf(m ? m[1] : s);
  const trimmed = digits.replace(/^0+(?=\d)/, "");
  return /^\d+$/.test(trimmed) ? trimmed : s;
}

/** 引く時の号室の鍵: 英字の付く号室（A0205・B101・005B）は英字ごと（sent-skip.js roomKey と同じ） */
export function roomKeyOf(room: string | null | undefined): string {
  const s = toHalf(String(room ?? "")).replace(/\s+/g, "").replace(/号室?$/, "").toUpperCase();
  if (!s) return "";
  if (/[A-Z]/.test(s)) return s.replace(/(^|[^0-9])0+(?=\d)/g, "$1");
  return normRoomNo(room);
}

export function usableRoomName(name: string | null | undefined): boolean {
  const t = String(name ?? "").trim();
  if (!t || UNUSABLE.has(t.toLowerCase())) return false;
  if (/^[\d\s,，.円万¥]+$/.test(t)) return false;
  return normRoomName(t).length >= 2;
}

export function sentRoomKey(name: string | null | undefined, room: string | null | undefined): string | null {
  const n = normRoomName(name), r = roomKeyOf(room);
  if (!n || !r || !usableRoomName(name)) return null;
  return `${n}|${r}`;
}

export type SentRoomIndex = { map: Map<string, string>; size: number };

/** 送付済みの部屋の一覧 → 引く形（号室の無い行・名前の読めない行は入れない） */
export function buildSentRoomIndex(rooms: ReadonlyArray<{ name?: string | null; room?: string | null; property_name?: string | null; room_no?: string | null }>): SentRoomIndex {
  const map = new Map<string, string>();
  for (const x of rooms ?? []) {
    if (!x) continue;
    const name = x.name ?? x.property_name ?? null;
    const room = x.room ?? x.room_no ?? null;
    const k = sentRoomKey(name, room);
    if (k && !map.has(k)) map.set(k, `${String(name ?? "").slice(0, 60)} ${String(room ?? "")}`);
  }
  return { map, size: map.size };
}

/** その部屋（建物名・号室）が送付済みか。どちらかが無い・名前が読めない → false */
export function isSentRoom(idx: SentRoomIndex | null | undefined, name: string | null | undefined, room: string | null | undefined): boolean {
  if (!idx || !idx.size) return false;
  const k = sentRoomKey(name, room);
  return !!(k && idx.map.has(k));
}

/**
 * 物件の行（売上サポの行・選んだ部屋）のうち送付済みの部屋の物を返す（純関数）。
 *   号室は room_no → 物件名の末尾の号室（「〇〇 303号室」）の順に読む
 */
export function pickSentRooms<T extends { property_name?: string | null; room_no?: string | null; room_text?: string | null }>(items: ReadonlyArray<T>, idx: SentRoomIndex | null | undefined): T[] {
  if (!idx || !idx.size) return [];
  return items.filter((it) => {
    const name = String(it.property_name ?? "");
    const room = (it.room_no ?? "").trim() || (it.room_text ?? "").trim() || splitRoomFromName(name).room;
    const nm = (it.room_no ?? "").trim() || (it.room_text ?? "").trim() ? name : splitRoomFromName(name).building || name;
    return isSentRoom(idx, nm, room);
  });
}

/** 「〇〇マンション 303号室」「〇〇 303」→ 建物名と号室（号室が読めなければ room=null） */
export function splitRoomFromName(name: string): { building: string; room: string | null } {
  const s = String(name ?? "").trim();
  const m = s.match(/^(.*?\S)\s+([A-Za-zＡ-Ｚａ-ｚ]?-?[0-9０-９]{2,5}[A-Za-zＡ-Ｚａ-ｚ]?)\s*(?:号室|号)?$/);
  if (!m) return { building: s, room: null };
  return { building: m[1], room: m[2] };
}

/** リアプロの一覧の行の先頭のセル「309 4日前 閲覧済」→ 号室（sent-skip.js roomFromRealproCell と同じ）。無ければ null */
export function roomFromRealproCell(cell: string | null | undefined): string | null {
  const s = String(cell ?? "").normalize("NFKC");
  const m = s.match(/^\s*([A-Za-z]?-?\d{1,5}[A-Za-z]?)(?=\s|$)/);
  return m ? m[1] : null;
}

/** 候補の記録（property_candidate_pools.candidates の1件）→ 建物名・号室（号室は room_no → リアプロの先頭のセルの順） */
export function roomOfCandidate(c: { name?: string | null; room_no?: string | null; cells?: string[] | null } | null | undefined): { name: string | null; room: string | null } {
  if (!c) return { name: null, room: null };
  const room = (c.room_no ?? "").toString().trim() || roomFromRealproCell(Array.isArray(c.cells) ? c.cells[0] : null);
  return { name: c.name ?? null, room: room || null };
}
