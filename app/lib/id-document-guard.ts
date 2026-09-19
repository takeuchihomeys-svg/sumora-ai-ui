// app/lib/id-document-guard.ts
// 本人確認書類（免許証・マイナンバーカード・保険証・パスポート等）の画像を、
// **書き起こさずに「本人確認書類」とだけ記録する**ための判定。
//
// 2026-09-19 竹内「マイナンバーカードや運転免許証の個人情報は本人確認書類とだけ文字にして
//   情報が文字お越しされないようにする」
//
// 【なぜ入口で止めるのか】
//   line-webhook が受信画像を Vision で「写っているテキストをすべて書き起こし」して
//   messages.text = "[画像] <全文>" として保存していた。これが会話本文なので、
//   返信生成のプロンプト（直近20〜25件）にも、学習の事例にも、そのまま載っていた。
//   後段でマスクする形だと経路が増えるたびに取りこぼす。保存する前に捨てるのが一番確実。
//   （設計知見「止めるなら入口（保存する前）で止める。保存してしまうと入力欄・自動返信・学習データの全部に広がる」）
//
// 【捨てても何も壊れない】
//   ・received-document.ts:115-116 が image_type==='id_document' なら本文なしで「本人確認書類」を返す
//   ・brain-core.ts の IMAGE_TYPE_LABEL にも id_document:'本人確認書類' がある
//   つまり「書類が届いた」という事実は image_type だけで伝わる。書き起こしは元々余計だった。
//
// 【Vision の分類を信用しきらない（fail-closed）】
//   1回の Vision 呼び出しで「TYPE: ...」＋書き起こしを返させているが、TYPE は外れることがある。
//   実データ（画像5,082件）で image_type が NULL/other の中に本物の身分証が7件あった。
//   そこで type が id_document でなくても、**中身の指紋**に当たれば捨てる。

/** 会話本文に残す文字列（これだけ。中身は残さない） */
export const ID_DOCUMENT_LABEL = "本人確認書類";
export const ID_DOCUMENT_TEXT = `[画像] ${ID_DOCUMENT_LABEL}`;

/**
 * 身分証の「指紋」。2026-09-19 に実データ（[画像] で始まる 5,082 件）で誤爆を確かめて確定。
 *   間取り図 98件 → 0 / 物件写真 80件 → 0 / 見積書 17件 → 0
 *   id_document 60件 → 30（残りは書き起こしが空・短い物）
 *   分類なし 4,736件 → 6（**全部が本物の身分証**。分類が入る前のデータ）
 *   その他 91件 → 1（入居申込書。個人情報の塊なので捨ててよい）
 *
 * ⚠ 「交付：」「有効期限」は単独では使わない。間取り図（広告の有効期限）に当たるため。
 */
const FINGERPRINTS: ReadonlyArray<(t: string) => boolean> = [
  // ① 氏名のラベル＋生年月日（免許証・保険証・在留カードの書き起こしの形）
  (t) => /氏名\s*[:：]/.test(t) && /(生年月日|年\s*\d{1,2}\s*月\s*\d{1,2}\s*日生)/.test(t),
  // ② マイナンバーカード裏面の定型文（「マイナンバー」単体は使わない＝こちらの注意文に当たる）
  (t) => /マイナンバー総合フリーダイヤル/.test(t),
  // ③ 運転免許証の発行者
  (t) => /公安委員会/.test(t),
  // ④ 書類の名前＋本人の項目（名前だけだと「本人確認書類をお送りください」という依頼文に当たる）
  (t) => /(運転免許証|健康保険証|在留カード|住民基本台帳|パスポート)/.test(t) && /(氏名|生年月日|住所)/.test(t),
];

/** この画像の書き起こしは本人確認書類か（type が外れていても中身で拾う） */
export function isIdDocument(imageType: string | null | undefined, content: string | null | undefined): boolean {
  if ((imageType ?? "").trim().toLowerCase() === "id_document") return true;
  const t = (content ?? "").trim();
  if (!t) return false;
  return FINGERPRINTS.some((f) => f(t));
}

/**
 * messages.text に保存する文字列を決める。
 * 本人確認書類なら書き起こしを捨てて「[画像] 本人確認書類」だけにする。
 */
export function imageTextForSave(imageType: string | null | undefined, content: string | null | undefined): string {
  const t = (content ?? "").trim();
  if (isIdDocument(imageType, t)) return ID_DOCUMENT_TEXT;
  return t ? `[画像] ${t}` : "[画像]";
}

/**
 * 保存する image_type。中身の指紋で身分証と分かったら、type が空でも id_document を立てる。
 * （received-document / brain-core がこの列を見て「本人確認書類が届いた」と判断するため）
 */
export function imageTypeForSave(imageType: string | null | undefined, content: string | null | undefined): string {
  const given = (imageType ?? "").trim().toLowerCase();
  if (given === "id_document") return given;
  if (isIdDocument(given, content)) return "id_document";
  return given;
}
