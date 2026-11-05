// scripts/lib/brain-exam-mask.ts — 試験の問題を作る時の伏せ方。2026-10-29 本体は app/lib/text-mask-names.ts に移した（AIX の担当の札の cron も使う）
export { maskExamText, addressNamesOf } from "../../app/lib/text-mask-names";

/**
 * 2026-11-05 弱い所 301: 台帳の行を伏せる時、電話の正規表現が時刻の秒の小数（"10:50:19.123456+00:00"）や uuid の数字の並びに当たって
 *   「（電話番号）」に置き換わり、id・時刻が壊れていた（約79問・id 174件）。id・*_id の欄と、値そのものが ISO 時刻・日付・uuid の物は伏せない。
 *   値で見るのは安全（ISO 時刻・uuid の形の文字列に電話番号は入らない）。それ以外の文字列は今まで通り全部伏せる（伏せを弱くしない）。
 */
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isMaskExemptKey(k: string | null): boolean { return k != null && (k === "id" || /_id$/.test(k)); }
export function isMaskExemptValue(s: string): boolean { return ISO_TIME_RE.test(s) || UUID_RE.test(s); }
export function maskLedgerDeep(v: unknown, mask: (s: string) => string, key: string | null = null): unknown {
  if (typeof v === "string") {
    if (isMaskExemptKey(key) || isMaskExemptValue(v)) return v;
    const m = mask(v); return m.length > 3000 ? m.slice(0, 3000) : m;
  }
  if (Array.isArray(v)) return v.map((x) => maskLedgerDeep(x, mask, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, maskLedgerDeep(x, mask, k)]));
  return v;
}
