// app/lib/image-detail-part.ts — こちらが送った画像1枚ずつの「部分」（image_details.part）を決める（純関数・DB/LLM なし）
//
// 2026-11-22 作業員K2（台帳 #287 画像の記録の①「こちらが送った画像1枚ずつに役目」・統括役の了承・作業員G と名前をそろえた）。
//   役目の大きな分け（物件の資料か・見積書か・書類か）は今まで通り image_details.kind（property／estimate／document／other）。
//   ここは kind の中の「部分」だけ: listing 資料／interior 室内／floor_plan 間取り図／exterior 外観／cost 費用・見積。
//   言葉は作業員G の customer_image_records.part と同じ（お客様の画像とこちらの画像を同じ物差しで並べる）。
//   数え（11/21・14日・こちらが送った 478枚）: kind が property 339・estimate 8・行なし 131。室内・間取り図の区別はどこにも無かった。
//   ⚠ 先に行を作らない: 物件の画像に kind=property・lines 空の行を先に書くと、送った後の読み取り（ensureImageDetail）が「読み済み」と見て資料を読まなくなる。
//     見積書（estimate-image-role.ts）だけは lines が要らないので先に書いてよい。物件の画像の部分は、読み取りが行を書く時に一緒に入れる。
// スイッチ IMAGE_DETAIL_PART=on（既定 off）。off の時は part を書かない（列は null のまま・今と同じ）。
export type ImagePart = "listing" | "interior" | "floor_plan" | "exterior" | "cost";
export const IMAGE_PARTS: readonly ImagePart[] = ["listing", "interior", "floor_plan", "exterior", "cost"];

export function imageDetailPartOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.IMAGE_DETAIL_PART ?? "").trim().toLowerCase() === "on";
}

/**
 * AIX の種類と確認の型から、その AIX で送った画像の部分を決める。決まらない時は null（推測で埋めない）。
 *   見積書送る・見積書の同封 → cost／物件確認した の室内写真 → interior／物件ピックアップ（資料の束） → listing
 *   物件オススメ・物件確認した（その他）は資料と室内が混ざる＝null（読み取りの kind だけ）
 */
export function partOfAixImage(o: { aixType: string | null | undefined; checkPattern?: string | null; isEstimateImage?: boolean }): ImagePart | null {
  if (o.isEstimateImage) return "cost";
  const t = String(o.aixType ?? "");
  if (t === "estimate_sheet") return "cost";
  if (t === "property_check_result" && o.checkPattern === "interior_photo") return "interior";
  if (t === "property_send") return "listing";
  return null;
}

/** 読み取りの kind と、送った時に分かっている部分を合わせる（kind が estimate なら cost・document/other は部分なし） */
export function partForDetail(kind: string, hint: ImagePart | null | undefined): ImagePart | null {
  if (kind === "estimate") return "cost";
  if (kind !== "property") return null;
  return hint && hint !== "cost" ? hint : null;
}
