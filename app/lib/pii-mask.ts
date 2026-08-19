/**
 * pii-mask.ts
 *
 * Anthropic API に送信する前に、日本語の顧客PII（個人を特定できる情報）を
 * テキストからマスクするユーティリティ。
 *
 * マスク対象:
 * - 顧客名（knownNames の完全一致 + 敬称パターン 〇〇様/さん）→「お客様」
 * - 申込情報（氏名/年収/住所/保証人/緊急連絡先/勤務先 等のラベル付き値）
 *   → ラベルは残し、値を「[回答済み・非表示]」に置換
 * - 入居希望日 → 月精度に丸める（例: 9月15日 → 9月中）
 * - 電話番号 / 郵便番号 / メールアドレス
 *
 * マスクしないもの（分析に必要）:
 * - 会話フロー情報・フェーズラベル・AIXアクション名・物件名・家賃・間取り
 */

/** 敬称パターンにマッチしても置換してはいけない安全な語 */
const SAFE_HONORIFIC_WORDS: string[] = [
  'お客様',
  '皆様',
  '皆さん',
  '様々',
  '奥様',
  '神様',
  '大家さん',
  '業者さん',
  '管理会社さん',
  'オーナー様',
  'お疲れ様',
];

/** 申込情報のラベル（値をマスクする対象） */
const APP_LABELS: string[] = [
  '氏名',
  'お名前',
  '名前',
  'フリガナ',
  'ふりがな',
  '年収',
  '収入',
  '月収',
  '給与',
  '現住所',
  '住所',
  '連帯保証人',
  '保証人',
  '緊急連絡先',
  '勤務先',
  '勤め先',
  '会社名',
  '職場',
  '生年月日',
  '誕生日',
  '年齢',
  '電話番号',
  'メールアドレス',
];

/**
 * ラベル + コロン + 値 のパターン。
 * 値は改行・読点・句点・区切り記号の手前まで。
 */
const APP_LABEL_REGEX = new RegExp(
  `(${APP_LABELS.join('|')})([:：]\\s*)([^\\n、。｜|】\\]]+)`,
  'g'
);

/** 敬称パターン: (漢字1〜4字 または カナ2〜6字) + (様|さま|さん) */
const HONORIFIC_REGEX = /(?:[一-龯々]{1,4}|[ァ-ヶー]{2,6})(?:様|さま|さん)/g;

/** 電話番号（ハイフン区切り: 03-1234-5678, 090-1234-5678 など） */
const PHONE_HYPHEN_REGEX = /0\d{1,4}[-‐−ー]\d{1,4}[-‐−ー]\d{3,4}(?!\d)/g;

/** 電話番号（ハイフンなし10〜11桁） */
const PHONE_PLAIN_REGEX = /(?<!\d)0\d{9,10}(?!\d)/g;

/** 郵便番号（〒123-4567 / 123-4567） */
const POSTAL_REGEX = /〒\s*\d{3}[-‐−ー]?\d{4}(?!\d)|(?<![\d-‐−ー])\d{3}[-‐−ー]\d{4}(?![\d-‐−ー])/g;

/** メールアドレス */
const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** 日付を月精度に丸める（9月15日 → 9月中） */
const DAY_DATE_REGEX = /([1-9]|1[0-2])月\s*([1-9]|[12]\d|3[01])日/g;

/**
 * 敬称マッチが SAFE ワードの一部かどうかを判定する。
 * 例: "客様" にマッチしても直前が "お" なら "お客様" なので置換しない。
 */
function isSafeHonorific(match: string, offset: number, fullText: string): boolean {
  for (const safe of SAFE_HONORIFIC_WORDS) {
    // マッチ自体が安全語、または安全語で終わる（例: 管理会社さん）
    if (match === safe || match.endsWith(safe)) {
      return true;
    }
    // 安全語の末尾部分にマッチしている（例: "お客様" の "客様" 部分）
    if (safe.endsWith(match)) {
      const start = offset - (safe.length - match.length);
      if (start >= 0 && fullText.slice(start, offset + match.length) === safe) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 「お客様様」「お客様さん」「お客様お客様」等の重複を正規化する。
 */
function normalizeMaskedHonorifics(text: string): string {
  let result = text;
  // 連続置換で生まれた重複を収束するまで畳む（例: お客様お客様様）
  let prev: string;
  do {
    prev = result;
    result = result.replace(/お客様(?:様|さま|さん)/g, 'お客様');
    result = result.replace(/お客様(?:お客様)+/g, 'お客様');
  } while (result !== prev);
  return result;
}

/**
 * 日本語の顧客PIIをマスクする。
 *
 * @param text マスク対象のテキスト
 * @param knownNames 既知の顧客名リスト（null/undefined 混入可）。
 *                   2文字以上の名前を完全一致で「お客様」に置換する。
 *                   スペース区切りの姓・名も個別に置換する。
 * @returns マスク済みテキスト
 */
export function maskPII(text: string, knownNames?: (string | null | undefined)[]): string {
  if (!text) return text;

  let result = text;

  // --- 1. 既知の顧客名を完全一致で置換 ---
  if (knownNames && knownNames.length > 0) {
    const nameParts = new Set<string>();
    for (const name of knownNames) {
      if (!name) continue;
      const trimmed = name.trim();
      if (trimmed.length >= 2) {
        nameParts.add(trimmed);
      }
      // 半角・全角スペースで分割した各パーツも対象（姓のみ・名のみの言及に対応）
      for (const part of trimmed.split(/[\s　]+/)) {
        if (part.length >= 2) {
          nameParts.add(part);
        }
      }
    }
    // 長い名前から先に置換（部分文字列の先食い防止）
    const sorted = Array.from(nameParts).sort((a, b) => b.length - a.length);
    for (const part of sorted) {
      result = result.split(part).join('お客様');
    }
    // 姓・名の連続置換や既存敬称との組み合わせで生まれた重複を正規化
    // （例: 田中太郎様 → お客様お客様様 → お客様）
    result = normalizeMaskedHonorifics(result);
  }

  // --- 2. 申込情報ラベルの値をマスク（ラベルは残す） ---
  result = result.replace(APP_LABEL_REGEX, '$1$2[回答済み・非表示]');

  // --- 3. メールアドレス ---
  result = result.replace(EMAIL_REGEX, '[メールアドレス非表示]');

  // --- 4. 電話番号（郵便番号より先に処理：03-1234-5678 の誤検知防止） ---
  result = result.replace(PHONE_HYPHEN_REGEX, '[電話番号非表示]');
  result = result.replace(PHONE_PLAIN_REGEX, '[電話番号非表示]');

  // --- 5. 郵便番号 ---
  result = result.replace(POSTAL_REGEX, '[郵便番号非表示]');

  // --- 6. 入居希望日を月精度に丸める（9月15日 → 9月中） ---
  result = result.replace(DAY_DATE_REGEX, '$1月中');

  // --- 7. 敬称パターン（〇〇様/さま/さん → お客様、ただしSAFEワードは除外） ---
  result = result.replace(HONORIFIC_REGEX, (match, offset: number, full: string) => {
    if (isSafeHonorific(match, offset, full)) {
      return match;
    }
    return 'お客様';
  });

  // --- 8. 後始末: 「お客様様」「お客様さん」等の重複敬称を正規化 ---
  result = normalizeMaskedHonorifics(result);

  return result;
}
