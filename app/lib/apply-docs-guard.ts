// app/lib/apply-docs-guard.ts
// 2026-10-02 竹内さん「申込み時に必要なのは フォーマットと 本人確認書類の裏表写真（運転免許証またはマイナンバーカード）となる。
//   マイナンバーカードの場合は番号をマスキングするように ※で伝える」
//   YUMA の再生（procedure_11）で、返信の下書きが「申込に必要な書類」として 資格確認書・マイナポータル・顔写真・集合写真・携帯番号・戸籍謄本 を並べた。
//   出所: 申込の後に管理会社から個別に指示が来た別のお客様の送信（手本 ai_reply_examples・ナレッジ fa8ab604）と、その場面の会話の履歴。
//   申込に要るのは2つだけ（company-facts apply_docs）。他の書類は管理会社・保証会社から指示があった時だけスタッフが伝える。
//
// この関数: 返信の本文が、管理会社・保証会社の指示として書かれていないのに、申込の2つ以外の書類を求めているか。
//   使い道は2つ（どちらも本文は変えない）:
//   ・入口: 手本（isUsableExampleText）から外す＝他の会話の個別の指示を手本にしない（厳しくてよい）
//   ・出口: 自動送信の関所（canAutoReply）で止めて人に残す
//   線は scripts/audit-apply-docs-guard.ts（スタッフの手打ち・AI の下書きに当てて目で読む）
export const EXTRA_APPLY_DOC_RE =
  /戸籍(?:謄本|抄本)?|住民票|(?:健康)?保険証|資格確認書|医療保険|マイナポータル|顔写真|集合写真|(?:単体|全員|皆様分|入居者様?分)(?:の)?(?:お)?写真|収入証明|源泉徴収|課税証明|所得証明|給与明細|在籍証明|内定通知|印鑑証明|実印/;
/** 書類を求めている文の形（必要・ご準備・添付・お送り・ご提出） */
const DOC_REQUEST_RE = /必要|書類|ご準備|ご用意|添付|お送り|ご提出|ご返送/;
/** 管理会社・保証会社などからの個別の指示として書いている（スタッフが伝える正しい形） */
const FROM_THIRD_PARTY_RE = /管理会社|保証会社|オーナー|貸主|審査会社|大家/;
/** 申込の書類ではない場面（スタッフの実送信 365日の当たり 31通を目で読んで外した形）:
 *   連帯保証人の実印・印鑑証明（feedback_real_estate_rules）・法人契約のフォーマット・契約時／鍵の受け取りの書類 */
const OTHER_STAGE_RE = /連帯保証人|法人|契約時|契約書類|ご契約の際|鍵(?:の)?受け?取り/;

export type ExtraApplyDocHit = { word: string; line: string };

/** 申込の2つ以外の書類を（第三者の指示としてでなく）求めているか。無ければ null */
export function findExtraApplyDocs(body: string | null | undefined): ExtraApplyDocHit | null {
  const t = String(body ?? "");
  if (!t.trim() || FROM_THIRD_PARTY_RE.test(t) || OTHER_STAGE_RE.test(t)) return null;
  for (const line of t.split(/\n+/)) {
    const m = line.match(EXTRA_APPLY_DOC_RE);
    if (!m) continue;
    // パスポートの時の住民票は会社の事実（パスポート＋現住所記載の住民票）
    if (m[0] === "住民票" && /パスポート/.test(t)) continue;
    // 本人確認書類の写りの話（「免許証の顔写真部分」「パスポートの顔写真ページ」）は書類を足していない
    if (m[0] === "顔写真" && /顔写真(?:の)?(?:部分|ページ|面)/.test(line)) continue;
    if (!DOC_REQUEST_RE.test(t)) continue;
    return { word: m[0], line: line.trim() };
  }
  return null;
}
