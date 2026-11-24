// scripts/lib/exam-worth.ts — 積む前の「試験の値打ちの表」の計算（純関数・LLM なし・DB なし）
// 2026-11-24 作業員A（竹内さん 11/24「試験の改善を優先する」・統括役の頼み: 差が何も無かった本が費用の52%）
//   1行＝1つの組（スイッチ）。余地＝効く問題のうち今の off で外れている数（直せる余地）。重み＝竹内さん本人の番でその型が出る頻度の目安。
//   余地は過半数の回で外れている問題（揺れて半分以上合格は数えない）。値打ち＝余地×重み÷費用。余地0（効く問題が今の off で全部合格＝良くなりようがない）の組は「積まない」の印（悪化だけを見る組は守りの組として別に扱う）。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  // 2026-11-24 夜: 「効く」は「守り」の手前で切る（「…を効く問題、守り q065…」で守りを効く側に読んでいた＝APPLY_READINESS_WIDE）
  const ef = line.match(/効く(.*?)(?=守り|／|\||$)/), gd = line.match(/守り([^）|／]*)/);
  if (!ef) return null;
  const eff = ids(ef[1]);
  if (!eff.length) return null;
  const switches = [...new Set([...line.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)].map((m) => m[0]))];
  const stage = /stage=draft|下書き/.test(line) ? "draft" : /stage=brain|ブレイン/.test(line) ? "brain" : null;
  return { switches, eff, guards: gd ? ids(gd[1]) : [], stage };
}

/**
 * 2026-11-24 夜 作業員A（統括役の頼み）: night_bundle_candidates の候補の書式（新しい書き方・これに合わせて書く）
 *   - 組: <名前>（<スイッチ>=on・--stage=brain|draft）
 *     - 効く: q089・q112・新5426
 *     - 守り: q071・q350
 *   「効く:」「守り:」はそれぞれ別の行（行頭の「- 」と字下げは問わない・コロンは : か ：）。組の行の次の「- 組:」か見出し（#）までが1つの組。
 *   新しい書式の組が1つでもあれば、その組を使う（古い1行の書き方は、新しい書式の組に無いスイッチだけ拾う）
 */
export type CandidateGroup = { name: string; switches: string[]; eff: string[]; guards: string[]; stage: "brain" | "draft" | null };
export function parseCandidateBlocks(lines: readonly string[]): CandidateGroup[] {
  const ids = (x: string) => [...x.matchAll(/(?:\bq\d{3}\b|新\d{3,5})/g)].map((m) => (m[0].startsWith("新") ? `new${m[0].slice(1)}` : m[0]));
  const out: CandidateGroup[] = [];
  let cur: CandidateGroup | null = null;
  for (const raw of lines) {
    const l = raw.trim().replace(/^[-*]\s*/, "");
    const g = l.match(/^組\s*[:：]\s*(.+)$/);
    if (g) {
      cur = { name: g[1].trim(), switches: [...new Set([...g[1].matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)].map((m) => m[0]))], eff: [], guards: [], stage: /stage=draft/.test(g[1]) ? "draft" : /stage=brain/.test(g[1]) ? "brain" : null };
      out.push(cur); continue;
    }
    if (/^#/.test(raw.trim())) { cur = null; continue; }
    if (!cur) continue;
    const e = l.match(/^効く\s*[:：]\s*(.*)$/); if (e) { cur.eff.push(...ids(e[1])); continue; }
    const d = l.match(/^守り\s*[:：]\s*(.*)$/); if (d) { cur.guards.push(...ids(d[1])); continue; }
  }
  return out.filter((x) => x.eff.length).map((x) => ({ ...x, eff: [...new Set(x.eff)], guards: [...new Set(x.guards)].filter((y) => !x.eff.includes(y)) }));
}

/** off の基準の置き場から、問題ごとの off の合否（at より前の一番新しい答え・at を省くと今） */
export function loadOffPass(baselineDir: string, at: number = Date.now()): Map<string, OffPass> {
  const best = new Map<string, { t: number; pass: number; n: number }>();
  let dirs: string[] = []; try { dirs = readdirSync(baselineDir).filter((d) => /^(?:v-[0-9a-f]+|[0-9a-f]{10})-[0-9a-f]{10}$/.test(d)); } catch { return new Map(); }
  for (const d of dirs) {
    let files: string[] = []; try { files = readdirSync(join(baselineDir, d)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".json") || f === "config.json") continue;
      try {
        const b = JSON.parse(readFileSync(join(baselineDir, d, f), "utf8")) as { id?: string; savedAt?: string; rows?: Array<{ error?: string; score?: { pass?: boolean } }> };
        if (!b.id || !b.savedAt || !b.rows) continue;
        const t = Date.parse(b.savedAt); if (!(t <= at)) continue;
        const ok = b.rows.filter((x) => !x.error); if (!ok.length) continue;
        const cur = best.get(b.id); if (cur && cur.t >= t) continue;
        best.set(b.id, { t, pass: ok.filter((x) => x.score?.pass).length, n: ok.length });
      } catch { /* 読めない答えは飛ばす */ }
    }
  }
  return new Map([...best].map(([id, v]) => [id, { pass: v.pass, n: v.n }]));
}
/** 積む前の関所（exam-conductor --add）: 効く問題が全部 off の答えあり・全部過半数で合格＝余地0 なら止める。余地不明（off の答えが無い問題がある）は止めない */
export function worthGate(eff: readonly string[], off: ReadonlyMap<string, OffPass>): { block: boolean; line: string } {
  const r = roomOf(eff, off);
  if (!eff.length) return { block: false, line: "効く問題が無い（値打ちの関所は見ない）" };
  if (r.unknown.length) return { block: false, line: `余地 ${r.room}/${eff.length}（off の答えが無い ${r.unknown.length}問＝余地不明・積む）` };
  if (r.room === 0) return { block: true, line: `余地0: 効く問題 ${eff.length}問が今の off で全部過半数合格（良くなりようがない）` };
  return { block: false, line: `余地 ${r.room}/${eff.length}（${r.roomIds.join(",")}）` };
}
