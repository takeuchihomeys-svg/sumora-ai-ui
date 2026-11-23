// scripts/lib/metric-map-server.ts — 数ごとの地図（木）を作って書く・見込みを実測と突き合わせる（読む・書く・LLM なし・作業員P・2026-11-23・台帳 #610）
//   純な計算は app/lib/metric-map.ts。ここは DB の読み書きだけ。
//   重い読み（60日の AIX の番の木）は夜（JST 22〜9時）だけ・1日1回（今日の行があれば作らない）。昼は前に作った木を読むだけ（営業時間は全件読みしない）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkConductor } from "../check-conductor";
import {
  MAP_ROOTS, rootOf, covers, buildTree, sumMismatches, rankLeaves, leavesOf, forecastVerdictOf, dueChecksOf, gapCauseHintOf, sceneOfWatchKey, relatedFoundationOf,
  itemsForRoot, rebaseKey, deviceTurnsOf, routeTurnsOf, holesOf, type DeviceTurnRow, type RouteTurnRow,
  MAP_CAUSE_JA, type MapNode, type MapRootDef, type MapTurn, type ForecastItem, type RankedLeaf, type WriterSelect, type MapCause,
} from "../../app/lib/metric-map";

export const jstDay = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
export const isNightJst = (ms = Date.now()) => { const h = new Date(ms + 9 * 3600e3).getUTCHours(); return h >= 22 || h < 9; };

export const ITEM_COLS = "id,title,stage,owner,priority,switch_name,switch_default,next_step,blocker,done_at,updated_at,forecast_metric,forecast_leaf,forecast_writer_select,forecast_window_days,forecast_before,forecast_before_n,forecast_low,forecast_high,forecast_basis,forecast_at,forecast_start_at,measured_after,measured_n,measured_at,forecast_checks,forecast_verdict,forecast_gap_cause,forecast_gap_note,forecast_exam";
export type ItemRow = ForecastItem & {
  done_at: string | null; updated_at: string; forecast_window_days: number | null; forecast_before_n: number | null; forecast_basis: string | null; forecast_at: string | null; forecast_start_at: string | null;
  measured_after: number | null; measured_n: number | null; measured_at: string | null; forecast_checks: Array<{ day: number; value: number | null; n: number | null; verdict: string; at: string; cause_hint?: string | null }> | null;
  forecast_verdict: string | null; forecast_gap_cause: string | null; forecast_gap_note: string | null; forecast_exam: Record<string, unknown> | null;
};
const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
const normItem = (r: Record<string, unknown>): ItemRow => ({ ...(r as unknown as ItemRow), forecast_before: num(r.forecast_before), forecast_low: num(r.forecast_low), forecast_high: num(r.forecast_high), measured_after: num(r.measured_after) });

/** 見込みの付いた作業（数か葉のどちらかがある・done/dropped も突き合わせのため読む） */
export async function loadForecastItems(sb: SupabaseClient): Promise<ItemRow[]> {
  const { data, error } = await sb.from("work_items").select(ITEM_COLS).or("forecast_metric.not.is.null,forecast_leaf.not.is.null").limit(1000);
  if (error) throw new Error(`work_items: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map(normItem);
}
/** 見込みの無い P0/P1 の作業（done・dropped を除く）。priority 0/1 を P0/P1 とみる */
export async function loadUnforecastTop(sb: SupabaseClient) {
  const { data } = await sb.from("work_items").select("id,title,owner,stage,priority").in("priority", [0, 1]).is("forecast_metric", null).not("stage", "in", "(done,dropped)").limit(300);
  return (data ?? []) as Array<{ id: number; title: string; owner: string | null; stage: string; priority: number }>;
}

/** 主の根を先に（同じ数の版が2つある時・11/23 統括役「主は端末の版」） */
export const rootsInOrder = (roots: readonly MapRootDef[] = MAP_ROOTS) => [...roots].sort((a, b) => Number(!!b.primary) - Number(!!a.primary));

/** 出所の台本の json から木を作る（端末の版＝作業員A の audit-aix-turn-judgment・申込までの地図＝作業員R の audit-route-progress-takeuchi）。
 *  台本は夜だけの重い読み＝ここは json を読むだけ。端末の版の場面は見張りの scene_key を番の id で引く（100番ほどの軽い読み） */
export async function buildTreeFromJson(sb: SupabaseClient, def: MapRootDef, rows: unknown[]): Promise<{ nodes: MapNode[]; value: number | null; n: number } | null> {
  let turns: MapTurn[] = [];
  if (def.builder === "aix_turn_device") {
    const rs = rows as DeviceTurnRow[];
    const ids = [...new Set(rs.filter((r) => r.cls !== "reply").map((r) => r.id))];
    const scene = new Map<number, string | null>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await sb.from("line_watch_turns").select("id,scene_key").in("id", ids.slice(i, i + 200));
      if (error) throw new Error(`line_watch_turns: ${error.message}`);
      for (const r of (data ?? []) as Array<{ id: number; scene_key: string | null }>) scene.set(r.id, r.scene_key);
    }
    turns = deviceTurnsOf(rs, scene);
  } else if (def.builder === "route_next") turns = routeTurnsOf(rows as RouteTurnRow[]);
  else return null;
  const nodes = buildTree(turns, def);
  return { nodes, value: nodes[0]?.value ?? null, n: nodes[0]?.n ?? 0 };
}

const ccCache = new Map<string, ReturnType<typeof checkConductor>>();
/** 根1つの木を作る（台帳の読みで作れる根だけ＝conductor_aix）。値は出所のスクリプトと同じ数え方 */
export async function buildRootTree(def: MapRootDef, o: { sinceMs?: number } = {}): Promise<{ nodes: MapNode[]; value: number | null; n: number } | null> {
  if (def.builder !== "conductor_aix") return null;
  // 同じ窓の読みは1回だけ（文の癖の版と端末の版で checkConductor を2回回さない＝夜の重い読みを増やさない）
  const ck = `${def.windowDays}:${o.sinceMs ?? ""}`;
  if (!ccCache.has(ck)) ccCache.set(ck, checkConductor(def.windowDays, o.sinceMs));
  const cc = await ccCache.get(ck)!;
  // 端末の版（writerSelect=device）は作業員A の devOf で選んだ番（turnsDevice・aixScoreDevice）
  const dev = def.writerSelect === "device";
  const src = dev ? cc.turnsDevice : cc.turns;
  const turns: MapTurn[] = src.map((t) => ({ id: t.id, kind: t.kind || "other", scene: sceneOfWatchKey(t.sceneKey, t.kind), miss: t.miss, cause: t.cause as MapCause | null }));
  const nodes = buildTree(turns, def);
  return { nodes, value: dev ? cc.aixScoreDevice : cc.aixScore, n: dev ? cc.aixTurnsDevice : cc.aixTurns };
}

/** 試験の問題の数を葉ごとに（exam_leaf_links）。付け替え元の根（端末の版は文の癖の版）に当てた問題も、葉の鍵を付け替えて数える */
export async function examCountByLeaf(sb: SupabaseClient, root: string): Promise<Map<string, number>> {
  const def = rootOf(root);
  const roots = [root, ...(def?.rebaseFrom ?? [])];
  const { data } = await sb.from("exam_leaf_links").select("root_metric,leaf_key").in("root_metric", roots).limit(5000);
  const m = new Map<string, number>();
  for (const r of (data ?? []) as Array<{ root_metric: string; leaf_key: string }>) { const k = rebaseKey(r.leaf_key, r.root_metric, root); m.set(k, (m.get(k) ?? 0) + 1); }
  return m;
}

/** 木を metric_map_nodes に書く（日 × 根 × 書き手の選び方で入れ替え） */
export async function writeTree(sb: SupabaseClient, day: string, def: MapRootDef, nodes: MapNode[], ranked: RankedLeaf[], foundRows: Array<{ metric: string; value: number | null; detail?: { cause?: string } | null }> = []) {
  const rk = new Map(ranked.map((r) => [r.key, r]));
  const leafKeys = new Set(leavesOf(nodes).map((l) => l.key));
  const rows = nodes.map((x) => {
    const r = rk.get(x.key);
    const rel = leafKeys.has(x.key) ? relatedFoundationOf(x.key, foundRows) : [];
    return {
      day, root_metric: def.metric, writer_select: def.writerSelect, window_days: def.windowDays, node_key: x.key, parent_key: x.parent, depth: x.depth, dim: x.dim, val: x.val, label: x.label,
      n: x.n, ok: x.ok, misses: x.misses, value: x.value, is_leaf: leafKeys.has(x.key), hold: r?.hold ?? false, hole: r?.hole ?? false, gain: r?.gain ?? null, score: r?.score ?? null, rank: r?.rank ?? null,
      item_ids: r?.items ?? [], next_step: r?.nextStep ?? null, blocker: r?.blocker ?? null, exam_problems: r?.examProblems ?? null, detail: rel.length ? { foundation_gaps: rel.slice(0, 12) } : null,
    };
  });
  await sb.from("metric_map_nodes").delete().eq("day", day).eq("root_metric", def.metric).eq("writer_select", def.writerSelect);
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await sb.from("metric_map_nodes").insert(rows.slice(i, i + 200));
    if (error) throw new Error(`metric_map_nodes: ${error.message}`);
  }
  return rows.length;
}

/** 前に作った木（最新の日）を読む */
export async function readLatestTree(sb: SupabaseClient, root: string, writer: WriterSelect) {
  const { data: d } = await sb.from("metric_map_nodes").select("day").eq("root_metric", root).eq("writer_select", writer).order("day", { ascending: false }).limit(1);
  const day = (d?.[0] as { day?: string } | undefined)?.day ?? null;
  if (!day) return { day: null, rows: [] as Array<Record<string, unknown>> };
  const { data } = await sb.from("metric_map_nodes").select("*").eq("root_metric", root).eq("writer_select", writer).eq("day", day).order("depth").limit(3000);
  return { day, rows: (data ?? []) as Array<Record<string, unknown>> };
}
export const nodesFromRows = (rows: ReadonlyArray<Record<string, unknown>>): MapNode[] => rows.map((r) => ({
  key: String(r.node_key), parent: (r.parent_key as string | null) ?? null, depth: Number(r.depth), dim: (r.dim as MapNode["dim"]) ?? null, val: (r.val as string | null) ?? null, label: String(r.label ?? ""),
  n: Number(r.n), ok: Number(r.ok), misses: Number(r.misses), value: num(r.value),
}));

/** quality_daily の最新（数の名前・範囲） */
export async function latestQd(sb: SupabaseClient, metric: string, scope: string, sinceDay?: string) {
  let q = sb.from("quality_daily").select("day,value,n,source").eq("metric", metric).eq("scope", scope).order("day", { ascending: false }).limit(1);
  if (sinceDay) q = q.gte("day", sinceDay);
  const { data } = await q;
  const r = (data?.[0] ?? null) as { day: string; value: number | null; n: number | null; source: string | null } | null;
  return r ? { ...r, value: num(r.value) } : null;
}

/** 前方一致の根（欄ごとの数の束）の最新（3日以内・名前ごとに最新1行） */
export async function latestQdPrefix(sb: SupabaseClient, prefix: string, scope: string, now = Date.now()) {
  const { data } = await sb.from("quality_daily").select("day,metric,value,n").like("metric", `${prefix}%`).eq("scope", scope).gte("day", jstDay(now - 3 * 86_400_000)).order("day", { ascending: false }).limit(500);
  const seen = new Map<string, { day: string; metric: string; value: number | null; n: number | null }>();
  for (const r of (data ?? []) as Array<{ day: string; metric: string; value: number | null; n: number | null }>) if (!seen.has(r.metric)) seen.set(r.metric, { ...r, value: num(r.value) });
  return [...seen.values()];
}

/** 作業が本番に入った時刻: forecast_start_at → done_at → 段が on になった時（work_item_events） */
export async function startAtOf(sb: SupabaseClient, it: ItemRow): Promise<number | null> {
  if (it.forecast_start_at) return Date.parse(it.forecast_start_at);
  if (it.done_at) return Date.parse(it.done_at);
  const { data } = await sb.from("work_item_events").select("at").eq("item_id", it.id).eq("to_stage", "on").order("at", { ascending: true }).limit(1);
  const at = (data?.[0] as { at?: string } | undefined)?.at;
  return at ? Date.parse(at) : null;
}

export type ForecastCheckOut = { lines: string[]; fix: string[]; checked: number; inBand: number; due: number; misses: Array<{ id: number; title: string; owner: string | null; verdict: string; value: number | null; low: number | null; high: number | null; hint: MapCause | null }> };
/**
 * 見込みの突き合わせ: 本番に入って 7日・14日経った作業の実測を、同じ数え方・同じ書き手の選び方で出し、幅の外なら要確認に。
 *   builder のある根（AIX の番の一致）は、本番に入った後の番だけで数え直す（60日の窓に前の番を混ぜない）。ほかは quality_daily の入った後の最新。
 *   原因の候補は、後の木で作業の葉の下に残った外れの一番多い原因（決めるのは人: work-items.ts --forecast-cause）
 */
export async function forecastCheck(sb: SupabaseClient, items: ItemRow[], o: { now?: number; write?: boolean; night?: boolean } = {}): Promise<ForecastCheckOut> {
  const now = o.now ?? Date.now();
  const out: ForecastCheckOut = { lines: [], fix: [], checked: 0, inBand: 0, due: 0, misses: [] };
  for (const it of items) {
    const checks = it.forecast_checks ?? [];
    out.checked += checks.length ? 1 : 0;
    if (checks.length && checks[checks.length - 1].verdict === "in") out.inBand++;
    if (!it.forecast_metric || it.forecast_low == null || it.forecast_high == null) continue;
    const start = await startAtOf(sb, it);
    const due = dueChecksOf(start, now, checks.map((c) => c.day));
    if (!due.length) continue;
    out.due++;
    const def = rootOf(it.forecast_metric);
    const writer = (it.forecast_writer_select ?? def?.writerSelect ?? "style") as WriterSelect;
    if (def && writer !== def.writerSelect) { out.lines.push(`- #${it.id}: 書き手の選び方が違う（見込み ${writer}・数 ${def.writerSelect}）→ 突き合わせない`); continue; }
    let value: number | null = null, n: number | null = null, hint: MapCause | null = null;
    if (def?.builder === "conductor_aix") {
      if (!o.night) { out.lines.push(`- #${it.id}: ${due.join("・")}日の突き合わせは夜に回す（重い読み）`); continue; }
      const t = await buildRootTree(def, { sinceMs: start! });
      value = t?.value ?? null; n = t?.n ?? null;
      if (t) hint = gapCauseHintOf(t.nodes, it.forecast_leaf ?? def.metric);
    } else {
      const q = await latestQd(sb, it.forecast_metric, def?.qdScope ?? "all", jstDay(start! + 7 * 86_400_000));
      value = q?.value ?? null; n = q?.n ?? null;
    }
    const verdict = forecastVerdictOf(it.forecast_low, it.forecast_high, value, n);
    const add = due.map((d) => ({ day: d, value, n, verdict, at: new Date(now).toISOString(), cause_hint: hint }));
    out.lines.push(`- #${it.id} ${it.title.slice(0, 40)}: ${due.join("・")}日後 ${value ?? "—"}%（n ${n ?? "—"}）・見込み ${it.forecast_low}〜${it.forecast_high} → ${verdict === "in" ? "幅の中" : verdict === "below" ? "下に外れ" : verdict === "above" ? "上に外れ" : "判断保留（n が小さい・数が無い）"}${hint && verdict !== "in" ? `・原因の候補 ${MAP_CAUSE_JA[hint]}` : ""}`);
    if (verdict === "below" || verdict === "above") {
      out.misses.push({ id: it.id, title: it.title, owner: it.owner, verdict, value, low: it.forecast_low, high: it.forecast_high, hint });
      out.fix.push(`見込みの外れ: #${it.id}（${value}% が ${it.forecast_low}〜${it.forecast_high} の${verdict === "below" ? "下" : "上"}）→ 原因を4つ（材料／読み違い／判断／数え方）に分けて --forecast-cause で記録（${it.owner ?? "統括役"}）`);
    }
    if (o.write) {
      const { error } = await sb.from("work_items").update({ forecast_checks: [...checks, ...add], measured_after: value, measured_n: n, measured_at: new Date(now).toISOString(), forecast_verdict: verdict, updated_at: new Date(now).toISOString() }).eq("id", it.id);
      if (error) out.lines.push(`  書けない: ${error.message}`);
    }
  }
  return out;
}

export type QdOut = { day: string; metric: string; scope: string; value: number | null; n: number | null; detail?: Record<string, unknown> | null };
const holdJa = (r: RankedLeaf) => `${r.hold ? "［判断保留 n<5］" : ""}${r.hole ? "［穴］" : ""}`;
export const leafLine = (r: RankedLeaf) => `${r.rank}. ${r.key.split("/").slice(1).join(" › ") || r.key}｜n ${r.n}・外れ ${r.misses}・伸びしろ ${r.gain}（直る見込み ${Math.round(r.fixShare * 100)}%）・費用 ${r.cost}・点 ${r.score}${holdJa(r)}${r.examProblems ? `・試験の問題 ${r.examProblems}` : "・試験の問題 0"}${r.blocker ? `・止まり: ${r.blocker}` : ""}\n     → ${r.nextStep}`;

/**
 * 毎日の地図（self-improve の芯から）: 根ごとに木を作る（夜・1日1回）か前の木を読み、作業の見込みと合わせて葉に順位を付ける。
 *   要確認: 子を足して親に戻らない（数え方の誤り）・穴（作業の無い大きな葉）・見込みの外れ・見込みの無い P0/P1。
 *   quality_daily: map:<根>:value / :sum_mismatch / :holes / :hold / :rank<1..5>（detail に葉の鍵と次の一手）・forecast:items / :due / :checked / :in_band / :no_forecast_p01
 */
export async function mapDaily(sb: SupabaseClient, o: { now?: number; write?: boolean; night?: boolean } = {}) {
  const now = o.now ?? Date.now(), day = jstDay(now), night = o.night ?? isNightJst(now);
  const lines: string[] = [], fix: string[] = [], qd: QdOut[] = [], holes: Array<{ title: string; owner: string; next: string }> = [];
  const items = await loadForecastItems(sb);
  const { data: fq } = await sb.from("quality_daily").select("metric,value,detail").like("metric", "found:%:%:%").gte("day", jstDay(now - 3 * 86_400_000)).limit(800);
  const foundRows = ((fq ?? []) as Array<{ metric: string; value: number | null; detail?: { cause?: string } | null }>).map((r) => ({ ...r, value: num(r.value) }));
  for (const def of rootsInOrder()) {
    const its = def.dims.length ? itemsForRoot(items, def) : items.filter((it) => it.forecast_metric === def.metric || (it.forecast_leaf ?? "").split("/")[0] === def.metric);
    if (def.prefix) {
      const qs = await latestQdPrefix(sb, def.metric, def.qdScope, now);
      lines.push(`- ${def.label}［${def.metric}*・${def.qdScope}］: ${qs.length ? qs.slice(0, 12).map((q) => `${q.metric.slice(def.metric.length)} ${q.value ?? "—"}（n ${q.n ?? "—"}）`).join("・") : "数がまだ無い"}`);
      continue;
    }
    if (!def.builder) {
      const q = await latestQd(sb, def.metric, def.qdScope);
      if (q || its.length || def.writerSelect === "device") lines.push(`- ${def.label}［${def.metric}・${def.writerSelect}］: 今 ${q?.value ?? "—"}（n ${q?.n ?? "—"}・${q?.day ?? "数が無い"}）・作業 ${its.length}${its.length ? `（${its.map((i) => `#${i.id}`).join(",")}）` : ""}・子の割り方はまだ（${def.owner}）`);
      continue;
    }
    let nodes: MapNode[] = [], built = false, value: number | null = null, n: number | null = null;
    const prev = await readLatestTree(sb, def.metric, def.writerSelect);
    if (night && prev.day !== day && def.builder === "conductor_aix") {
      const t = await buildRootTree(def);
      if (t) { nodes = t.nodes; value = t.value; n = t.n; built = true; }
    }
    // json から作る根（端末の版・申込までの地図）は work-items.ts --map-build で作った木を読む（出所の台本が main に入ったら夜に作る）
    if (!built) { nodes = nodesFromRows(prev.rows); value = nodes[0]?.value ?? null; n = nodes[0]?.n ?? null; }
    if (!nodes.length) { lines.push(`- ${def.label}: 木がまだ無い（${def.builder === "conductor_aix" ? "夜に作る" : "work-items.ts --map-build で出所の json から作る"}）`); continue; }
    const examByLeaf = await examCountByLeaf(sb, def.metric);
    const ranked = rankLeaves(nodes, its, { examByLeaf, writerSelect: def.writerSelect });
    const bad = sumMismatches(nodes);
    const hs = holesOf(ranked, nodes).filter((h) => !h.hold);
    lines.push(`### 地図: ${def.label}［${def.metric}・書き手の選び方 ${def.writerSelect}・${built ? "今夜作った" : `前の木 ${prev.day}`}${def.primary ? "・主" : def.compare ? `・並べて見る相手 ${def.compare}` : ""}］`,
      `- 今 ${value ?? "—"}%（n ${n ?? "—"}）・葉 ${leavesOf(nodes).length}・外れのある葉 ${ranked.length}・穴 ${hs.length}・判断保留 ${ranked.filter((r) => r.hold).length}・子の合計の食い違い ${bad.length}`,
      ...its.filter((i) => i.forecast_low != null).map((i) => `- 見込み #${i.id}: ${i.forecast_before ?? "—"} → ${i.forecast_low}〜${i.forecast_high}${(i.forecast_exam as { phase?: string } | null)?.phase ? `［${(i.forecast_exam as { phase?: string }).phase}］` : ""}（${String(i.forecast_basis ?? "").slice(0, 60)}）`),
      `- 次の一手（伸びしろの順・上位5）:`, ...ranked.slice(0, 5).map((r) => `  ${leafLine(r)}`));
    for (const b of bad) fix.push(`地図の数え方の誤り: ${b.key} の子の合計 n ${b.childN}/${b.n}・外れ ${b.childMisses}/${b.misses} → ${def.owner}`);
    // 並べて見る用の版（主でない compare 付き）の穴は台帳に足さない（主の版と重なる）
    for (const h of def.compare && !def.primary ? [] : hs.slice(0, 3)) {
      fix.push(`地図の穴: ${h.key}（外れ ${h.misses}・作業も見込みも無い）→ 統括役が持ち主を決める`);
      holes.push({ title: `地図の穴: ${h.key}`, owner: def.owner, next: `外れ ${h.misses}/${h.n}・作業も見込みも無い葉（台帳 #610 の地図）→ 外れの番を実物で読み、原因の4つで直しを作る` });
    }
    if (built && o.write) await writeTree(sb, day, def, nodes, ranked, foundRows);
    qd.push({ day, metric: `map:${def.metric}:value`, scope: "all", value, n, detail: { writer_select: def.writerSelect, built } },
      { day, metric: `map:${def.metric}:sum_mismatch`, scope: "all", value: bad.length, n: nodes.length },
      { day, metric: `map:${def.metric}:holes`, scope: "all", value: hs.length, n: ranked.length },
      { day, metric: `map:${def.metric}:hold`, scope: "all", value: ranked.filter((r) => r.hold).length, n: ranked.length },
      ...ranked.slice(0, 5).map((r) => ({ day, metric: `map:${def.metric}:rank${r.rank}`, scope: "all", value: r.score, n: r.n, detail: { leaf: r.key, misses: r.misses, gain: r.gain, items: r.items, next: r.nextStep, hold: r.hold, hole: r.hole, writer_select: def.writerSelect } })));
    if (built) qd.push({ day, metric: def.metric, scope: def.qdScope, value, n, detail: { writer_select: def.writerSelect, source: def.source } });
  }
  const fc = await forecastCheck(sb, items, { now, write: o.write, night });
  const no = await loadUnforecastTop(sb);
  const withF = items.filter((i) => i.forecast_metric && !["dropped"].includes(i.stage));
  lines.push(`### 見込みの突き合わせ（見込みあり ${withF.length}・7/14日の頃 ${fc.due}・突き合わせ済み ${fc.checked}・幅の中 ${fc.inBand}）`, ...fc.lines,
    `- 見込みの無い P0/P1 の作業 ${no.length}: ${no.slice(0, 12).map((x) => `#${x.id}（${x.owner ?? "-"}）`).join("・")}`);
  fix.push(...fc.fix);
  qd.push({ day, metric: "forecast:items", scope: "all", value: withF.length, n: withF.length },
    { day, metric: "forecast:due", scope: "all", value: fc.due, n: withF.length },
    { day, metric: "forecast:checked", scope: "all", value: fc.checked, n: withF.length },
    { day, metric: "forecast:in_band", scope: "all", value: fc.checked ? Math.round((fc.inBand / fc.checked) * 1000) / 10 : null, n: fc.checked },
    { day, metric: "forecast:no_forecast_p01", scope: "all", value: no.length, n: no.length, detail: { ids: no.map((x) => x.id).slice(0, 50) } });
  return { lines, fix, qd, holes };
}

export { MAP_ROOTS, rootOf, rankLeaves, sumMismatches, leavesOf, holesOf, covers };
