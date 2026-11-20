// app/lib/sent-image-aix-attribute.ts — AIX で送った画像のうち、読み取りで物件が分からなかった物（室内写真など）を、
//   同じ時に記録された AIX の物件名（aix_usage_logs.property_names が1件だけの時）に結び付ける（純関数・DB/LLM なし）。
//
// 2026-11-21 作業員G（#448・画像の把握の表 O4/O5・竹内さん 11/21「画像の把握の部分を細かく」）:
//   60日でお客様がこちらの画像を引用した 106通のうち 26通（25%）は、その画像の記録（sent_image_properties・image_details）が無く、
//   ブレインはどの物件の写真かを知らずに返していた。多くは AIX【物件確認した】の室内写真（文字が無く読み取りで物件名が取れない）。
//   AIX の記録には送った物件名が残っている（1件だけの時はその物件の写真）。
//   線（60日・読み取りで物件が分かっている AIX の画像 344枚に当てた）: 同じ物件 310・表記ゆれ 約25・別の物件 約5（2件の物件を送った AIX の近くの手で送った画像・
//   棟違い・物件名の欄に説明文）。→ AIX から送った画像（source=aix:<種類>）で、その種類の AIX の記録が前後5分に1件だけ・物件名が1件・名前の形の時だけ結ぶ。
//   手で送った画像（staff_image）・物件が2件以上の AIX は結ばない（どの物件の写真か分からない）。
//   記録は source=aix_log:<種類>（読み取りで照合した物と分ける）。既定 off（SENT_IMAGE_AIX_ATTRIBUTE=on）

type Env = Record<string, string | undefined>;
export function sentImageAixAttributeOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SENT_IMAGE_AIX_ATTRIBUTE ?? "").trim().toLowerCase() === "on";
}
export const AIX_ATTRIBUTE_WINDOW_MS = 5 * 60_000;

/** generated_text: AIX の本文（ある時は、物件名が本文に出ている時だけ結ぶ＝確かめられない結び先は作らない） */
export type AixLogForAttr = { aix_type: string | null; property_names: string[] | null; sent_at: string | null; created_at: string; generated_text?: string | null };

/** 物件名の欄の値が物件名の形か（説明文・箇条書きは外す） */
export function looksLikePropertyName(s: string): boolean {
  const t = s.normalize("NFKC").trim();
  if (t.length < 2 || t.length > 50) return false;
  if (/^[-・*•]/.test(t) || /画像|送付|資料|情報|詳細|含む|写真/.test(t)) return false;
  return true;
}
/** 「エスタート御幣島 308号室」→ 名前と号室 */
export function splitNameRoom(s: string): { name: string; room: string | null } {
  // 「〇〇 0」「〇〇 0号室」（号室の無い物件の記録）は号室の欄を外す
  const t = s.normalize("NFKC").trim().replace(/\s+0+\s*(?:号室?)?$/, "");
  const m = t.match(/^(.*?)\s*([0-9]{2,5}[A-Za-z]?)\s*号室?$/);
  if (m && m[1].trim().length >= 2) {
    const r = m[2].replace(/^0+(?=\d)/, "");
    // 「00号室」（号室の無い物件の記録・60日で4件）は号室なし
    return { name: m[1].trim(), room: /^0+$/.test(r) ? null : r };
  }
  return { name: t, room: null };
}

/**
 * 送った画像1枚 → 結べる物件（無ければ null）。
 * source は送った時の記録の出所（"aix:property_check_result" 等）。sentAtMs は送った時刻。
 */
export function pickAixProperty(source: string, sentAtMs: number, logs: ReadonlyArray<AixLogForAttr>): { name: string; room: string | null; aixType: string } | null {
  const m = String(source ?? "").match(/^aix:([a-z_]+)$/);
  if (!m || !Number.isFinite(sentAtMs)) return null;
  const type = m[1];
  const near = logs.filter((l) => Math.abs(Date.parse(l.sent_at ?? l.created_at) - sentAtMs) <= AIX_ATTRIBUTE_WINDOW_MS);
  // 前後5分の AIX の記録が1件だけ（2件以上は、どの送信の画像か分からない）・種類が同じ
  if (near.length !== 1 || near[0].aix_type !== type) return null;
  const names = (near[0].property_names ?? []).filter((n) => typeof n === "string" && n.trim());
  if (names.length !== 1 || !looksLikePropertyName(names[0])) return null;
  const nr = splitNameRoom(names[0]);
  // 2026-11-21 60日の 197枚を目で読んだ時、AIX の本文に物件名が出ていない 7枚は結び先を確かめられなかった＝本文がある時は名前が出ている時だけ結ぶ
  const body = near[0].generated_text;
  if (typeof body === "string" && body.trim()) {
    const key = nr.name.normalize("NFKC").replace(/s+/g, "").slice(0, 6);
    if (!body.normalize("NFKC").replace(/s+/g, "").includes(key)) return null;
  }
  return { ...nr, aixType: type };
}
