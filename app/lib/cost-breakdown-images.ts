// app/lib/cost-breakdown-images.ts（純関数・DB/LLM なし・画面とサーバーの両方から読める）
// AIX【初期費用について】の御見積書の画像の欄に、今の番の物件で実際に送った画像（物件資料＋その直後の御見積書）を最初から入れる。
//
// 2026-10-16 竹内悠馬（10/16 の画面の事例 g）: 「その御見積書の画像の欄に、実際に送った物件（送付済みの御見積書・物件資料）を最初から入れておく」。
//   旧: 会話で最後の AIX【見積書送る】の前後の画像を最大3枚＝5件まとめて送った束では別の物件の画像が入っていた。
// 決め: ブレインの今の物件（current_property）と同じ物件の送った画像（sent_image_properties / sent_properties の image_url）を探し、
//   その画像と、同じ束で直後（10秒以内）に送ったこちらの画像（御見積書）を入れる。見つからなければ null（旧の決め方のまま）。戻す NEXT_PUBLIC_CB_IMAGES_BY_PROPERTY=off
import { splitPropertyName, matchRoomRefs, type RoomRef } from "./customer-state";

export function cbImagesByPropertyEnabled(v: string | null | undefined): boolean {
  return (v ?? "").trim().toLowerCase() !== "off";
}

export type CbSentRow = { property_name: string | null; room_no: string | null; image_url: string | null; sent_at?: string | null };
export type CbMsg = { id: string; image_url: string | null; created_at: string; sender: string };

export function pickCostBreakdownImages(target: RoomRef | null, sent: ReadonlyArray<CbSentRow>, msgs: ReadonlyArray<CbMsg>, max = 3): CbMsg[] | null {
  if (!target) return null;
  const urls = new Set<string>();
  for (const r of sent) {
    if (!r.image_url || !r.property_name) continue;
    const ref = splitPropertyName(r.property_name, r.room_no ?? null);
    if (!ref) continue;
    const k = matchRoomRefs(target, ref);
    if (k === "same_room" || (k === "same_building" && (!target.room || !ref.room))) urls.add(r.image_url);
  }
  if (!urls.size) return null;
  const staffImgs = [...msgs].filter((m) => m.sender === "staff" && !!m.image_url).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  // 一番新しく送った、この物件の画像
  const idx = staffImgs.map((m, i) => (urls.has(m.image_url!) ? i : -1)).filter((i) => i >= 0).at(-1);
  if (idx === undefined) return null;
  const out = [staffImgs[idx]];
  for (let j = idx + 1; j < staffImgs.length && out.length < max; j++) {
    const m = staffImgs[j];
    if (Date.parse(m.created_at) - Date.parse(out[out.length - 1].created_at) > 10_000) break;
    if (urls.has(m.image_url!)) { out.push(m); continue; }
    // 別の物件の資料（記録のある画像）が来たら束の区切り
    if (sent.some((r) => r.image_url === m.image_url)) break;
    out.push(m);
  }
  return out;
}
