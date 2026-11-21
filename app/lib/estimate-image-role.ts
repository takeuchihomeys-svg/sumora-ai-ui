// app/lib/estimate-image-role.ts — 送る画像のうち「見積書」の画像に役目（image_details.kind='estimate'）を先に付ける（純関数・既定 off）
//
// 2026-11-19 作業員H（統括役の頼み・画像の記録の①「こちらが送った画像1枚ずつに役目」）:
//   直近30日にこちらが送った画像 1,117枚のうち、役目（image_details）も物件（sent_image_properties）も無い物が AIX 179枚。
//   そのうち 89枚は【物件確認した】の見積書の同封・8枚は【見積書送る】＝送った後の読み取り（ensureImageDetail）が失敗するか、
//   申込の線の手前で読まない時は行を作らない決まり（読み直せるように）なので、見積書だと分かっていても役目が残らなかった。
//   AIX の生成（/api/aix/action）は見積書の画像の URL（estimate_image_urls・estimate_image_url）を受け取っている。
//   AixModal の uploadImageCached は File ごとに URL を控える（モーダルが開いている間・会話が同じ間）＝生成の時の URL と送った URL は同じ
//   （送る時も同じ uploadImageCached → onSendImages → sendImagesBatch → send-line-message の image_urls にそのまま）。
//   ファイルを差し替えた・モーダルを開き直した時は URL が変わる → 先に書いた行は使われないだけ（送った画像は今まで通り読む）。
//   既にある見積書の行（201行）は全部 lines が空＝読み取りと同じ中身（kind だけ）。先に書けば送った後の DeepSeek の読み取りも呼ばない。
//   ⚠ こちらがこの会話のためにアップロードした画像（property-images/aix/<会話>/）だけ。会話の中の画像の URL（お客様の画像が混ざる・初期費用について）は書かない
//   2026-11-19 既定 on（統括役の了承: 文に触れない記録。YUMA で route と同じ関数・同じ upsert を当て、kind=estimate・lines 空で入り、
//   お客様の画像の URL は外れ、既にある行は触らず、後片付けで0行を確かめた）。止める: AIX_ESTIMATE_IMAGE_ROLE=off
import { imageDetailPartOn } from "./image-detail-part";
export function estimateImageRoleOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.AIX_ESTIMATE_IMAGE_ROLE ?? "").trim().toLowerCase() !== "off";
}

/** 生成の要求から、見積書の役目を付けてよい画像の URL（こちらがこの会話のためにアップロードした物だけ・重複なし・最大10） */
export function estimateRoleUrls(body: { estimate_image_urls?: unknown; estimate_image_url?: unknown }, conversationId: string | null | undefined): string[] {
  const conv = String(conversationId ?? "").trim();
  if (!conv) return [];
  const raw: unknown[] = [...(Array.isArray(body.estimate_image_urls) ? body.estimate_image_urls : []), body.estimate_image_url];
  const mark = `/property-images/aix/${conv}/`;
  const out: string[] = [];
  for (const u of raw) {
    if (typeof u !== "string") continue;
    const s = u.trim();
    if (!/^https:\/\//.test(s) || !s.includes(mark) || out.includes(s)) continue;
    out.push(s);
    if (out.length >= 10) break;
  }
  return out;
}

/** image_details に書く行（kind だけ・lines は空＝既存の見積書の行と同じ形） */
export function estimateRoleRows(urls: ReadonlyArray<string>, conversationId: string, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): Array<{ image_url: string; conversation_id: string; kind: "estimate"; lines: string[]; model: string; part?: "cost" }> {
  // 2026-11-22 作業員K2（#287・IMAGE_DETAIL_PART=on の時だけ・既定 off）: 部分の列（image_details.part・11/22 の DDL・null 可）に cost を入れる
  const withPart = imageDetailPartOn(env);
  return urls.map((image_url) => ({ image_url, conversation_id: conversationId, kind: "estimate" as const, lines: [], model: "role:aix-estimate", ...(withPart ? { part: "cost" as const } : {}) }));
}
