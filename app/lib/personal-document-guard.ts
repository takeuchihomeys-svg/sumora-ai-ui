// app/lib/personal-document-guard.ts
// 収入・勤め先・身元の証明書類（源泉徴収票・給与明細・課税証明書・雇用契約書・住民票 等）の画像を、
// **書き起こさずに「収入証明書（源泉徴収票）」のように種類だけ記録する**ための判定。純関数・DB 依存なし。
//
// 2026-09-26 竹内「収入証明書なども収入証明書とするだけで、文字おこししないようにする」
//   先行: id-document-guard.ts（2026-09-19・本人確認書類は「本人確認書類」とだけ残す）と同じ形。
//   line-webhook が受信画像を Vision で全文書き起こしして messages.text="[画像] <全文>" で保存していたため、
//   給与明細の氏名・勤務先・支給額・控除額がそのまま会話本文（返信生成・学習の材料）に入っていた。
//   保存する**前**に捨てる（後段でマスクすると経路が増えるたびに取りこぼす）。
//
// 【判定は2本（fail-closed）】
//   ① Vision の分類 TYPE=income_document（line-webhook の Vision 指示に足した）
//   ② 中身の指紋（分類は外れる。実データでは給与明細6件が全部 TYPE=estimate＝見積書と分類されていた）
//   どちらかに当たれば捨てる。
//
// 【実データでの線（2026-09-26・お客様の画像 912件＝[画像] で始まる行・2026-06-06〜）】
//   当たる: 給与明細 6件（分類は estimate 6）・雇用契約書兼労働条件通知書 1件（other）・辞令 1件（other）・
//           火災保険の契約者票（氏名・生年月日・携帯）1件（other）＝ 計 9件
//   誤爆: 間取り図 114・物件写真 92・見積書（本物の見積書）18・その他の物件資料/スクショ → **0件**
//   ⚠ 誤爆しかけた形（指紋を2語以上の組にした理由）:
//     ・物件資料の必要書類欄「身分証・収入証明 連帯保証人様：印鑑証明書」→ 書類名だけでは当てない
//     ・条件のスクショ「普通預金の残高N万円以上」→ 通帳は取引の欄（お預り金額・差引残高 等）が要る
//     ・見積書の「年金」「給与」→ 給与明細は「控除」＋社会保険の語＋支給の語の3つ組
//     ・口座振替の案内・振込先口座のスクショ → 通帳にしない

/** Vision の分類で収入・身元の証明書類を表す値（line-webhook の TYPE と同じ） */
export const INCOME_DOCUMENT_TYPE = "income_document";

/** 種類が決められない時に残す名前 */
export const INCOME_DOCUMENT_LABEL = "収入証明書";

/** 語の一覧のうち、いくつが本文に出ているか（書類の「欄」の語を数える＝書類の名前が出ているだけの依頼文を落とす） */
function fields(t: string, words: readonly string[]): number {
  return words.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
}

/** 実際の値（電話番号・生年月日の数字）が書いてあるか＝空の申込フォーマット・依頼文ではない */
const HAS_PHONE = /0[5789]0[-‐－ー\s]?\d{4}[-‐－ー\s]?\d{4}/;
const HAS_BIRTH = /(?:19|20)\d{2}\s*[年./\-]\s*\d{1,2}|(?:昭和|平成|令和)\s*\d{1,2}\s*年/;

/**
 * 書類の種類と中身の指紋。label は received-document の DOCUMENT_KINDS のラベルとそろえる
 * （保存した本文 "[画像] 収入証明書（給与明細）" から received-document が種類を読み戻すため）。
 * income=true の物は「収入証明書（…）」、false の物は種類の名前だけで残す。
 * 上から順に見る（先に当たった物を採る）。
 *
 * ⚠ 書類の名前だけでは当てない。LINE のスクショを書き起こすと、スタッフの依頼文
 *   「内定通知書に労働条件や給与額も記載ございます」「給与明細に記載されている支給実績」が入る。
 *   会話本文（画像でない 358件）に当てて、依頼文・記入済みフォームで誤爆しない所まで欄の語を足した（2026-09-26）。
 */
const KINDS: ReadonlyArray<{ label: string; income: boolean; test: (t: string) => boolean }> = [
  { label: "源泉徴収票", income: true,
    test: (t) => /源泉徴収票/.test(t) && fields(t, ["支払金額", "給与所得控除後の金額", "所得控除の額の合計額", "源泉徴収税額", "支払を受ける者"]) >= 2 },
  { label: "年金の通知書", income: true,
    test: (t) => /(年金額改定通知書|年金振込通知書|年金決定通知書|年金証書|公的年金等の源泉徴収票)/.test(t) && fields(t, ["基礎年金番号", "年金コード", "支払額", "振込額", "受取金融機関"]) >= 1 },
  { label: "給与明細", income: true,
    test: (t) =>
      (/(給与|給料|賞与).{0,4}明細/.test(t) && /控除/.test(t) && /支給/.test(t)) ||
      (/控除/.test(t) && /(健康保険|厚生年金|雇用保険)/.test(t) && /(基本給|支給額|差引支給)/.test(t)) },
  { label: "課税証明書", income: true,
    test: (t) =>
      (/(課税|所得|非課税)[・（(]?(?:所得|課税)?[）)]?証明書/.test(t) && fields(t, ["所得金額", "総所得", "給与収入", "合計所得", "所得控除"]) >= 2) ||
      (/特別徴収税額.{0,3}(決定|変更)通知書/.test(t) && fields(t, ["給与収入", "所得控除", "税額", "特別徴収義務者"]) >= 2) },
  { label: "確定申告書", income: true,
    test: (t) => /(確定申告書|所得税及び復興特別所得税の申告書)/.test(t) && fields(t, ["収入金額等", "所得金額等", "課税される所得金額", "第一表", "納める税金"]) >= 2 },
  { label: "在籍証明書", income: true,
    test: (t) => /(在籍|在職)証明書/.test(t) && /(上記の者|右の者|(在籍|在職)していることを証明|相違ないことを証明)/.test(t) },
  { label: "内定通知書", income: true,
    test: (t) => /(内定通知書|採用通知書|採用内定)/.test(t) && /(貴殿|内定(?:いた|致)し|採用(?:いた|致)し|採用することに決定|入社(?:予定)?日)/.test(t) },
  { label: "労働条件通知書", income: true,
    test: (t) => /労働条件通知書/.test(t) && fields(t, ["契約期間", "就業の場所", "始業", "終業", "休日", "賃金", "基本給"]) >= 3 },
  { label: "雇用契約書", income: true,
    test: (t) => /雇用契約書/.test(t) && fields(t, ["契約期間", "就業の場所", "始業", "終業", "休日", "賃金", "基本給"]) >= 3 },
  { label: "辞令", income: true,
    test: (t) => /辞\s*令/.test(t) && /発令/.test(t) && /(異動|を命ず|を命じる)/.test(t) },
  { label: "通帳", income: true,
    test: (t) => /(普通預金|総合口座|通帳)/.test(t) && fields(t, ["お預り金額", "お預かり金額", "お支払金額", "お引出し", "お預入れ", "差引残高"]) >= 2 },
  // 申込書（入居・保証・火災保険）: 本人の項目の組（氏名＋生年月日＋連絡先）＋**実際の値**（電話番号か生年月日の数字）。
  //   「氏名：＋生年月日」の形は id-document-guard が先に本人確認書類として捨てる。ここはコロンの無い表の形
  //   （「氏名（被保険者）」「生年月日」「携帯」が別の行）を拾う。値の無い空のフォーマット・依頼文は当てない。
  //   住民票より先に見る（記入済みフォームの「現住所（住民票記載）」「続柄」で住民票にしない）
  { label: "申込書", income: false,
    test: (t) => /(氏名|お名前)/.test(t) && /生年月日/.test(t) && /(携帯|電話番号|TEL|勤務先)/i.test(t)
      && /(申込|契約者|被保険者|入居者)/.test(t) && (HAS_PHONE.test(t) || HAS_BIRTH.test(t)) },
  { label: "住民票", income: false,
    test: (t) => /住民票/.test(t) && /世帯主/.test(t) && fields(t, ["本籍", "住民となった", "住定", "前住所", "転入", "続柄"]) >= 2 },
  { label: "印鑑登録証明書", income: false,
    test: (t) => /印鑑登録証明書/.test(t) && /(登録番号|この写しは)/.test(t) && /生年月日/.test(t) },
];

/** 種類の名前（テストで received-document の DOCUMENT_KINDS とそろっているか確かめる） */
export const PERSONAL_DOCUMENT_LABELS: readonly string[] = [INCOME_DOCUMENT_LABEL, ...KINDS.map((k) => k.label)];

/** 保存する本文の名前（"収入証明書（給与明細）" ／ "住民票"） */
function savedName(k: { label: string; income: boolean } | null): string {
  if (!k) return INCOME_DOCUMENT_LABEL;
  return k.income ? `${INCOME_DOCUMENT_LABEL}（${k.label}）` : k.label;
}

/** 中身から種類を決める（当たらなければ null） */
export function classifyPersonalDocument(content: string | null | undefined): string | null {
  const t = (content ?? "").trim();
  if (!t) return null;
  for (const k of KINDS) if (k.test(t)) return k.label;
  return null;
}

/** この画像は収入・身元の証明書類か（分類 or 中身の指紋） */
export function isPersonalDocument(imageType: string | null | undefined, content: string | null | undefined): boolean {
  if ((imageType ?? "").trim().toLowerCase() === INCOME_DOCUMENT_TYPE) return true;
  return classifyPersonalDocument(content) !== null;
}

/**
 * 保存する本文の名前（"[画像] " を除いた部分）。収入・身元の書類でなければ null。
 * 分類だけ income_document で中身から種類が決まらない時は「収入証明書」。
 */
export function personalDocumentName(imageType: string | null | undefined, content: string | null | undefined): string | null {
  if (!isPersonalDocument(imageType, content)) return null;
  const label = classifyPersonalDocument(content);
  return savedName(label ? KINDS.find((k) => k.label === label) ?? null : null);
}

/**
 * 保存済みの本文（"[画像] 収入証明書（給与明細）" ／ "[画像] 収入証明書" ／ "[画像] 住民票"）から種類を読み戻す。
 * この形**そのもの**の時だけ返す（書き起こしの途中に「収入証明」と書いてある物件資料を書類にしない）。
 */
export function savedPersonalDocumentLabel(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  const m = t.match(/^\[画像\]\s*(.+)$/);
  if (!m) return null;
  const body = m[1].trim();
  const inner = body.match(new RegExp(`^${INCOME_DOCUMENT_LABEL}(?:（(.+)）)?$`));
  if (inner) return inner[1] && KINDS.some((k) => k.label === inner[1]) ? inner[1] : INCOME_DOCUMENT_LABEL;
  return KINDS.some((k) => !k.income && k.label === body) ? body : null;
}
