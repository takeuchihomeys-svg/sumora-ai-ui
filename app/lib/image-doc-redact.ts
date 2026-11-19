// app/lib/image-doc-redact.ts — 保存済みのお客様の画像の書き起こしに残った書類の中身を、LLM に渡す前に種類だけにする（純関数）
//
// 2026-11-15 作業員H（統括役の頼み・個人情報・竹内さん「これ優先」）:
//   受け取った時の網（image-label の IMAGE_LABEL_1115）が入る前に保存された行（全期間 10行＋種類不明 2行・DB は書き換えない）には、
//   契約書・保証会社の書類の中身（借主の氏名・住所）・マイページの氏名・見積書の宛名「〇〇 様」が書き起こしのまま残っている。
//   会話の本文を読む所（ブレイン・返信の生成・要約・見張り…）は数百あるので、全部の LLM 呼び出しが通る出口（llm-request-sanitize の fetch の包み）で
//   「[画像]」から始まる書き起こしの部分だけを置き換える（Anthropic・DeepSeek とも）。画面の表示・DB の行はそのまま。
//   ・契約書・保証会社の書類（CONTRACT_DOC_RE）→「[画像] 【書類：契約書・保証会社の書類】」（中身は全部捨てる）
//   ・マイページの氏名（MYPAGE_NAME_RE）→「[画像] 【物件以外：個人情報の載った画像】」
//   ・見積書の宛名 → 「（お名前）様」（金額・物件名は残す）
//   部分の終わり: 次の発言の見出し（「[顧客」「[お客様」「[スタッフ」「[AIX」）か、空行2つか、1,500字。
//   既定 on（IMAGE_DOC_READ_REDACT=off で止める）
import { CONTRACT_DOC_RE, MYPAGE_NAME_RE, maskEstimateAddressee, IMAGE_KIND_LABEL } from "./image-label";

type Env = Record<string, string | undefined>;
export function imageDocReadRedactOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.IMAGE_DOC_READ_REDACT ?? "").trim().toLowerCase() !== "off";
}

const SEG_START_RE = /\[画像\]/g;
const SEG_STOP_RE = /\s\[(?:顧客|お客様|スタッフ|AIX|担当|customer|staff)|\n\s*\n\s*\n/;
const SEG_MAX = 1500;
const CONTRACT_TEXT = `[画像] 【${IMAGE_KIND_LABEL.contract_document}】`;
const PERSONAL_TEXT = `[画像] 【${IMAGE_KIND_LABEL.personal_unknown}】`;

export type DocHit = "contract" | "mypage" | "addressee";
/** 1つの書き起こしの部分（「[画像]」から）に当たる書類の型（無ければ null） */
export function imageDocHit(seg: string): DocHit | null {
  const t = seg.normalize("NFKC");
  if (CONTRACT_DOC_RE.test(t)) return "contract";
  if (MYPAGE_NAME_RE.test(t)) return "mypage";
  if (/見積|御請求|請求金額/.test(t) && maskEstimateAddressee(seg) !== seg) return "addressee";
  return null;
}

/** 文字列の中の「[画像]…」の部分を置き換える。置き換えた数も返す */
export function redactImageDocs(text: string): { text: string; hits: DocHit[] } {
  if (!text || !text.includes("[画像]")) return { text, hits: [] };
  const hits: DocHit[] = [];
  let out = "", last = 0;
  SEG_START_RE.lastIndex = 0;
  const starts: number[] = [];
  for (let m = SEG_START_RE.exec(text); m; m = SEG_START_RE.exec(text)) starts.push(m.index);
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    if (s < last) continue;
    const limit = Math.min(text.length, s + SEG_MAX, starts[i + 1] ?? Infinity);
    const rest = text.slice(s + 4, limit);
    const stop = rest.search(SEG_STOP_RE);
    const e = stop >= 0 ? s + 4 + stop : limit;
    const seg = text.slice(s, e);
    const h = imageDocHit(seg);
    if (!h) continue;
    hits.push(h);
    out += text.slice(last, s) + (h === "contract" ? CONTRACT_TEXT : h === "mypage" ? PERSONAL_TEXT : maskEstimateAddressee(seg));
    last = e;
  }
  if (!hits.length) return { text, hits };
  return { text: out + text.slice(last), hits };
}

/** JSON の本文（LLM へのリクエスト）の文字列を全部見て置き換える。当たらなければ元の文字列のまま（キャッシュの先頭一致を壊さない） */
export function redactImageDocsInJsonBody(body: string, env: Env = typeof process !== "undefined" ? process.env : {}): { body: string; hits: number } {
  if (!imageDocReadRedactOn(env) || !body.includes("[画像]")) return { body, hits: 0 };
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return { body, hits: 0 }; }
  let hits = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") { const r = redactImageDocs(v); hits += r.hits.length; return r.text; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") { const o: Record<string, unknown> = {}; for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = walk(x); return o; }
    return v;
  };
  const cleaned = walk(parsed);
  if (!hits) return { body, hits: 0 };
  return { body: JSON.stringify(cleaned), hits };
}
