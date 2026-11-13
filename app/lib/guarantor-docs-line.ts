// app/lib/guarantor-docs-line.ts — 売上サポの資料（property_pickups の文字層・読み取り行）に書いてある保証会社を、ブレインの材料の1行にする（純関数・DB/LLM なし）
//
// 2026-11-14 作業員G（材料と受け取る側・統括役の頼み）:
//   brain_unknowns 920「独立系保証会社の送れる物件」・921「送付済み物件の保証会社名」（b50fd451・審査落ち→独立系で探し直す番）。
//   その時点で、この会話の売上サポの行には送った物件 2件・送っていない候補 18件があり、資料の文字層に「保証会社：ジェイリース …」
//   「保証会社：オリコフォレントインシュア …」と書いてあった（読む関数 guarantor-material.guarantorFromMaterial も種類のマスタも main にある）。
//   ブレインには届いていなかった（届いていない理由: 配線が無い＝資料の保証会社は AIX【保証会社について】の画面の下書きと、お客様が契約条件を聞いた時の
//   【📄 お客様が聞いた契約条件】だけが読んでいた）。30日の「保証会社」の自己申告 39件のうち、その前に保証会社名の書かれた資料の行があった会話は 34件
//   （送った物件の資料に名前があった 10件）。
// 決まり: 事実を並べるだけ（判断はブレイン）。会社名は資料に1社だけ書いてある時だけ（2社以上・名前なし＝言わない）。
//   種類はマスタで分かる会社だけ（GUARANTOR_TYPE_SHORT）。資料に名前が無い物件は「管理会社に確かめる＝AIX」と添える（P0 ca55d42b）。
//   読むのは保証会社・審査の話の番だけ（guarantorDocsAsked）。
// 既定 off（BRAIN_GUARANTOR_DOCS=on の時だけ brain-core が読む）
import { guarantorFromMaterial } from "./guarantor-material";
import { GUARANTOR_TYPE_SHORT } from "./guarantor-companies";

type Env = Record<string, string | undefined>;
export function guarantorDocsOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_GUARANTOR_DOCS ?? "").trim().toLowerCase() === "on";
}

/** 保証会社・審査の話の番か（今の連投と直前のこちらの文） */
export const GUARANTOR_TOPIC_RE = /保証会社|独立系|信販系|信用系|審査(?:が|に|は)?(?:落ち|通らな|通りやす|通りにく|厳し|ゆる|緩)|否決/;
export function guarantorDocsAsked(texts: ReadonlyArray<string | null | undefined>): boolean {
  return texts.some((t) => GUARANTOR_TOPIC_RE.test(String(t ?? "").normalize("NFKC")));
}

export type GuarantorDocRow = {
  property_name: string | null; room_no: string | null; status: string | null; sent_at: string | null; expired_at: string | null; created_at: string;
  pdf_text: string | null; image_lines: unknown;
};
type Item = { label: string; company: string | null; type: string };

const linesOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const labelOf = (r: GuarantorDocRow) => `${r.property_name ?? "物件"}${r.room_no ? ` ${r.room_no}` : ""}`;

function itemOf(r: GuarantorDocRow): Item {
  const g = guarantorFromMaterial({ pdfText: r.pdf_text, lines: linesOf(r.image_lines) });
  if (g.status !== "named") return { label: labelOf(r), company: null, type: "" };
  const c = g.companies[0];
  return { label: labelOf(r), company: c.name, type: c.known ? GUARANTOR_TYPE_SHORT[c.type] : "" };
}

export type GuarantorDocsResult = { line: string; sent: number; sentNamed: number; ready: number; readyNamed: number; readyIndependent: number };

/** 材料の1行（送った物件・送れる候補のどちらにも資料の行が無ければ ""） */
export function guarantorDocsLine(rows: ReadonlyArray<GuarantorDocRow>, o: { nowMs: number; maxEach?: number }): GuarantorDocsResult {
  const max = o.maxEach ?? 5;
  const seen = new Set<string>();
  const uniq = rows.filter((r) => { const k = labelOf(r); if (seen.has(k)) return false; seen.add(k); return true; });
  const sentRows = uniq.filter((r) => r.status === "sent" || !!r.sent_at);
  const readyRows = uniq.filter((r) => r.status === "pending" && !r.sent_at && (!r.expired_at || Date.parse(r.expired_at) > o.nowMs));
  const sent = sentRows.map(itemOf);
  const ready = readyRows.map(itemOf);
  const fmt = (x: Item) => `${x.label}＝${x.company ? `${x.company}${x.type ? `（${x.type}）` : ""}` : "資料に名前なし"}`;
  const indep = ready.filter((x) => x.type === "独立系");
  const parts: string[] = [];
  if (sent.length) parts.push(`送った物件: ${sent.slice(0, max).map(fmt).join("・")}`);
  if (ready.length) parts.push(`送れる候補（まだ送っていない ${ready.length}件）のうち資料に名前がある ${ready.filter((x) => x.company).length}件・独立系 ${indep.length}件${indep.length ? `（${indep.slice(0, max).map((x) => x.label).join("・")}）` : ""}`);
  const res = { sent: sent.length, sentNamed: sent.filter((x) => x.company).length, ready: ready.length, readyNamed: ready.filter((x) => x.company).length, readyIndependent: indep.length };
  if (!parts.length) return { line: "", ...res };
  return { line: `- 資料にある保証会社（売上サポの資料の「保証会社」欄から・推測しない）: ${parts.join("／")}。資料に名前が無い物件の保証会社と、審査の可否は管理会社に確かめる事（人だけが知る＝AIX・P0）`, ...res };
}
