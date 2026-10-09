// scripts/lib/brain-exam-mask.ts — ブレインの試験の問題を作る時の伏せ方（scripts/yuma-r10-brain-replay.ts の maskText と同じ線＋maskPersonalValues）
//   お客様の名前と、こちらの文で「〇〇さん/様」と呼んでいる名前は「YUMA」、電話・メールは伏せる。携帯番号・生年月日・郵便番号・メール・現住所の行は maskPersonalValues が伏せる（maskPII は日付を月に丸め・「〇〇さん」を全部お客様にするので使わない）。
import { maskPersonalValues } from "../../app/lib/example-pii-guard";

const URL_OR_PHONE_RE = /https?:\/\/[^\s　]+|0\d{1,4}[-ー－]?\d{1,4}[-ー－]?\d{3,4}/g;
const MAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const NOT_NAME = /^(?:お客|皆|旦那|奥|管理会社|担当|YUMA|同居人|オーナー|業者|大家|貸主|保証会社|ご主人|主人|彼女|彼氏|お子|弟|妹|兄|姉|母|父|ご両親|親御|内覧担当|鈴木|竹内|管理人|みな$)/;

/** こちらの文で呼んでいる名前（〇〇さん／様） */
export function addressNamesOf(staffTexts: ReadonlyArray<string>): string[] {
  const out = new Set<string>();
  for (const t of staffTexts) for (const m of String(t ?? "").matchAll(/(?:^|\n|、|。|！|\s|\/)([^\s\n、。！!?？「」()（）・/]{1,10}?)(?:さん|様)(?=\n|に|の|が|お|ご|達|、|！|😊|😌|$|\s)/g)) {
    const nm = m[1]; if (!NOT_NAME.test(nm) && !/[0-9０-９]/.test(nm)) out.add(nm);
  }
  return [...out];
}

export function maskExamText(t: string | null | undefined, customerName: string | null, extraNames: ReadonlyArray<string> = []): string {
  let s = String(t ?? "");
  const names = new Set<string>();
  const n = (customerName ?? "").trim();
  if (n.length >= 2) { names.add(n); for (const p of n.split(/[\s　]+/)) if (p.length >= 2) names.add(p); }
  for (const x of extraNames) if (x) names.add(x);
  for (const nm of [...names].sort((a, b) => b.length - a.length)) { s = s.split(`${nm}さん`).join("YUMAさん").split(`${nm}様`).join("YUMA様"); if (nm.length >= 2) s = s.split(nm).join("YUMA"); }
  // 1文字の名前（「r さん」等）も呼びかけの形だけ伏せる
  if (n.length === 1) s = s.split(`${n}さん`).join("YUMAさん");
  s = s.replace(/[^\s、。！!]{2,8}(様|さん)から(ご)?紹介/g, "ご紹介者様から$2紹介");
  s = s.replace(/^([^\n]{1,14}?)(さん|様)(\n)/, "YUMA$2$3");
  s = s.replace(URL_OR_PHONE_RE, (m) => (/^https?:/.test(m) ? m : "（電話番号）")).replace(MAIL_RE, "yuma@example.com");
  return maskPersonalValues(s);
}
