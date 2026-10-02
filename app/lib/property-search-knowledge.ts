// app/lib/property-search-knowledge.ts（純関数・DB 依存なし）
// 物件検索の「整理済みの知識」（DB property_search_knowledge）の組み立てと読み方。LLM は使わない。
//
// 2026-10-02 竹内「物件検索のところちゃんと知識積み重なるようになっているのか」→ property_search_knowledge は 8/22 に作られ0行・
//   どこからも使われていなかった。⑯ 手順4b で「書く所（決定論）」と「読む所（ブレイン・resolve-area）」を付けた。
// ■ 知識の種類
//   desired_to_delivered: お客様の希望の駅・区（key＝station:<まとまりの代表>／ward:<区・市>）→ スタッフが実際にお客様へ届けた部屋の駅・区。
//     正解はスタッフが選んで届けた事実（feedback_property_selection_label）。人数で数える（部屋数だと1人の大量送付に引っ張られる）。
//     申込に進んだ人（conversations.is_post_apply）の届け先も別に数える＝「梅田が希望の人に、十三・中津も届けて申込に進んだ」
//   area_restatement: お客様のエリアの言い直し（property_condition_history desired_area の前 → 後）。前の key → 後の key の人数・申込に進んだ人数。
// ■ 決め事
//   ・読む時は人数 KNOWLEDGE_RULE.minCustomers 以上だけ（1人の癖を知識にしない）。希望の駅そのもの（同じまとまり）は「届けた別の駅」から外す
//   ・お客様の名前・発言・電話は持たない（数と駅・区だけ）
import { normStation, wardOfStation } from "./osaka-geo";

export const KNOWLEDGE_RULE = {
  /** 読む（ブレイン・resolve-area に出す）最小の人数 */
  minCustomers: 2,
  /** 1つの知識に持つ駅・区の数 */
  maxItems: 12,
} as const;

export type KnowledgeKind = "desired_to_delivered" | "area_restatement" | "area_profile";
export type CountItem = { name: string; customers: number; units?: number };
export type DeliveredPayload = {
  customers: number; units: number;
  stations: CountItem[]; wards: CountItem[];
  applied_customers: number; applied_stations: CountItem[];
};
export type RestatementPayload = { customers: number; to: CountItem[]; applied_customers: number };
export type KnowledgeRow = { kind: KnowledgeKind; key: string; payload: DeliveredPayload | RestatementPayload; evidence_count: number; title: string; content: string };

/** 希望の駅・区 → 知識の鍵 */
export const stationKey = (groupKey: string) => `station:${groupKey}`;
export const wardKey = (ward: string) => `ward:${ward}`;
export const keyLabel = (key: string) => key.replace(/^station:/, "").replace(/^ward:大阪市/, "").replace(/^ward:/, "");

export type CustomerFacts = {
  /** お客様の希望の鍵（希望の駅のまとまり・希望の区・出やすい／1本の基準の駅） */
  keys: string[];
  /** 届けた部屋（駅・区。分からない物は null） */
  delivered: Array<{ station: string | null; ward: string | null }>;
  applied: boolean;
  /** 希望の駅のまとまりの駅（届けた別の駅から外す） */
  ownStations: string[];
};

const top = (m: Map<string, Set<string> | number>, n: number): CountItem[] =>
  [...m].map(([name, v]) => ({ name, customers: typeof v === "number" ? v : v.size })).sort((a, b) => b.customers - a.customers || a.name.localeCompare(b.name, "ja")).slice(0, n);

/** お客様ごとの事実 → 希望の鍵ごとの「届けた駅・区」 */
export function buildDeliveredKnowledge(rows: Array<CustomerFacts & { id: string }>): KnowledgeRow[] {
  const byKey = new Map<string, { custs: Set<string>; units: number; st: Map<string, Set<string>>; wd: Map<string, Set<string>>; applied: Set<string>; ast: Map<string, Set<string>> }>();
  for (const r of rows) {
    if (!r.delivered.length) continue;
    for (const k of new Set(r.keys)) {
      const a = byKey.get(k) ?? { custs: new Set(), units: 0, st: new Map(), wd: new Map(), applied: new Set(), ast: new Map() };
      a.custs.add(r.id);
      a.units += r.delivered.length;
      if (r.applied) a.applied.add(r.id);
      for (const d of r.delivered) {
        if (d.station && !r.ownStations.includes(d.station)) {
          (a.st.get(d.station) ?? a.st.set(d.station, new Set()).get(d.station)!).add(r.id);
          if (r.applied) (a.ast.get(d.station) ?? a.ast.set(d.station, new Set()).get(d.station)!).add(r.id);
        }
        if (d.ward) (a.wd.get(d.ward) ?? a.wd.set(d.ward, new Set()).get(d.ward)!).add(r.id);
      }
      byKey.set(k, a);
    }
  }
  const out: KnowledgeRow[] = [];
  for (const [key, a] of byKey) {
    const payload: DeliveredPayload = {
      customers: a.custs.size, units: a.units,
      stations: top(a.st, KNOWLEDGE_RULE.maxItems), wards: top(a.wd, KNOWLEDGE_RULE.maxItems),
      applied_customers: a.applied.size, applied_stations: top(a.ast, KNOWLEDGE_RULE.maxItems),
    };
    out.push({ kind: "desired_to_delivered", key, payload, evidence_count: a.custs.size, title: `${keyLabel(key)}が希望の人にスタッフが届けた駅・区`, content: deliveredLine(key, payload) });
  }
  return out.sort((x, y) => y.evidence_count - x.evidence_count);
}

/** エリアの言い直し（前の鍵 → 後の鍵） */
export function buildRestatementKnowledge(pairs: Array<{ id: string; from: string[]; to: string[]; applied: boolean }>): KnowledgeRow[] {
  const byKey = new Map<string, { custs: Set<string>; to: Map<string, Set<string>>; applied: Set<string> }>();
  for (const p of pairs) {
    const added = p.to.filter((k) => !p.from.includes(k));
    if (!added.length) continue;
    for (const f of new Set(p.from)) {
      const a = byKey.get(f) ?? { custs: new Set(), to: new Map(), applied: new Set() };
      a.custs.add(p.id);
      if (p.applied) a.applied.add(p.id);
      for (const t of added) (a.to.get(t) ?? a.to.set(t, new Set()).get(t)!).add(p.id);
      byKey.set(f, a);
    }
  }
  const out: KnowledgeRow[] = [];
  for (const [key, a] of byKey) {
    const payload: RestatementPayload = { customers: a.custs.size, to: top(a.to, KNOWLEDGE_RULE.maxItems), applied_customers: a.applied.size };
    out.push({ kind: "area_restatement", key, payload, evidence_count: a.custs.size, title: `${keyLabel(key)}からのエリアの言い直し`, content: `${keyLabel(key)}の希望から言い直した先: ${payload.to.map((x) => `${keyLabel(x.name)}${x.customers}人`).join("・")}（${payload.customers}人・申込に進んだ ${payload.applied_customers}人）` });
  }
  return out.sort((x, y) => y.evidence_count - x.evidence_count);
}

/** ブレイン・スタッフ向けの1行（事実だけ・人数つき） */
export function deliveredLine(key: string, p: DeliveredPayload): string {
  const st = p.stations.filter((x) => x.customers >= KNOWLEDGE_RULE.minCustomers).slice(0, 8).map((x) => `${x.name}${x.customers}人`).join("・");
  const wd = p.wards.slice(0, 5).map((x) => `${keyLabel(`ward:${x.name}`)}${x.customers}人`).join("・");
  const ap = p.applied_stations.slice(0, 5).map((x) => `${x.name}${x.customers}人`).join("・");
  return `${keyLabel(key)}が希望のお客様${p.customers}人に、スタッフが届けた部屋の別の駅: ${st || "（2人以上の駅なし）"}／区: ${wd}${p.applied_customers ? `／申込に進んだ${p.applied_customers}人の駅: ${ap || "-"}` : ""}`;
}

/** 読む時の線（人数が足りる物だけ） */
export function readable<T extends { evidence_count: number }>(rows: T[]): T[] {
  return rows.filter((r) => r.evidence_count >= KNOWLEDGE_RULE.minCustomers);
}

/** 駅名 → 駅のまとまりの代表（groupOf が無い所で使う簡易版: 名前をそろえるだけ） */
export function stationName(raw: string | null | undefined): string | null {
  const s = normStation(String(raw ?? ""));
  return s || null;
}
export { wardOfStation };

// ───────────────────────── 整理（手順5・決定論） ─────────────────────────
// 2026-10-02 竹内「知識溜まってもちゃんと整理するような環境もつくる」。週1回の作り直しの後に、決定論で:
//   ・統合: 同じ種類で、鍵をそろえる（駅のまとまりの代表）と同じになる今の行が2つ以上 → 根拠の人数の多い方を残し、他を退役（merged）
//   ・退役: 作り直しで出てこなくなった鍵（根拠が無くなった）→ is_current=false・retired_reason（消さない）
//   ・食い違い: 届け先の1番の駅が前回と入れ替わった（どちらも2人以上）→ 記録（payload.prev_top・報告）。自動で消さない
//   ・読まれない: 読める（2人以上）のに作って30日以上一度も読まれない → 報告だけ（読まれない理由は入口の側にある事が多い）
// DeepSeek は使わない: 鍵は文ではなく駅・区に直してあるので「似た言い方の統合」が要らない（言い方の揺れは parseAreaWant が吸収済み）

export type ExistingKnowledge = { id: string; kind: string; key: string; evidence_count: number; payload: any; created_at: string; last_used_at: string | null; use_count: number };
export type CurationPlan = {
  update: Array<{ id: string; row: KnowledgeRow; prevTop: string | null }>;
  insert: KnowledgeRow[];
  retire: Array<{ id: string; reason: string }>;
  conflicts: Array<{ key: string; before: string; after: string }>;
  unread: string[];
  kept: number;
};

const topStation = (p: any): { name: string; customers: number } | null => (Array.isArray(p?.stations) && p.stations[0] ? p.stations[0] : null);

/** 今の行と作り直しの結果から、整理の手順を決める（DB に触れない） */
export function planCuration(existing: ExistingKnowledge[], produced: KnowledgeRow[], opts: { nowMs: number; normKey?: (k: string) => string; kinds: string[] }): CurationPlan {
  const norm = opts.normKey ?? ((k: string) => k);
  const plan: CurationPlan = { update: [], insert: [], retire: [], conflicts: [], unread: [], kept: 0 };
  // 統合（同じ種類×そろえた鍵が2つ以上の今の行）
  const groups = new Map<string, ExistingKnowledge[]>();
  for (const e of existing) { const g = `${e.kind}|${norm(e.key)}`; groups.set(g, [...(groups.get(g) ?? []), e]); }
  const survivors = new Map<string, ExistingKnowledge>();
  for (const [g, es] of groups) {
    const sorted = [...es].sort((a, b) => b.evidence_count - a.evidence_count || a.created_at.localeCompare(b.created_at));
    survivors.set(g, sorted[0]);
    for (const e of sorted.slice(1)) plan.retire.push({ id: e.id, reason: `merged: ${sorted[0].key} に統合` });
  }
  const producedKeys = new Set(produced.map((r) => `${r.kind}|${norm(r.key)}`));
  for (const r of produced) {
    const s = survivors.get(`${r.kind}|${norm(r.key)}`);
    if (!s) { plan.insert.push(r); continue; }
    let prevTop: string | null = null;
    if (r.kind === "desired_to_delivered") {
      const b = topStation(s.payload), a = topStation(r.payload);
      if (b && a && b.name !== a.name && b.customers >= KNOWLEDGE_RULE.minCustomers && a.customers >= KNOWLEDGE_RULE.minCustomers) {
        plan.conflicts.push({ key: r.key, before: b.name, after: a.name });
        prevTop = b.name;
      }
    }
    plan.update.push({ id: s.id, row: r, prevTop });
    plan.kept++;
  }
  for (const [g, s] of survivors) {
    if (!opts.kinds.includes(s.kind)) continue; // この作り直しで作らない種類は触らない
    if (!producedKeys.has(g)) plan.retire.push({ id: s.id, reason: "not_produced: 作り直しで根拠が無くなった" });
    else if (s.evidence_count >= KNOWLEDGE_RULE.minCustomers && !s.last_used_at && opts.nowMs - Date.parse(s.created_at) > 30 * 86400_000) plan.unread.push(s.key);
  }
  return plan;
}

// ───────────────────────── 区のまとめ（area_profile・決定論） ─────────────────────────
export type WardRentCell = { ward: string; plan_group: string; n: number; p25: number; p50: number; p75: number };
export type WardAccess = { ward: string; toNamba: number | null; toUmeda: number | null; stations: number };

/** 区ごとの短いまとめ（相場の言える間取り・なんば/梅田までの最短・届け先の知識）。ブレインが安く読む用 */
export function buildAreaProfiles(cells: WardRentCell[], access: WardAccess[], delivered: KnowledgeRow[], minCount: number): KnowledgeRow[] {
  const wards = new Set([...cells.filter((c) => c.n >= minCount).map((c) => c.ward), ...access.filter((a) => a.stations > 0).map((a) => a.ward)]);
  const out: KnowledgeRow[] = [];
  const man = (v: number) => (Math.round(v / 1000) / 10).toFixed(1).replace(/\.0$/, "");
  for (const w of wards) {
    const cs = cells.filter((c) => c.ward === w && c.n >= minCount).sort((a, b) => ["1K", "1DK", "1LDK", "2DK", "2LDK", "3+"].indexOf(a.plan_group) - ["1K", "1DK", "1LDK", "2DK", "2LDK", "3+"].indexOf(b.plan_group));
    const ac = access.find((a) => a.ward === w);
    const dk = delivered.find((d) => d.key === `ward:${w}` && d.evidence_count >= KNOWLEDGE_RULE.minCustomers);
    if (!cs.length && !ac) continue;
    const parts: string[] = [];
    if (cs.length) parts.push(`相場（管理費込み・中央値・件数）: ${cs.map((c) => `${c.plan_group} ${man(c.p50)}万（${man(c.p25)}〜${man(c.p75)}万・${c.n}件）`).join("／")}`);
    if (ac && (ac.toNamba != null || ac.toUmeda != null)) parts.push(`電車の最短（乗換1回まで）: なんば ${ac.toNamba ?? "-"}分・梅田 ${ac.toUmeda ?? "-"}分`);
    if (dk) parts.push(`この区が希望の人に届けた別の駅: ${(dk.payload as DeliveredPayload).stations.filter((s) => s.customers >= KNOWLEDGE_RULE.minCustomers).slice(0, 5).map((s) => `${s.name}${s.customers}人`).join("・") || "-"}`);
    const n = cs.reduce((a, c) => a + c.n, 0);
    out.push({ kind: "area_profile" as KnowledgeKind, key: `ward:${w}`, payload: { cells: cs, access: ac ?? null } as any, evidence_count: n, title: `${keyLabel(`ward:${w}`)}のまとめ`, content: `${keyLabel(`ward:${w}`)}｜${parts.join("｜")}` });
  }
  return out;
}
