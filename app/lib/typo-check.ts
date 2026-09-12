// app/lib/typo-check.ts
// 2026-09-11 竹内方針1（統合設計 §4）: 最終チェックの「必須要素」枠を「誤字の確認」に置き換える。決定論・block しない。
//   ・自動修正（applyTypoAutoFix）は後処理 applySurfaceFixes（validateAndClean の末尾・修正版）で行う
//   ・自動修正の後に残ったもの（辞書で置換先を決められない誤字）だけを final-check ⑮ が warning で出す（修正ループには渡さない）
//   規則はすべて実データで出現を確認したもの（人の送信 6,092通・AIX 4,766通・下書き 2,498件）。
//   誤検出（正解 775件）: 12件ヒット＝全てスタッフ実文の誤字。除外前の偽陽性は「中でできる」と行末の「、、」の2件のみ（除外済み）
//   誤字として扱わないもの: 「で次第」単独（人の送信で60件ある常用表記）・ご教授・御見積し・拝見させて（BANNED の担当）・
//   英字/数字/URL の反復・customerName に含まれる反復（めちめち等）
//   依存は jst-date（依存ゼロ）だけ。

import { DATE_WEEKDAY_RE, correctDateWeekdayMatch } from "./jst-date";

export type TypoCode =
  | "TYPO_DUP_HONORIFIC" | "TYPO_DUP_TOKEN" | "TYPO_KANA_DROP" | "TYPO_PARTICLE_DUP"
  | "TYPO_PUNCT" | "TYPO_ESCAPE_LEAK" | "TYPO_WEEKDAY_MISMATCH";

export type TypoHit = { code: TypoCode; evidence: string; /** 置換後の文字列。null は置換先を決められない（検出のみ） */ fixed: string | null };

type Rule = { code: TypoCode; re: RegExp; fix: (m: RegExpExecArray) => string | null };

/** 頻出句との1文字違い（脱字・打鍵崩れ）の辞書。fix=null は置換先が一意に決まらない（検出のみ） */
const KANA_DROP_DICT: Array<{ re: RegExp; fix: string | null }> = [
  { re: /ありがと(?=ござ)/g, fix: "ありがとう" },
  { re: /(?<!あり)あがとう/g, fix: "ありがとう" },
  { re: /ございす(?!る)/g, fix: "ございます" },
  { re: /ござます/g, fix: "ございます" },
  { re: /かしこまりまりました/g, fix: "かしこまりました" },
  { re: /かしこまりましました/g, fix: "かしこまりました" },
  { re: /かしこまりした/g, fix: "かしこまりました" },
  { re: /ささて(?=頂|いただ)/g, fix: "させて" },
  { re: /お送りせて/g, fix: "お送りさせて" },
  { re: /お送させて/g, fix: "お送りさせて" },
  { re: /させていだたき/g, fix: "させていただき" },
  { re: /させて頂きまます/g, fix: "させて頂きます" },
  { re: /させていただきまます/g, fix: "させていただきます" },
  { re: /させて頂ます/g, fix: "させて頂きます" },
  { re: /させていただます/g, fix: "させていただきます" },
  { re: /よろしくお願致します/g, fix: "よろしくお願い致します" },
  { re: /見つかまで/g, fix: "見つかるまで" },
  { re: /お見積書書/g, fix: "お見積書" },
  { re: /初期費費用/g, fix: "初期費用" },
  { re: /お気に召さましたら/g, fix: "お気に召されましたら" },
  { re: /お手隙際に/g, fix: "お手隙の際に" },
  // 置換先が一意でないもの（検出のみ）
  { re: /お部屋探しし/g, fix: null },
  { re: /(?:頂|いただ)きまら/g, fix: null },
  { re: /ただきましただき/g, fix: null },
  { re: /ていまいます/g, fix: null },
];

// 敬称の重複（さんさん）は DUP_HONORIFIC_RE の担当
const DUP_TOKEN_RE = /(させ|させて|して|から|まし|ございます|いたします|致します|よろしく|お願い|いただき|頂き|お送り|ご連絡|ご案内|ご内覧|お部屋|部屋|号室|物件|予定|費用|契約|新着で|域から|確認|募集)\1/g;
const DUP_HONORIFIC_RE = /さんさん|様さん|さん様|様様/g;
/** 「でで次第」→「出次第」（助詞の重複の特例） */
const DEDE_SHIDAI_RE = /でで次第/g;
const PARTICLE_DUP_RE = /(?<=[一-龥ァ-ヶー])(をを|がが|にに|でで(?![きけ]|次第))(?=[一-龥ァ-ヶぁ-んー])/g;
const PUNCT_AFTER_EXCL_RE = /([！!])[、。]/g;
/** 行末以外の「、、」（行末の「、、」は意図的な間なので対象外） */
const DOUBLE_TOUTEN_RE = /、、(?=[^\n])/g;
const ESCAPE_LEAK_RE = /\\n/g;

// 2026-09-12 竹内方針D: 曜日の計算は jst-date.ts の1関数（weekdayForMonthDay・correctDateWeekdayMatch）に一本化。
//   few-shot の衛生（example-hygiene）も同じ関数で直す。weekdayFor は既存の呼び出し元のための再エクスポート
export { weekdayForMonthDay as weekdayFor } from "./jst-date";

function rules(now: number): Rule[] {
  return [
    { code: "TYPO_ESCAPE_LEAK", re: ESCAPE_LEAK_RE, fix: () => "\n" },
    { code: "TYPO_DUP_HONORIFIC", re: DUP_HONORIFIC_RE, fix: (m) => (m[0] === "様様" ? "様" : m[0] === "さんさん" ? "さん" : m.input.slice(Math.max(0, m.index - 2), m.index) === "お客" ? "様" : "さん") },
    { code: "TYPO_PARTICLE_DUP", re: DEDE_SHIDAI_RE, fix: () => "出次第" },
    { code: "TYPO_DUP_TOKEN", re: DUP_TOKEN_RE, fix: (m) => m[1] },
    { code: "TYPO_PARTICLE_DUP", re: PARTICLE_DUP_RE, fix: (m) => m[1].slice(0, 1) },
    { code: "TYPO_PUNCT", re: PUNCT_AFTER_EXCL_RE, fix: (m) => m[1] },
    { code: "TYPO_PUNCT", re: DOUBLE_TOUTEN_RE, fix: () => "、" },
    {
      // 一致（または日付として無効）→ 原文のまま＝誤字ではない
      code: "TYPO_WEEKDAY_MISMATCH", re: new RegExp(DATE_WEEKDAY_RE.source, "g"), fix: (m) => correctDateWeekdayMatch(m[0], m[1], m[2], m[3], now),
    },
  ];
}

/** 名前・英数字・URL に含まれる反復は誤字にしない */
function isExempt(evidence: string, index: number, text: string, customerName: string): boolean {
  if (customerName && customerName.includes(evidence)) return true;
  // 名前の直後の敬称の重複（「めちさんさん」）は誤字。名前そのものの反復（「めちめち」）は customerName で除外済み
  const lineStart = text.lastIndexOf("\n", index) + 1;
  const around = text.slice(lineStart, text.indexOf("\n", index) < 0 ? text.length : text.indexOf("\n", index));
  if (/https?:\/\//.test(around) && /[A-Za-z0-9]/.test(evidence)) return true;
  return false;
}

/** 誤字の検出（置換後の文字列つき）。text は変更しない */
export function detectTypos(text: string, opts?: { customerName?: string; now?: number }): TypoHit[] {
  const now = opts?.now ?? Date.now();
  const name = opts?.customerName ?? "";
  const hits: TypoHit[] = [];
  // 同じ箇所を複数の規則が拾った時は先の規則だけ（「かしこまりましました」は DUP_TOKEN と辞書の両方に当たる）
  const covered: Array<[number, number]> = [];
  const overlaps = (s: number, e: number) => covered.some(([a, b]) => s < b && a < e);
  for (const r of rules(now)) {
    r.re.lastIndex = 0;
    for (let m = r.re.exec(text); m; m = r.re.exec(text)) {
      if (m[0] === "") { r.re.lastIndex++; continue; }
      if (isExempt(m[0], m.index, text, name) || overlaps(m.index, m.index + m[0].length)) continue;
      const fixed = r.fix(m);
      if (fixed === m[0]) continue;
      covered.push([m.index, m.index + m[0].length]);
      hits.push({ code: r.code, evidence: m[0], fixed });
    }
  }
  for (const d of KANA_DROP_DICT) {
    d.re.lastIndex = 0;
    for (let m = d.re.exec(text); m; m = d.re.exec(text)) {
      if (overlaps(m.index, m.index + m[0].length)) continue;
      covered.push([m.index, m.index + m[0].length]);
      hits.push({ code: "TYPO_KANA_DROP", evidence: m[0], fixed: d.fix });
    }
  }
  return hits;
}

/** 置換先が決まる誤字だけを決定論で直す（検出のみの辞書項目は残す＝⑮ で warning） */
export function applyTypoAutoFix(text: string, opts?: { customerName?: string; now?: number }): { text: string; applied: string[] } {
  const now = opts?.now ?? Date.now();
  const name = opts?.customerName ?? "";
  const applied: string[] = [];
  let out = text;
  for (const r of rules(now)) {
    r.re.lastIndex = 0;
    out = out.replace(r.re, (...args) => {
      const m = args as unknown as RegExpExecArray;
      const index = args[args.length - 2] as number;
      const whole = args[0] as string;
      const execLike = Object.assign([...args.slice(0, -2)], { index, input: args[args.length - 1] as string }) as unknown as RegExpExecArray;
      void m;
      if (isExempt(whole, index, out, name)) return whole;
      const fixed = r.fix(execLike);
      if (fixed === null || fixed === whole) return whole;
      applied.push(`${r.code}:${whole}→${fixed === "\n" ? "\\n(改行)" : fixed}`);
      return fixed;
    });
  }
  for (const d of KANA_DROP_DICT) {
    if (d.fix === null) continue;
    const fix = d.fix;
    d.re.lastIndex = 0;
    out = out.replace(d.re, (whole) => { applied.push(`TYPO_KANA_DROP:${whole}→${fix}`); return fix; });
  }
  return { text: out, applied };
}
