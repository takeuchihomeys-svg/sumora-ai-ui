// app/lib/delegation-index.ts — 台帳 #811「任せられる度」の表（場面ごとに毎日数える・純関数・DB/LLM なし）
// 2026-11-27 作業員L（統括役の割り振り）: 場面ごとに ① そのまま送れた割合（スタッフが下書きを直さず送った）② 危ない間違い ③ AIX の番を返信にした数。
//   数える元は新しく作らない: scripts/audit-split-reply-aix.ts（KB 8ee13967）の番の行（場面 scene・ブレインの判断 brain・人の答え truth・下書き draft と送った文 sent）。
//   ① 返信の番（人も返信・下書きがある）で 下書き＝送った文（正規化して同じ）の割合。
//   ② 危ない間違い＝直した番のうち、直しで 金額・日にち／時刻・物件名と号室・約束の言葉 のどれかが変わった（消した・違う値にした）番（言い回しだけの直しは数えない）。
//   ③ ブレインは返信なのに、人は AIX（人の文に AIX の中身があった番も含む＝aixByText）。
//   数え直しは本番の会話を読む＝22時以降（scripts/audit-delegation-index.ts で audit-split-reply-aix の行に当てる予定）
export type DelegRow = { scene: string; brain: string; truth: string; draft: string | null; sent: string | null; aixByText?: boolean };
export type DangerKind = "金額" | "日時" | "物件" | "約束";
const norm = (s: string | null | undefined) => String(s ?? "").normalize("NFKC").replace(/[\s　]/g, "").replace(/[。、！!？?…]+$/g, "");
const pick = (re: RegExp, s: string) => [...new Set([...String(s).normalize("NFKC").matchAll(re)].map((m) => m[0].replace(/[,，\s]/g, "")))].sort().join("|");
const MONEY_RE = /\d[\d,，]*\s*(?:万|千)?円|\d+(?:\.\d+)?\s*万/g;
const DATE_RE = /\d{1,2}\s*[\/月]\s*\d{1,2}\s*日?|\d{1,2}\s*[:：時]\s*\d{0,2}\s*分?|(?:今日|明日|明後日|本日|来週|今週)(?:中|の|に)?/g;
const PROP_RE = /\d{2,4}\s*号室|[ァ-ヶー]{3,}(?:[ァ-ヶーⅠ-Ⅹ0-9]{0,6})|[一-龥]{2,}(?:マンション|ハイツ|コーポ|レジデンス|荘)/g;
const PROMISE_RE = /確認(?:させて|して|致し|いたし)|お調べ|折り返し|お送り(?:させて|致し|いたし)|ご連絡(?:させて|致し|いたし)|手配|押さえ/g;
/** 直しで変わった危ない種類（純関数）。下書きが無い・直していない番は空 */
export function dangerOfEdit(draft: string | null | undefined, sent: string | null | undefined): DangerKind[] {
  if (!draft || !sent || norm(draft) === norm(sent)) return [];
  const out: DangerKind[] = [];
  if (pick(MONEY_RE, draft) !== pick(MONEY_RE, sent)) out.push("金額");
  if (pick(DATE_RE, draft) !== pick(DATE_RE, sent)) out.push("日時");
  if (pick(PROP_RE, draft) !== pick(PROP_RE, sent)) out.push("物件");
  if ((pick(PROMISE_RE, draft) !== "") !== (pick(PROMISE_RE, sent) !== "")) out.push("約束");
  return out;
}
export type DelegCell = { scene: string; replyTurns: number; asIs: number; asIsRate: number | null; edited: number; danger: number; dangerKinds: Partial<Record<DangerKind, number>>; aixTurns: number; aixAsReply: number };
const isAix = (s: string) => /^AIX/.test(s) || s === "2段";
/** 場面ごとの表（純関数） */
export function delegationTable(rows: readonly DelegRow[]): DelegCell[] {
  const by = new Map<string, DelegRow[]>();
  for (const r of rows) by.set(r.scene || "-", [...(by.get(r.scene || "-") ?? []), r]);
  const out: DelegCell[] = [];
  for (const [scene, xs] of by) {
    const reply = xs.filter((r) => !isAix(r.truth) && !r.aixByText && r.draft && r.sent);
    const asIs = reply.filter((r) => norm(r.draft) === norm(r.sent)).length;
    const edited = reply.length - asIs;
    const dk: Partial<Record<DangerKind, number>> = {}; let danger = 0;
    for (const r of reply) { const d = dangerOfEdit(r.draft, r.sent); if (d.length) { danger++; for (const k of d) dk[k] = (dk[k] ?? 0) + 1; } }
    const aixTurns = xs.filter((r) => isAix(r.truth) || r.aixByText).length;
    const aixAsReply = xs.filter((r) => (isAix(r.truth) || r.aixByText) && /^返信/.test(r.brain)).length;
    out.push({ scene, replyTurns: reply.length, asIs, asIsRate: reply.length ? Math.round((asIs / reply.length) * 1000) / 10 : null, edited, danger, dangerKinds: dk, aixTurns, aixAsReply });
  }
  return out.sort((a, b) => b.replyTurns + b.aixTurns - (a.replyTurns + a.aixTurns));
}
/** 朝の1枚の行（場面ごと・番の少ない場面は出さない） */
export function delegationLines(cells: readonly DelegCell[], minTurns = 5): string[] {
  return cells.filter((c) => c.replyTurns + c.aixTurns >= minTurns).map((c) => `- ${c.scene}: そのまま送れた ${c.asIsRate ?? "—"}%（${c.asIs}/${c.replyTurns}）・危ない間違い ${c.danger}${c.danger ? `（${Object.entries(c.dangerKinds).map(([k, v]) => `${k}${v}`).join("・")}）` : ""}・AIX の番を返信にした ${c.aixAsReply}/${c.aixTurns}`);
}
