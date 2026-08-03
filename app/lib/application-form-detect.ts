/**
 * 申込フォーム検知モジュール（サーバー・クライアント共通）
 *
 * お客さんが送ってきたテキストが「記入済みの入居申込フォーム」かどうかを判定する。
 * - line-webhook（サーバー）: 検知したら status を "applying"（申込・審査中）に自動昇格
 * - app/page.tsx（クライアント）: 確認バナー表示のフォールバック（画像フォーム等サーバーが拾えないケース用）
 *
 * キーワードリストをここに一元化することで、これまで page.tsx / generate-reply /
 * suggest-status-update に分散していた検知ロジックのドリフトを防ぐ。
 *
 * 注意: 「生年月日」は「代表者生年月日」の部分文字列なので、必ず法人判定を先に行う。
 */

export type ApplicationFormDetection = {
  detected: boolean;
  formType: "corporate" | "individual" | null;
  matchedKeywords: string[];
};

// ── 法人フォーム ──────────────────────────────────────────────
// A: 1ヒットで即確定（【法人御契約】ヘッダー等）
const CORPORATE_IMMEDIATE = /法人御契約|法人契約|法人名義/;
// B: 2つ以上ヒットで確定（フォームの項目ラベル）
const CORPORATE_FIELDS = [
  "法人名", "会社名", "代表者名", "代表者生年月日", "登記住所",
  "本社所在地", "所在地", "設立", "資本金", "事業内容",
  "年商", "従業員数", "入居者名", "法人番号",
];
const CORPORATE_THRESHOLD = 2;

// ── 個人フォーム ──────────────────────────────────────────────
// 1ヒットで即確定（フォームそのものを指す語）
const INDIVIDUAL_IMMEDIATE = /入居申込書|入居申込|申込みフォーム|申込フォーム|申し込み書/;
// 3つ以上ヒットで確定（フォームの項目ラベル）
// ※「保証人」は「連帯保証人」を部分一致でカバーするため連帯保証人は別途入れない（二重カウント防止）
const INDIVIDUAL_FIELDS = [
  "氏名", "フリガナ", "生年月日", "現住所", "緊急連絡先",
  "勤務先", "続柄", "住居年数", "入居者", "申込書",
  "保証人", "年収", "職業",
];
const INDIVIDUAL_THRESHOLD = 3;

// ── 分割送信フォールバック用（webhookで直近メッセージを結合して再判定するトリガー）──
const APPLY_HINT = /氏名|フリガナ|緊急連絡先|勤務先|法人名|代表者|登記住所|保証人/;

/**
 * テキストが記入済み申込フォームかどうかを判定する。
 * 法人 → 個人の順にチェック（代表者生年月日が個人側の生年月日に食われないように）。
 */
export function isApplicationFormMessage(text: string): ApplicationFormDetection {
  const t = text ?? "";
  if (!t.trim()) return { detected: false, formType: null, matchedKeywords: [] };

  // ① 法人フォーム
  if (CORPORATE_IMMEDIATE.test(t)) {
    return { detected: true, formType: "corporate", matchedKeywords: [t.match(CORPORATE_IMMEDIATE)![0]] };
  }
  const corpMatched = CORPORATE_FIELDS.filter((kw) => t.includes(kw));
  if (corpMatched.length >= CORPORATE_THRESHOLD) {
    return { detected: true, formType: "corporate", matchedKeywords: corpMatched };
  }

  // ② 個人フォーム
  if (INDIVIDUAL_IMMEDIATE.test(t)) {
    return { detected: true, formType: "individual", matchedKeywords: [t.match(INDIVIDUAL_IMMEDIATE)![0]] };
  }
  const indMatched = INDIVIDUAL_FIELDS.filter((kw) => t.includes(kw));
  if (indMatched.length >= INDIVIDUAL_THRESHOLD) {
    return { detected: true, formType: "individual", matchedKeywords: indMatched };
  }

  return { detected: false, formType: null, matchedKeywords: [...corpMatched, ...indMatched] };
}

/**
 * 単発では閾値未満でも申込フォームの一部かもしれないテキストか？
 * （webhook側で直近の顧客メッセージを結合して再判定するトリガーに使う）
 */
export function hasApplyHintKeyword(text: string): boolean {
  return APPLY_HINT.test(text ?? "");
}

/**
 * 申込前ステータス一覧（これらのステータスからのみ applying へ自動昇格する）。
 * closed_won / closed_lost / applying系（application, screening, contract）を
 * 含めないことで、冪等かつダウングレード禁止を DB の .in() ガードで担保する。
 * app/lib/status-normalize.ts の STATUS_ALIAS の pre-applying 系と一致させること。
 */
export const PRE_APPLY_STATUSES = [
  "hearing",
  "first_reply",
  "condition_hearing",
  "property_search",
  "proposing",
  "property_recommendation",
  "viewing",
  "estimate_request",
  "availability_check",
];
