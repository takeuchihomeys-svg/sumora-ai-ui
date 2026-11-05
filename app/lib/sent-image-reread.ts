// app/lib/sent-image-reread.ts — 送った資料の画像の読み直し待ち（2026-11-05 作業員1・案3'・竹内さんの決まり「読み取りは必ず DeepSeek」の中で）
//
// 11/05 11:40〜（JST）DeepSeek の残高切れ（402）で、送った資料の画像の読み取り（property_image_read）が失敗し、
//   sent-image-record が read:"failed"・sentProperties:"skipped" で捨てていた＝送った物件（sent_properties）が抜け、
//   ブレインの「送った物件・募集中を確認済み」と送り返しの照合が効かなくなった。
// 読み取りを Claude に倒すのは竹内さんの決まり（9/25「分析 DeepSeek で必ず行う。クロードに切り替えない」・KB e3b1e901）に反するので、
//   読めなかった送付は「読み直し待ち」とみなし、夜の cron（/api/cron/sent-image-reread）と次の送付の時に DeepSeek で読み直して記録を埋める。
// 読み直し待ち＝こちらが送った画像の通（sender=staff・image_url あり）のうち、sent_image_properties に行が無い物（新しい表は作らない）。
//   見積書・申込の書類など物件でない画像も行が無いので、AIX の種類で外す（見積書送る・申込の案内）。72時間まで（画像は期限で消える）。
// ⚠ LINE には何も送らない。書くのは sent_image_properties・sent_properties（元の送信の時刻で）と資料の中身の読み取りだけ。
//   既定 on（安全の線・止める SENT_IMAGE_REREAD=off）
export function sentImageRereadOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SENT_IMAGE_REREAD ?? "").trim().toLowerCase() !== "off";
}

export const REREAD_WINDOW_HOURS = 72;
/** 物件の資料でない画像を送る AIX（読んでも物件にならない＝毎晩読み直さない） */
const NOT_PROPERTY_AIX = /^(?:estimate_sheet|application_push|application_format|meeting_place|guarantor_info|cost_explain|cost_breakdown)$/;

export type RereadMsg = { id: string | number; conversation_id: string; created_at: string; image_url: string | null; is_aix_generated: boolean | null };
export type RereadAix = { conversation_id: string; created_at: string; aix_type: string | null };
export type RereadTarget = { imageUrl: string; conversationId: string; source: string; sentAt: string };

/**
 * 2026-11-06 弱い所 352: まとめて送った通は messages.image_url に URL の配列（JSON の文字列 '["https://…","https://…"]'）が入る。
 *   そのまま1つの URL として読ませると DeepSeek が 400「Unsupported image_url format」（11/06 の読み直しで2枚）。配列なら1枚ずつに分ける
 */
export function imageUrlsOf(raw: string | null | undefined): string[] {
  const t = String(raw ?? "").trim();
  if (!t) return [];
  if (t.startsWith("[")) {
    try { const a = JSON.parse(t); return Array.isArray(a) ? a.map((x) => String(x ?? "").trim()).filter((x) => /^https?:\/\//.test(x)) : []; } catch { return []; }
  }
  return /^https?:\/\//.test(t) ? [t] : [];
}
/** その画像の通の直前10分の AIX の種類（無ければ手で送った画像） */
export function sourceOfImage(m: RereadMsg, aix: ReadonlyArray<RereadAix>): string {
  if (!m.is_aix_generated) return "staff_image";
  const t = Date.parse(m.created_at);
  const hit = aix.filter((a) => a.conversation_id === m.conversation_id && a.aix_type && Date.parse(a.created_at) <= t + 60_000 && t - Date.parse(a.created_at) <= 10 * 60_000)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  return hit?.aix_type ? `aix:${hit.aix_type}` : "staff_image";
}

/** 読み直す送付を選ぶ（純関数）。recorded＝sent_image_properties に行がある画像の URL。skipConv＝試験の会話など */
export function pickRereadTargets(
  msgs: ReadonlyArray<RereadMsg>, recorded: ReadonlySet<string>, aix: ReadonlyArray<RereadAix>,
  o: { nowMs: number; windowHours?: number; limit?: number; skipConv?: (id: string) => boolean },
): RereadTarget[] {
  const since = o.nowMs - (o.windowHours ?? REREAD_WINDOW_HOURS) * 3600_000;
  const seen = new Set<string>();
  const out: RereadTarget[] = [];
  for (const m of [...msgs].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    if (Date.parse(m.created_at) < since) continue;
    if (o.skipConv?.(m.conversation_id)) continue;
    const source = sourceOfImage(m, aix);
    if (NOT_PROPERTY_AIX.test(source.replace(/^aix:/, ""))) continue;
    for (const url of imageUrlsOf(m.image_url)) {
      if (recorded.has(url) || seen.has(url)) continue;
      seen.add(url);
      out.push({ imageUrl: url, conversationId: m.conversation_id, source, sentAt: m.created_at });
      if (out.length >= (o.limit ?? 40)) return out;
    }
  }
  return out;
}
