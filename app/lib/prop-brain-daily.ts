// app/lib/prop-brain-daily.ts — 物件出し（AIX ツール）のブレインの毎日の物差し（純関数・DB/LLM なし）
//
// 2026-11-18 作業員K（統括役の付け忘れ防止の表「物件出しのブレインの6つ」の①）。11/15 の一回きりの数え（scripts/audit-prop-brain-score.ts・
//   audit-condition-reach.ts）と同じ形を、毎朝同じ物差しで数える。連携の地図（linkage-map）の AIX ツールの段の行の audit 名「audit-prop-brain-score」とそろえる。
//   ① 🌟一致: 売上サポの🌟（recommendation_snapshots.candidates[].star）がスタッフの🌟（is_star）と同じ割合（書き手＝竹内さん／従業員ごと）
//   ② 上位: スタッフの🌟が拡張の回の順位（pool_rank）で上位3・上位10に入る割合
//   ③ 条件の届き: お客様の条件の発言（condition-reading の種類）が、発言の1分前〜30分後に物件顧客の列に書かれたか（履歴）／既に入っていたか／
//      その発言の後30分以内に物件顧客の行が作られた（作った時に入った＝履歴に残らない）か
// 読むのは呼ぶ側（cron の route と scripts/prop-brain-daily.ts）。ここは数えるだけ。
import { classifyConditionTurn } from "./condition-source-gate";
import { readConditionStatements, type ConditionStatementKind } from "./condition-reading";
import { isFilledSumoraForm } from "./condition-format";

export const PROP_BRAIN_DAILY_AUDIT = "audit-prop-brain-score";

type Row = Record<string, unknown>;
export type Writer = "takeuchi" | "employee" | "unknown";
export type SnapLite = { candidates: unknown; writer: Writer };
export type StarStats = { snaps: number; toolStarN: number; toolStarHit: number; poolN: number; top3: number; top10: number };

function candsOf(v: unknown): Row[] {
  const x = typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return []; } })() : v;
  return Array.isArray(x) ? (x as Row[]) : [];
}

export function starStats(snaps: ReadonlyArray<SnapLite>): Record<"all" | Writer, StarStats> {
  const empty = (): StarStats => ({ snaps: 0, toolStarN: 0, toolStarHit: 0, poolN: 0, top3: 0, top10: 0 });
  const out: Record<"all" | Writer, StarStats> = { all: empty(), takeuchi: empty(), employee: empty(), unknown: empty() };
  for (const s of snaps) {
    const cs = candsOf(s.candidates);
    const star = cs.find((c) => c.is_star === true);
    if (!star) continue;
    for (const g of [out.all, out[s.writer]]) {
      g.snaps++;
      const tool = cs.filter((c) => c.star);
      if (tool.length) { g.toolStarN++; if (tool.some((c) => c.is_star === true)) g.toolStarHit++; }
      const r = Number(star.pool_rank);
      if (star.pool_rank != null && Number.isFinite(r)) { g.poolN++; if (r <= 3) g.top3++; if (r <= 10) g.top10++; }
    }
  }
  return out;
}

/** 種類 → 書く列（scripts/audit-condition-reach.ts と同じ表） */
export const REACH_FIELDS: Record<ConditionStatementKind, string[]> = {
  エリア: ["desired_area"], 家賃: ["rent_max", "rent_min"], 間取り: ["floor_plan"], 入居時期: ["move_in_time"], NG: ["ng_points"], 設備: ["preferences", "other_requests", "ng_points"],
  通勤: ["commute_station", "commute_minutes"], ペット: ["pet", "preferences", "other_requests"], 徒歩: ["walk_minutes"],
} as Record<ConditionStatementKind, string[]>;

export type ReachMsg = { conversation_id: string; text: string | null; created_at: string };
export type ReachHist = { property_customer_id: string; changed_field: string; created_at: string };
export type ReachStats = { n: number; reached: number; atCreate: number; already: number; missed: number; byKind: Record<string, { n: number; ok: number }> };

export function conditionReachStats(i: {
  msgs: ReadonlyArray<ReachMsg>;
  pcOfConv: ReadonlyMap<string, string>;
  hist: ReadonlyArray<ReachHist>;
  pcRow: ReadonlyMap<string, Row>;
}): ReachStats {
  const histByPc = new Map<string, ReachHist[]>();
  for (const h of i.hist) { const k = h.property_customer_id; if (!histByPc.has(k)) histByPc.set(k, []); histByPc.get(k)!.push(h); }
  const out: ReachStats = { n: 0, reached: 0, atCreate: 0, already: 0, missed: 0, byKind: {} };
  for (const m of i.msgs) {
    const pc = i.pcOfConv.get(m.conversation_id);
    if (!pc || !m.text || isFilledSumoraForm(m.text) || (m.text.match(/[①②③④⑤⑥⑦⑧]/g) ?? []).length >= 2) continue;
    const turn = classifyConditionTurn(m.text);
    if (!turn.conditionText) continue;
    const kinds = [...new Set(readConditionStatements(m.text).map((x) => x.kind))];
    if (!kinds.length) continue;
    const t = Date.parse(m.created_at);
    const near = (histByPc.get(pc) ?? []).filter((h) => { const x = Date.parse(h.created_at); return x >= t - 60_000 && x <= t + 30 * 60_000; });
    const row = i.pcRow.get(pc) ?? {};
    const created = Date.parse(String(row.created_at ?? ""));
    for (const k of kinds) {
      const fields = REACH_FIELDS[k] ?? [];
      const bk = (out.byKind[k] ??= { n: 0, ok: 0 });
      out.n++; bk.n++;
      if (near.some((h) => fields.includes(h.changed_field))) { out.reached++; bk.ok++; continue; }
      if (Number.isFinite(created) && created >= t - 60_000 && created <= t + 30 * 60_000 && fields.some((f) => row[f] != null && String(row[f]).trim() !== "")) { out.atCreate++; bk.ok++; continue; }
      const cur = fields.map((f) => String(row[f] ?? "")).join(" ");
      if (k === "間取り") {
        const lay = turn.conditionText.match(/[1-4１-４]\s?(?:SLDK|LDK|DK|K|R)/);
        if (lay && cur.includes(lay[0].replace(/\s/g, ""))) { out.already++; bk.ok++; continue; }
      }
      out.missed++;
    }
  }
  return out;
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
export function propBrainDailySummary(s: Record<"all" | Writer, StarStats>, r: ReachStats, days: number): string {
  const a = s.all, t = s.takeuchi, e = s.employee;
  return `物件出し ${days}日: 🌟一致 ${pct(a.toolStarHit, a.toolStarN)}（竹内さん ${pct(t.toolStarHit, t.toolStarN)}・従業員 ${pct(e.toolStarHit, e.toolStarN)}・${a.toolStarN}回）`
    + `・🌟が拡張の上位3 ${pct(a.top3, a.poolN)}・上位10 ${pct(a.top10, a.poolN)}（${a.poolN}回）`
    + `・条件の届き ${pct(r.reached + r.atCreate + r.already, r.n)}（発言 ${r.n}・届かない ${r.missed}）`;
}
