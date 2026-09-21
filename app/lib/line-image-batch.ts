// app/lib/line-image-batch.ts
// 複数の画像を「まとめて」LINE に送るための区切り方（純関数・DB 依存なし）。
//
// 2026-09-22 竹内「AIXの物件確認したで物件資料と見積書を物件ごとに送るとき、公式LINEから送るような形でする。
//   物件資料と見積書おしたら開く形で横並びに出来れば理想。今は1枚1枚画像が大きい状態で送られる。
//   物件オススメや見積書送る際も。物件ピックアップで送る時も10枚までこんな感じでまとめて」
//
// 【今までの送り方】AIX は画像1枚ごとに /api/send-line-message を呼び、1枚ずつ別の送信（push）になっていた。
//   間に DB への記録などが挟まるので、LINE 上では1枚ずつ大きく表示される。
// 【変えた送り方】画像を1回の送信（push）にまとめて入れる。LINE の push は1回に**最大5通**まで入るので、
//   5枚ごとに区切る（10枚なら 5＋5 の2回）。画像を先・本文を後（公式LINEのスクショと同じ順）。
// ⚠ LINE アプリがどう並べて表示するか（横並び・タイル）は LINE 側が決める。こちらができるのは
//   「まとめて1回で送る」ところまで（実際の表示は YUMA で確かめる）。

/** LINE の push 1回に入れられるメッセージ数（Messaging API の上限） */
export const LINE_PUSH_MAX_MESSAGES = 5;
/** 1回の操作でまとめて送る画像の上限（竹内「10枚まで」） */
export const IMAGE_BATCH_MAX = 10;

export type LineImageMessage = { type: "image"; originalContentUrl: string; previewImageUrl: string };
export type LineTextMessage = { type: "text"; text: string };
export type LineMessage = LineImageMessage | LineTextMessage | Record<string, unknown>;

/** LINE の画像メッセージは https の URL だけ受け付ける */
export function isSendableImageUrl(url: string | null | undefined): boolean {
  return /^https:\/\/\S+$/.test((url ?? "").trim());
}

export function imageMessage(url: string): LineImageMessage {
  const u = url.trim();
  return { type: "image", originalContentUrl: u, previewImageUrl: u };
}

/**
 * 画像（と任意の本文）を push ごとの塊に分ける。
 * ・画像が先、本文が後（本文は最後の塊に入るなら入れ、満杯なら次の塊）
 * ・1塊は最大5通
 * ・画像が上限（10枚）を超える・https でない URL がある時は error を返す（黙って削らない）
 */
export function buildImageBatchPushes(
  imageUrls: readonly string[],
  text?: string | null,
): { ok: true; pushes: LineMessage[][]; imageCount: number } | { ok: false; error: string } {
  const urls = imageUrls.map((u) => (u ?? "").trim()).filter(Boolean);
  if (urls.length === 0) return { ok: false, error: "画像がありません" };
  if (urls.length > IMAGE_BATCH_MAX) return { ok: false, error: `まとめて送れる画像は${IMAGE_BATCH_MAX}枚までです（${urls.length}枚）` };
  const bad = urls.find((u) => !isSendableImageUrl(u));
  if (bad) return { ok: false, error: `送れない画像のURLがあります（https で始まらない）: ${bad.slice(0, 60)}` };
  const all: LineMessage[] = urls.map(imageMessage);
  const t = (text ?? "").trim();
  if (t) all.push({ type: "text", text: t });
  const pushes: LineMessage[][] = [];
  for (let i = 0; i < all.length; i += LINE_PUSH_MAX_MESSAGES) pushes.push(all.slice(i, i + LINE_PUSH_MAX_MESSAGES));
  return { ok: true, pushes, imageCount: urls.length };
}
