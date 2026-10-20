// scripts/lib/exam-failure-reader.ts — 試験の外れの理由を読む読み手（flash・短い JSON）の決め方（純関数・LLM も DB もファイルも触らない）
//
// 2026-10-20 竹内さん（設計知見 0ed6c13d「試験のブレインを最優先で改善する — LINE のブレインの構造と使い方を参考に…外れの理由を読む」）:
//   落ちた問題ごとに、問題・正解・ブレインの答案・前（main）との違いを flash の読み手に渡し、外れの理由の型を1つ（＋1行の根拠）付ける。
//   理由の型は6つ: 道の取り違え／依頼の抜け／注記・材料に引っ張られた／言ってはいけない事／正解が揺れている／判定の誤り。
//   実行の終わりに型ごとに数えて出し、保存して次の --conduct（司令塔）の材料にする。
//   キャッシュの並び（COST④）: system（型の定義・出力の形）は全部の呼び出しで同じ。user は「問題と正解（同じ問題なら同じ）→ 前（main）の答案 → 今の答案」の順。
//   読み書き・LLM は scripts/exam-brain.ts（readFailureReasons）。単体テスト scripts/lib/__tests__/exam-brain-like-line.test.ts
import type { RowLite } from "./exam-brain";

export const REASON_KINDS = ["道の取り違え", "依頼の抜け", "注記・材料に引っ張られた", "言ってはいけない事", "正解が揺れている", "判定の誤り"] as const;
export type ReasonKind = (typeof REASON_KINDS)[number];

export const READER_SYSTEM = [
  "あなたは賃貸仲介の LINE 接客 AI（ブレイン）の試験で、落ちた答案の『外れの理由』を1つに決める読み手です。推測で広げず、渡された材料に書いてある事だけで決めます。",
  "理由の型（この中から1つ）:",
  "- 道の取り違え: 返信／約束（2段:〇）／AIX の選び（道）そのものが正解と違う。依頼は読めているのに答え方の道を取り違えた。",
  "- 依頼の抜け: 道は合っているのに、正解の依頼（質問・頼み事）のどれかに答えていない・約束していない。",
  "- 注記・材料に引っ張られた: 答案の判断が、お客様の言葉ではなく材料（決まり rule:〜・前回の分析・台帳・注記・検索の結果）に引っ張られて外れた（trace の decision_source が rule: 等で、お客様の言葉と合わない）。",
  "- 言ってはいけない事: 正解の『言ってはいけない事』を言う・する指示になっている。",
  "- 正解が揺れている: 答案は筋が通っていて、正解の方が場面に対して一つに決まらない（似た場面で別の正解がありうる・前（main）と今で道が割れても両方が自然）。竹内さんに確かめる候補。",
  "- 判定の誤り: 答案は正解の依頼に答えているのに、採点（判定の why）が見落として✕にした。",
  "evidence は根拠の1行（40字まで・材料の言葉を引く）。confidence は high／mid／low。",
  '出力は JSON だけ: {"kind":"道の取り違え","evidence":"40字","confidence":"mid"}',
].join("\n");

export type ReaderProblem = { id: string; type: string; customer?: string; lastStaff?: string; accept?: string[]; mustNot?: string[]; asks?: Array<{ q?: string; route?: string; point?: string }>; ng?: string[] };
type BrainLite = { reply_mode?: unknown; two_stage?: unknown; reply_direction?: unknown; key_topics?: unknown; avoid_topics?: unknown; turn_contract?: unknown; action?: unknown };
export type ReaderRow = RowLite & { brain?: (BrainLite & Record<string, unknown>) | null; asks?: Array<{ q?: string; covered?: boolean; route?: boolean; why?: string }> | null; ng?: Array<{ violated?: boolean; why?: string }> | null; trace?: Record<string, unknown> | null };

/** 問題ごとに回を束ねた外れ（今の答案の過半数が合格でない） */
export function failedOf(rows: ReaderRow[]): boolean {
  const ok = rows.filter((r) => !r.error);
  return ok.length > 0 && !(ok.filter((r) => !!r.path?.ok && !!r.score?.pass).length * 2 > ok.length);
}
/** 機械の手がかり（決まった計算）: 言ってはいけない事の違反・道の外れ・依頼の抜け・回が割れた・前（main）と道が違う */
export function machineHint(cur: ReaderRow[], main: ReaderRow[]): string[] {
  const c = cur.filter((r) => !r.error), m = main.filter((r) => !r.error);
  const h: string[] = [];
  if (c.some((r) => (r.ng ?? []).some((g) => g?.violated))) h.push("判定: 言ってはいけない事に当たった回がある");
  if (c.some((r) => r.path && r.path.ok === false)) h.push(`道が外れた回がある（${[...new Set(c.filter((r) => r.path?.ok === false).map((r) => String(r.path?.code ?? "?")))].join("/")}）`);
  if (c.some((r) => r.path?.ok && (r.asks ?? []).some((a) => a?.covered === false))) h.push("道は合っていて依頼の判定に✕がある");
  if (new Set(c.map((r) => `${r.path?.code ?? ""}|${r.score?.pass ? 1 : 0}`)).size > 1) h.push("今の回の答えが割れた（揺れ）");
  const codes = (rs: ReaderRow[]) => [...new Set(rs.map((r) => String(r.path?.code ?? "")))].sort().join("/");
  if (m.length && codes(m) !== codes(c)) h.push(`前（main）は道 ${codes(m)}・今は ${codes(c)}`);
  if (m.length && m.some((r) => r.score?.pass) && !c.some((r) => r.score?.pass)) h.push("前（main）は合格・今は落ちた（退行）");
  return h;
}
const s = (v: unknown, n: number) => (typeof v === "string" ? v : v === null || v === undefined ? "" : JSON.stringify(v)).replace(/\s+/g, " ").slice(0, n);
/** 1つの答案の要約（自由文は短く・turn_contract の依頼と答え方・決まりの出どころ・判定の why） */
export function answerLine(r: ReaderRow | undefined): string {
  if (!r) return "（なし）";
  const b = (r.brain ?? {}) as BrainLite & Record<string, unknown>;
  const tc = (b.turn_contract ?? {}) as { asks?: Array<{ quote?: string; route?: string; aix?: string; answer?: string }> };
  const t = (r.trace ?? {}) as Record<string, unknown>;
  return [
    `道=${r.path?.code ?? "?"}${r.path?.ok ? "○" : "✕"}・合格=${r.score?.pass ? "○" : "✕"}`,
    `reply_mode=${s(b.reply_mode, 20)}・two_stage=${s(b.two_stage, 20)}・action=${s(b.action, 30)}`,
    `方向=${s(b.reply_direction, 160)}`,
    `依頼=${(tc.asks ?? []).map((a) => `${s(a?.route, 10)}${a?.aix ? `:${s(a.aix, 20)}` : ""}「${s(a?.quote, 30)}」→${s(a?.answer, 40)}`).join(" ／ ").slice(0, 400) || "-"}`,
    `決まりの出どころ=${s(t.decision_source ?? t.decision_source_no_aix, 80) || "-"}`,
    `判定の依頼=${(r.asks ?? []).map((a, i) => `${i + 1}:${a?.covered ? "○" : "✕"}${a?.why ? `(${s(a.why, 30)})` : ""}`).join(" ") || "-"}・言ってはいけない事=${(r.ng ?? []).map((g, i) => `${i + 1}:${g?.violated ? "✕" : "○"}`).join(" ") || "-"}`,
  ].join("\n");
}
/** 読み手の user（変わらない物が先: 問題と正解 → 前の答案 → 今の答案 → 機械の手がかり） */
export function buildReaderUser(p: ReaderProblem, cur: ReaderRow[], main: ReaderRow[], extra: string[] = []): string {
  const c = cur.filter((r) => !r.error), m = main.filter((r) => !r.error);
  // 今の答案は外れた回を先に（理由を読む相手）
  const cBad = c.find((r) => !(r.path?.ok && r.score?.pass)) ?? c[0];
  return [
    `■ 問題 ${p.id}（型: ${p.type}）`,
    `お客様の今の発言: ${s(p.customer, 400) || "-"}`,
    `直前のこちらの送信: ${s(p.lastStaff, 200) || "（なし）"}`,
    `正解の道: ${(p.accept ?? []).join(" | ") || "-"}／言ってはいけない道: ${(p.mustNot ?? []).join(" | ") || "-"}`,
    `正解の依頼: ${(p.asks ?? []).map((a, i) => `${i + 1}.「${s(a.q, 40)}」→${s(a.route, 10)}:${s(a.point, 60)}`).join(" ／ ") || "-"}`,
    `言ってはいけない事: ${(p.ng ?? []).map((x, i) => `${i + 1}.${s(x, 50)}`).join(" ／ ") || "-"}`,
    `【前（main）の答案・${m.length}回】\n${answerLine(m[0])}`,
    `【今の答案（外れた回）・${c.length}回中 合格 ${c.filter((r) => r.score?.pass).length}】\n${answerLine(cBad)}`,
    `【機械の手がかり】${[...machineHint(c, m), ...extra].join("／") || "なし"}`,
  ].join("\n");
}
export type Reason = { id: string; kind: ReasonKind; evidence: string; confidence: "high" | "mid" | "low"; by: "flash" | "machine" };
/** 読み手の答え（寛容に読む・知らない型は捨てる） */
export function parseReason(id: string, text: string): Reason | null {
  const t = String(text ?? "").replace(/```(?:json)?/g, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let j: Record<string, unknown>;
  try { j = JSON.parse(t.slice(a, b + 1).replace(/,\s*([}\]])/g, "$1")) as Record<string, unknown>; } catch { return null; }
  const kind = String(j.kind ?? "").trim();
  if (!(REASON_KINDS as readonly string[]).includes(kind)) return null;
  const cf = String(j.confidence ?? "").trim();
  return { id, kind: kind as ReasonKind, evidence: String(j.evidence ?? "").replace(/\s+/g, " ").slice(0, 60), confidence: cf === "high" || cf === "low" ? cf : "mid", by: "flash" };
}
/**
 * 読み手を呼ばずに決まる時（決まった計算・0円）: 判定で言ってはいけない事に当たり、道は合っている → 言ってはいけない事。
 *   それ以外は読み手に回す（道の外れが『取り違え』か『材料に引っ張られた』かは答案を読まないと分からない）
 */
export function machineReason(id: string, cur: ReaderRow[]): Reason | null {
  const c = cur.filter((r) => !r.error);
  const bad = c.filter((r) => !(r.path?.ok && r.score?.pass));
  if (bad.length && bad.every((r) => r.path?.ok && (r.ng ?? []).some((g) => g?.violated) && !(r.asks ?? []).some((a) => a?.covered === false))) return { id, kind: "言ってはいけない事", evidence: "判定: 言ってはいけない事に当たった（道・依頼は合っている）", confidence: "high", by: "machine" };
  return null;
}
/** 型ごとの数（多い順） */
export function aggregateReasons(rs: Reason[]): Array<{ kind: ReasonKind; n: number; ids: string[] }> {
  const m = new Map<ReasonKind, string[]>();
  for (const r of rs) m.set(r.kind, [...(m.get(r.kind) ?? []), r.id]);
  return [...m].map(([kind, ids]) => ({ kind, n: ids.length, ids })).sort((a, b) => b.n - a.n || REASON_KINDS.indexOf(a.kind) - REASON_KINDS.indexOf(b.kind));
}
