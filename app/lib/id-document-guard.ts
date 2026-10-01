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

import { personalDocumentName, INCOME_DOCUMENT_TYPE } from "@/app/lib/personal-document-guard";
import { classifyCustomerImage, labeledImageText, splitLeakedTypeLine } from "@/app/lib/image-label";

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
  // 2026-10-01 竹内「画像が物件なのか物件以外なのか文字に出しておく」の監査で見つけた取りこぼし（other / 分類なしで全文が残っていた）:
  // ⑤ 免許証・保険証・マイナンバーカードの**裏面**（臓器提供の意思表示欄。裏書きの住所が載る）。実データ 6件・物件の画像 0件
  //   Vision が「臓器」を「脳死」と読み違えた形（「脳死提供に関する意思を表示」60955d16）も同じ欄
  (t) => /(臓器|脳死)提供/.test(t) && /(意思|心臓|眼球)/.test(t),
  // ⑥ 健康保険の資格確認書（保険証の代わり）。「資格確認書」＋保険の語（Vision は「资格」と簡体字で書くことがある＝実物 4332f29c）
  (t) => /[資资]格確認書/.test(t) && /(被保険者|保険者|資格を喪失|有効期限|有効期間)/.test(t),
  // ⑦ 韓国の住民登録（外国の身分証）
  (t) => /주민등록/.test(t),
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
 * 2026-09-26 竹内「収入証明書なども収入証明書とするだけで、文字おこししないようにする」:
 *   収入・勤め先・身元の証明書類（給与明細・源泉徴収票・雇用契約書・住民票 等）も書き起こしを捨てて
 *   「[画像] 収入証明書（給与明細）」「[画像] 住民票」のように種類だけにする（判定は personal-document-guard.ts）。
 *   本人確認書類を先に見る（「氏名：＋生年月日」の申込書は従来どおり本人確認書類）。
 */
export function imageTextForSave(imageType: string | null | undefined, content: string | null | undefined): string {
  const { type, content: t } = resolveTypeAndContent(imageType, content);
  if (isIdDocument(type, t)) return ID_DOCUMENT_TEXT;
  const doc = personalDocumentName(type, t);
  if (doc) return `[画像] ${doc}`;
  // 2026-10-01 竹内「送られてきた画像が物件なのか、物件以外なのか分かるためにも、画像分析したのを
  //   今ある本人確認書類のように文字に出しといたら、文やAIXでの判断の質が上がる」
  //   → それ以外の画像も先頭に見出し（【物件の資料】【物件以外：ペットの写真】【種類不明】…）を付ける（image-label.ts）
  return labeledImageText(classifyCustomerImage(type, t), t);
}

/**
 * 書き起こしの先頭に種類の行が残っている時（Vision が「TYPE:」を付けずに「id_document」とだけ返した＝旧の解析が other にした）は、
 * その種類を採って行を外す。分類が other / 空の時だけ（Vision が正しく分けた物は変えない）。
 */
function resolveTypeAndContent(imageType: string | null | undefined, content: string | null | undefined): { type: string; content: string } {
  const given = (imageType ?? "").trim().toLowerCase();
  const { leakedType, content: rest } = splitLeakedTypeLine(content);
  if (!leakedType) return { type: given, content: rest };
  return { type: given && given !== "other" ? given : leakedType, content: rest };
}

/**
 * 保存する image_type。中身の指紋で身分証と分かったら、type が空でも id_document を立てる。
 * （received-document / brain-core がこの列を見て「本人確認書類が届いた」と判断するため）
 */
export function imageTypeForSave(imageType: string | null | undefined, content: string | null | undefined): string {
  const r = resolveTypeAndContent(imageType, content);
  const given = r.type;
  content = r.content;
  if (given === "id_document") return given;
  if (isIdDocument(given, content)) return "id_document";
  // 収入・身元の証明書類は income_document（実データの給与明細6件は Vision が estimate＝見積書と分類していた。
  //   見積書のままだと「見積書が届いた」とブレインに伝わる）
  if (personalDocumentName(given, content)) return INCOME_DOCUMENT_TYPE;
  return given;
}
