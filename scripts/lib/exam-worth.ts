// scripts/lib/exam-worth.ts — 積む前の「試験の値打ちの表」の計算（純関数・LLM なし・DB なし）
// 2026-11-24 作業員A（竹内さん 11/24「試験の改善を優先する」・統括役の頼み: 差が何も無かった本が費用の52%）
//   1行＝1つの組（スイッチ）。余地＝効く問題のうち今の off で外れている数（直せる余地）。重み＝竹内さん本人の番でその型が出る頻度の目安。
//   余地は過半数の回で外れている問題（揺れて半分以上合格は数えない）。値打ち＝余地×重み÷費用。余地0（効く問題が今の off で全部合格＝良くなりようがない）の組は「積まない」の印（悪化だけを見る組は守りの組として別に扱う）。
export type OffPass = { pass: number; n: number };
export type WorthRow = {
  key: string; switch: string | null; stage: "brain" | "draft";
  eff: string[]; guards: string[];
  room: number; roomIds: string[]; unknown: string[];
  weight: number; usd: number; score: number;
  mark: "積む" | "積まない（余地0）" | "問題の当て先なし" | "off の答えが無い（余地不明）";
};
/** 1問1回分の見込み（係の見込みの単価・--repeat=3 --majority・11/21 の止めの記録から）。off と on の2つ分を数える */
export const UNIT_USD: Record<"brain" | "draft", number> = { brain: 0.08, draft: 0.12 };
export function costOf(nProblems: number, stage: "brain" | "draft", sides = 2): number { return Math.round(nProblems * sides * UNIT_USD[stage] * 100) / 100; }

/** 余地: 効く問題のうち今の off で過半数の回が外れている物（off の答えが無い問題は unknown） */
export function roomOf(eff: readonly string[], off: ReadonlyMap<string, OffPass>): { room: number; roomIds: string[]; unknown: string[] } {
  const roomIds: string[] = [], unknown: string[] = [];
  for (const id of eff) { const o = off.get(id); if (!o || !o.n) unknown.push(id); else if (o.pass * 2 < o.n) roomIds.push(id); } // 過半数で外れ＝直せる余地（揺れて半分以上合格は余地に数えない）
  return { room: roomIds.length, roomIds, unknown };
}

/** 重み: 効く問題の型（spec の type）が、竹内さん本人の番から作った問題の中で占める割合の平均（本番の頻度の目安・0〜1） */
export function weightOf(eff: readonly string[], spec: ReadonlyArray<{ id: string; type?: string; source?: string }>): number {
  const own = spec.filter((p) => /竹内さん/.test(p.source ?? ""));
  if (!own.length) return 0;
  const share = new Map<string, number>();
  for (const p of own) share.set(p.type ?? "?", (share.get(p.type ?? "?") ?? 0) + 1);
  const ts = eff.map((id) => spec.find((p) => p.id === id)?.type).filter((t): t is string => !!t);
  if (!ts.length) return 0;
  return Math.round((ts.reduce((s, t) => s + (share.get(t) ?? 0) / own.length, 0) / ts.length) * 1000) / 1000;
}

export function worthRow(o: { key: string; switch: string | null; stage: "brain" | "draft"; eff: string[]; guards: string[]; off: ReadonlyMap<string, OffPass>; spec: ReadonlyArray<{ id: string; type?: string; source?: string }> }): WorthRow {
  const eff = [...new Set(o.eff)], guards = [...new Set(o.guards)].filter((g) => !eff.includes(g));
  const r = roomOf(eff, o.off);
  const weight = weightOf(eff, o.spec);
  const usd = costOf(eff.length + guards.length, o.stage);
  const score = usd > 0 ? Math.round(((r.room * weight) / usd) * 1000) / 1000 : 0;
  const mark: WorthRow["mark"] = !eff.length ? "問題の当て先なし" : r.room === 0 && r.unknown.length === eff.length ? "off の答えが無い（余地不明）" : r.room === 0 && !r.unknown.length ? "積まない（余地0）" : "積む";
  return { key: o.key, switch: o.switch, stage: o.stage, eff, guards, ...r, weight, usd, score, mark };
}
/** 値打ちの順（積む→余地不明→当て先なし→積まない の順・中は値打ちの高い順） */
export function rankWorth(rows: readonly WorthRow[]): WorthRow[] {
  const ord: Record<WorthRow["mark"], number> = { "積む": 0, "off の答えが無い（余地不明）": 1, "問題の当て先なし": 2, "積まない（余地0）": 3 };
  return [...rows].sort((a, b) => ord[a.mark] - ord[b.mark] || b.score - a.score || a.usd - b.usd);
}

/** night_bundle_candidates の1行から「効く q…」「守り q…」を拾う（新しい問題 新5426 等は new5426） */
export function parseCandidateLine(line: string): { switches: string[]; eff: string[]; guards: string[]; stage: "brain" | "draft" | null } | null {
  const ids = (s: string) => [...s.matchAll(/(?:\bq\d{3}\b|新\d{3,5})/g)].map((m) => (m[0].startsWith("新") ? `new${m[0].slice(1)}` : m[0]));
  const ef = line.match(/効く([^／|]*)/), gd = line.match(/守り([^）|]*)/);
  if (!ef) return null;
  const eff = ids(ef[1]);
  if (!eff.length) return null;
  const switches = [...new Set([...line.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)].map((m) => m[0]))];
  const stage = /stage=draft|下書き/.test(line) ? "draft" : /stage=brain|ブレイン/.test(line) ? "brain" : null;
  return { switches, eff, guards: gd ? ids(gd[1]) : [], stage };
}
