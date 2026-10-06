// app/lib/quote-preview.ts
// 引用返信の「引用の枠」に出す中身を決める純関数（DB を触らない・画面とサーバーの両方から使える）。
//
// 2026-10-07 竹内（Ryoichi kiritsuke・スモラ）: お客様が物件資料の画像を引用して「ここと」「ここを見に行きたいです」と返したのに、
//   アプリには「↩ [引用] [画像]」としか出なかった。
//   「何で引用されていないのか 引用画像と 分かりやすいように物件名が分かれば表示する形とする。
//    そうすれば返信の際より正確に返信できるのと確認もできるため」「実際のLINEのように画像分かるように」
//   原因は DB ではなく画面: 引用先（messages.line_message_id）も画像（image_url・Storage は 200）も、
//   どの物件か（sent_image_properties: リヴィエール桜之町東 102／アトリエール堺寺地町 103）も揃っていたのに、
//   描画が「画像なら "[画像]" の文字」を出すだけで、サムネイルも物件名も出していなかった。
//   → LINE アプリと同じ「送った人／写真＋小さなサムネイル」に、分かる時だけ物件名（送った時の記録＝推測しない）を足す。
import { LINE_ACCOUNT_LABELS, normalizeLineAccountKey } from "@/app/lib/line-accounts";

/** 引用先のメッセージ（messages の1行から必要な所だけ） */
export type QuotedSource = {
  sender: string | null;
  text: string | null;
  imageUrl: string | null;
  /** お客様が送った画像の保存期限（過ぎると Storage から消える） */
  imageExpiresAt?: string | null;
  /** 引用先の画像がどの物件の資料か（sent_image_properties / sent_properties の記録）。分からなければ null */
  propertyLabel?: string | null;
};

export type QuotePreview = {
  /** 枠の1行目（LINE と同じ「誰の発言か」）: スモラ／お客様の表示名 */
  who: string;
  kind: "image" | "video" | "text" | "missing";
  /** 枠の左に出す小さな画像（無い・期限切れなら null） */
  thumbUrl: string | null;
  /** 枠の2行目: 写真／動画／本文の頭 */
  snippet: string;
  /** どの物件の資料か（決定論で分かった時だけ） */
  propertyLabel: string | null;
  /** 画像のはずだが見られない（保存期限切れ・URL 無し） */
  imageGone: boolean;
};

/** 「アトリエール堺寺地町」「103」→「アトリエール堺寺地町 103号室」（号室の頭の0は外す）。名前が無ければ null */
export function propertyLabelOf(name: string | null | undefined, roomNo: string | null | undefined): string | null {
  const n = (name ?? "").trim();
  if (!n) return null;
  const r = (roomNo ?? "").trim().replace(/^0+(?=\d)/, "");
  return r ? `${n} ${/号室$/.test(r) ? r : `${r}号室`}` : n;
}

/**
 * 送った画像の記録の行（sent_image_properties → sent_properties の順に並べて渡す）→ 画像 URL ごとの物件名。
 * 先に来た行が勝つ（sent_image_properties は画像1枚ずつの記録なので、束の代表の sent_properties より確か）。
 */
export function labelsFromSentRows(rows: Array<{ image_url: string | null; property_name: string | null; room_no: string | null }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    if (!r.image_url || out.has(r.image_url)) continue;
    const l = propertyLabelOf(r.property_name, r.room_no);
    if (l) out.set(r.image_url, l);
  }
  return out;
}

/** 本文が「[画像]」「[動画]」だけ＝中身の文字が無い画像 */
export function isMediaPlaceholder(text: string | null | undefined): boolean {
  return !text || /^\s*\[(?:画像|動画)\]\s*$/.test(text);
}

const VIDEO_RE = /\.(mp4|mov|m4v|webm)(\?|$)/i;

/** 引用の枠の中身。引用先が読めていない（古い・別の会話）時は kind=missing */
export function buildQuotePreview(
  src: QuotedSource | null | undefined,
  opts: { account?: string | null; customerName?: string | null; now?: number } = {},
): QuotePreview {
  if (!src) return { who: "", kind: "missing", thumbUrl: null, snippet: "メッセージを参照", propertyLabel: null, imageGone: false };
  const acct = normalizeLineAccountKey(opts.account ?? null);
  const who = src.sender === "customer"
    ? ((opts.customerName ?? "").trim() || "お客様")
    : (acct ? LINE_ACCOUNT_LABELS[acct] : "スタッフ");
  const text = src.text ?? "";
  const isVideoText = /^\s*\[動画\]/.test(text);
  const isImageText = /^\s*\[画像\]/.test(text);
  const looksMedia = !!src.imageUrl || isImageText || isVideoText;
  const label = (src.propertyLabel ?? "").trim() || null;
  if (looksMedia) {
    const now = opts.now ?? Date.now();
    const expired = !!src.imageExpiresAt && Date.parse(src.imageExpiresAt) < now;
    const isVideo = isVideoText || (!!src.imageUrl && VIDEO_RE.test(src.imageUrl));
    const thumbUrl = src.imageUrl && !expired && !isVideo ? src.imageUrl : null;
    // お客様が送った画像は本文が「[画像] <書き起こし>」。書き起こしはお客様の発言ではないので枠には出さない（写真とだけ出す）
    return {
      who,
      kind: isVideo ? "video" : "image",
      thumbUrl,
      snippet: isVideo ? "動画" : "写真",
      propertyLabel: label,
      imageGone: !isVideo && !thumbUrl,
    };
  }
  const oneLine = text.replace(/\s+/g, " ").trim();
  return {
    who,
    kind: "text",
    thumbUrl: null,
    snippet: oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine || "（本文なし）",
    propertyLabel: label,
    imageGone: false,
  };
}
