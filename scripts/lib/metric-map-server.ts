// scripts/lib/metric-map-server.ts — 数ごとの地図（木）を作って書く・見込みを実測と突き合わせる（読む・書く・LLM なし・作業員P・2026-11-23・台帳 #610）
//   純な計算は app/lib/metric-map.ts。ここは DB の読み書きだけ。
//   重い読み（60日の AIX の番の木）は夜（JST 22〜9時）だけ・1日1回（今日の行があれば作らない）。昼は前に作った木を読むだけ（営業時間は全件読みしない）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkConductor } from "../check-conductor";
import { readFileSync as readFileSyncMM, existsSync as existsSyncMM } from "node:fs";
import { join as joinMM } from "node:path";
import { tmpdir as tmpdirMM } from "node:os";
import { runTsx as runTsxMM } from "./self-improve-growth";
import { weakStationHolesOf } from "./hole-reach-weekly";
import {
  MAP_ROOTS, rootOf, covers, buildTree, sumMismatches, rankLeaves, leavesOf, forecastVerdictOf, dueChecksOf, gapCauseHintOf, sceneOfWatchKey, relatedFoundationOf, ownerOfLeaf,
  itemsForRoot, rebaseKey, deviceTurnsOf, routeTurnsOf, holesOf, decidedTurnIdsOf, decidedRouteIdxOf, routeProgressTurnsOf, closingTurnsOf, promiseMapTurnsOf, conductorReachOf, type LinkageStatus, sideOf, deviceMoveRowOf, type SideMark, leafJa, missBreakdownOf, BROUGHT_SHAPE_RE, fixedSinceOf, ackPlusCheckPromiseOf, type DeviceTurnRow, type RouteTurnRow,
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
  const { data } = await sb.from("work_items").select("id,title,owner,stage,priority,forecast_basis").in("priority", [0, 1]).is("forecast_metric", null).not("stage", "in", "(done,dropped)").limit(300);
  return (data ?? []) as Array<{ id: number; title: string; owner: string | null; stage: string; priority: number; forecast_basis: string | null }>;
}

/** 主の根を先に（同じ数の版が2つある時・11/23 統括役「主は端末の版」） */
export const rootsInOrder = (roots: readonly MapRootDef[] = MAP_ROOTS) => [...roots].sort((a, b) => Number(!!b.primary) - Number(!!a.primary));

/** 出所の台本の json から木を作る（端末の版＝作業員A の audit-aix-turn-judgment・申込までの地図＝作業員R の audit-route-progress-takeuchi）。
 *  台本は夜だけの重い読み＝ここは json を読むだけ。端末の版の場面は見張りの scene_key を番の id で引く（100番ほどの軽い読み） */
export async function buildTreeFromJson(sb: SupabaseClient, def: MapRootDef, rows: unknown[], o: { spec?: Array<{ id: string; conv?: string; at?: string; why?: string; tags?: unknown }> } = {}): Promise<{ nodes: MapNode[]; value: number | null; n: number; decided: Map<number, string>; minority: Map<number, { shape: string; majority: string; share: number; n: number }>; fixed: Map<number, string>; sides: Map<number, SideMark> } | null> {
  let decided = new Map<number, string>();
  let minority = new Map<number, { shape: string; majority: string; share: number; n: number }>();
  let fixed = new Map<number, string>();
  let sides = new Map<number, SideMark>();
  let turns: MapTurn[] = [];
  if (def.builder === "aix_turn_device") {
    const rs = rows as DeviceTurnRow[];
    // 少数側の形は返信の番も含めた竹内さん本人の全部の番で数える＝場面は全部の番の分を読む（200番ほど・id で引く軽い読み）
    const ids = [...new Set(rs.map((r) => r.id))];
    const scene = new Map<number, string | null>();
    const turnAt = new Map<number, { conv: string; at: number; last: number }>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await sb.from("line_watch_turns").select("id,scene_key,conversation_id,customer_turn_at,customer_last_at").in("id", ids.slice(i, i + 200));
      if (error) throw new Error(`line_watch_turns: ${error.message}`);
      for (const r of (data ?? []) as Array<{ id: number; scene_key: string | null; conversation_id: string; customer_turn_at: string; customer_last_at: string | null }>) { scene.set(r.id, r.scene_key); turnAt.set(r.id, { conv: r.conversation_id, at: Date.parse(r.customer_turn_at), last: Date.parse(r.customer_last_at ?? r.customer_turn_at) }); }
    }
    // 前24時間にお客様が物件を送ってきた番（少数側の名前の付いた形・作業員A と同じ網）: 会話ごとにお客様の発言だけを窓で読む（本文は印を見るだけ・出さない）
    const brought = new Set<number>();
    const burstText = new Map<number, string>(); // 番の最後のお客様の発言までの連投（作業員A の shapes.ts と同じ切り方・本文は形の印を見るだけ・出さない）
    const byConvT = new Map<string, Array<{ id: number; at: number; last: number }>>();
    for (const [id, x] of turnAt) byConvT.set(x.conv, [...(byConvT.get(x.conv) ?? []), { id, at: x.at, last: x.last }]);
    for (const [c, ts] of byConvT) {
      const lo = new Date(Math.min(...ts.map((t) => t.at)) - 86_400_000).toISOString(), hi = new Date(Math.max(...ts.map((t) => t.last)) + 1000).toISOString();
      const { data } = await sb.from("messages").select("sender,text,created_at,image_url").eq("conversation_id", c).gte("created_at", lo).lte("created_at", hi).order("created_at").limit(3000);
      const all = (data ?? []) as Array<{ sender: string; text: string | null; created_at: string; image_url: string | null }>;
      const marks = all.filter((m) => m.sender === "customer" && (BROUGHT_SHAPE_RE.test(String(m.text ?? "")) || !!m.image_url)).map((m) => Date.parse(m.created_at));
      for (const t of ts) {
        if (marks.some((at) => at <= t.at + 1000 && t.at - at <= 86_400_000)) brought.add(t.id);
        const upto = all.filter((m) => Date.parse(m.created_at) <= t.last + 1000);
        const burst: string[] = [];
        for (let k = upto.length - 1; k >= 0 && upto[k].sender === "customer"; k--) burst.unshift(String(upto[k].text ?? ""));
        burstText.set(t.id, burst.join("\n"));
      }
    }
    // 竹内さんの決定で正解を改めた番（作業員A の案）は外れと別に数える
    decided = o.spec ? decidedTurnIdsOf(rs as unknown as Array<{ id: number; conv: string; at: string }>, o.spec) : new Map();
    sides = sideOf(rs.map((r) => deviceMoveRowOf(r, scene.get(r.id) ?? null, { brought24h: brought.has(r.id), ackPlusCheck: ackPlusCheckPromiseOf(burstText.get(r.id) ?? "", (r as { prevPromise?: string[] }).prevPromise ?? []) })).filter((m) => !decided.has(m.id)));
    minority = new Map([...sides].filter(([, v]) => v.side === "minority").map(([k, v]) => [k, { shape: v.shape, majority: v.majority, share: v.share, n: v.n }]));
    fixed = fixedSinceOf(rs as unknown as Array<{ id: number; at: string }>);
    turns = deviceTurnsOf(rs, scene, new Set(decided.keys()), new Set(minority.keys()), new Set(fixed.keys()), new Set([...sides].filter(([, v]) => v.side === "split").map(([k]) => k)));
  } else if (def.builder === "promise_map") {
    turns = promiseMapTurnsOf(rows);
  } else if (def.builder === "closing" || def.builder === "closing_early") {
    turns = closingTurnsOf(rows as Array<{ id: number; takeuchiClose: boolean; brainClose: boolean; closeHow: string | null; brainAct: string | null; level: string | null; gaps: string[] }>, def.builder);
  } else if (def.builder === "route_progress") {
    turns = routeProgressTurnsOf(rows as Array<RouteTurnRow & { outcome?: string | null; after?: string | null }>);
  } else if (def.builder === "route_next") {
    const rr = rows as RouteTurnRow[];
    const dm = o.spec ? decidedRouteIdxOf(rr, o.spec) : new Map<number, string>();
    decided = dm;
    turns = routeTurnsOf(rr, new Set(dm.keys()));
  }
  else return null;
  const nodes = buildTree(turns, def);
  return { nodes, value: nodes[0]?.value ?? null, n: nodes[0]?.n ?? 0, decided, minority, fixed, sides };
}

const ccCache = new Map<string, ReturnType<typeof checkConductor>>();
/** json から作る根の出所の台本（どちらも読むだけ・LLM なし・main にある）。夜だけ・1日1回 */
export const JSON_SOURCES: Record<string, string> = { aix_turn_device: "scripts/audit-aix-turn-judgment.ts", route_next: "scripts/audit-route-progress-takeuchi.ts", route_progress: "scripts/audit-route-progress-takeuchi.ts",
  closing: "scripts/audit-closing-takeuchi.ts", closing_early: "scripts/audit-closing-takeuchi.ts", promise_map: "scripts/audit-promise-map.ts" };
/** 出力の欄の名前が --json でない台本（作業員L の約束の地図は --out） */
const JSON_OUT_FLAG: Record<string, string> = { promise_map: "out" };
const jsonCache = new Map<string, unknown[] | null>(); // 同じ台本・同じ窓は1晩に1回だけ回す（一致の木と進みの木は同じ json）
/** 出所の台本を回して json を読む（台本は営業時間には自分で窓を絞る＝昼の空流しは軽い）。止める: MAP_JSON_ROOTS=off */
export function runJsonSource(def: MapRootDef, days: number): unknown[] | null {
  const script = def.builder ? JSON_SOURCES[def.builder] : null;
  if (!script || !existsSyncMM(script)) return null;
  const ck = `${script}:${days}`;
  if (jsonCache.has(ck)) return jsonCache.get(ck) ?? null;
  const out = joinMM(tmpdirMM(), `map-${def.builder}-${process.pid}-${Date.now()}.json`);
  runTsxMM([script, `--days=${days}`, `--${JSON_OUT_FLAG[def.builder ?? ""] ?? "json"}=${out}`], 20 * 60_000);
  const raw = existsSyncMM(out) ? (JSON.parse(readFileSyncMM(out, "utf8")) as unknown) : null;
  // 約束の地図の json は { root, turns, nodes, table }＝turns を行に
  const rows = raw == null ? null : Array.isArray(raw) ? raw : (((raw as { turns?: unknown[] }).turns) ?? null);
  jsonCache.set(ck, rows);
  return rows;
}

/** 根1つの木を作る（台帳の読みで作れる根だけ＝conductor_aix）。値は出所のスクリプトと同じ数え方 */
export async function buildRootTree(def: MapRootDef, o: { sinceMs?: number; days?: number } = {}): Promise<{ nodes: MapNode[]; value: number | null; n: number } | null> {
  if (def.builder !== "conductor_aix") return null;
  if (o.days) def = { ...def, windowDays: o.days };
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
      // json から作る根（端末の版・申込までの地図）は数が quality_daily の map:<根>:value にある
      const q = (await latestQd(sb, it.forecast_metric, def?.qdScope ?? "all", jstDay(start! + 7 * 86_400_000))) ?? (await latestQd(sb, `map:${it.forecast_metric}:value`, "all", jstDay(start! + 7 * 86_400_000)));
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
export async function mapDaily(sb: SupabaseClient, o: { now?: number; write?: boolean; night?: boolean; force?: boolean; days?: number; roots?: string[]; env?: Record<string, string | undefined> } = {}) {
  const now = o.now ?? Date.now(), day = jstDay(now), night = o.night ?? isNightJst(now);
  const lines: string[] = [], fix: string[] = [], qd: QdOut[] = [], holes: Array<{ title: string; owner: string; next: string; reach: "未確認" | "届いている" | "届いていない"; misses: number }> = [];
  // 2026-11-23 作業員N2（KB 0f38f47f）: 統括の学びの葉の印（現行の conductor_lessons.leaf_keys・軽い読み）＝穴が統括に届いているかの元
  //   2026-11-23 作業員P の holeReachOf（学びの葉の印・葉の材料の行が連携の地図の見張りでつながっているか＝2つの道）。読みは cache に1回だけ
  const reachCache: { lessons?: string[]; linkage?: LinkageStatus | null } = {};
  const items = await loadForecastItems(sb);
  const { data: fq } = await sb.from("quality_daily").select("metric,value,detail").like("metric", "found:%:%:%").gte("day", jstDay(now - 3 * 86_400_000)).limit(800);
  const foundRows = ((fq ?? []) as Array<{ metric: string; value: number | null; detail?: { cause?: string } | null }>).map((r) => ({ ...r, value: num(r.value) }));
  for (const def of rootsInOrder().filter((r) => !o.roots || o.roots.includes(r.metric))) {
    const its = def.dims.length ? itemsForRoot(items, def) : items.filter((it) => it.forecast_metric === def.metric || (it.forecast_leaf ?? "").split("/")[0] === def.metric);
    if (def.prefix) {
      const qs = await latestQdPrefix(sb, def.metric, def.qdScope, now);
      // 束の根は数があるものだけ1行（竹内さんの1枚は短く）
      if (qs.length) lines.push(`- ${def.label}: ${qs.slice(0, 6).map((q) => `${q.metric.slice(def.metric.length)} ${q.value ?? "—"}`).join("・")}${qs.length > 6 ? ` ほか${qs.length - 6}` : ""}`);
      continue;
    }
    if (!def.builder) {
      const q = await latestQd(sb, def.metric, def.qdScope);
      if (q) lines.push(`- ${def.label}: 今 ${q.value ?? "—"}（${q.n ?? "—"}番・${q.day}）${its.some((i) => i.forecast_low != null) ? `・見込み ${its.filter((i) => i.forecast_low != null).map((i) => `${i.forecast_low}〜${i.forecast_high}`).join("／")}` : ""}`);
      continue;
    }
    let nodes: MapNode[] = [], built = false, value: number | null = null, n: number | null = null;
    const prev = await readLatestTree(sb, def.metric, def.writerSelect);
    // 夜（JST 22〜9時）に1日1回だけ作る（今日の木があれば作らない・force は空流しの確かめ用）。昼は前の木を読むだけ（60日の重い読みをしない）
    if (night && (prev.day !== day || o.force)) {
      if (def.builder === "conductor_aix") {
        const t = await buildRootTree(def, { days: o.days });
        if (t) { nodes = t.nodes; value = t.value; n = t.n; built = true; }
      } else if (def.builder && JSON_SOURCES[def.builder] && (process.env.MAP_JSON_ROOTS ?? "on").toLowerCase() !== "off") {
        // 11/23 統括役: json から作る根（端末の版＝作業員A・申込までの地図＝作業員R）も出所の台本を夜に回して毎晩作る
        try {
          const rows = runJsonSource(def, o.days ?? def.windowDays);
          const spec = existsSyncMM("scripts/brain-exam/spec.json") ? (JSON.parse(readFileSyncMM("scripts/brain-exam/spec.json", "utf8")) as Array<{ id: string; conv?: string; at?: string; why?: string; tags?: unknown }>) : undefined;
          const t = rows?.length ? await buildTreeFromJson(sb, def, rows, { spec }) : null;
          if (t) { nodes = t.nodes; value = t.value; n = t.n; built = true; }
          else lines.push(`- ${def.label}: 出所の台本の行が無い（${JSON_SOURCES[def.builder]}）`);
        } catch (e) { lines.push(`- ${def.label}: 出所の台本が止まった（${e instanceof Error ? e.message.slice(0, 80) : e}）`); }
      }
    }
    // json から作る根（端末の版・申込までの地図）は work-items.ts --map-build で作った木を読む（出所の台本が main に入ったら夜に作る）
    if (!built) { nodes = nodesFromRows(prev.rows); value = nodes[0]?.value ?? null; n = nodes[0]?.n ?? null; }
    if (!nodes.length) { lines.push(`- ${def.label}: 木がまだ無い（${def.builder === "conductor_aix" ? "夜に作る" : "work-items.ts --map-build で出所の json から作る"}）`); continue; }
    const examByLeaf = await examCountByLeaf(sb, def.metric);
    const ranked = rankLeaves(nodes, its, { examByLeaf, writerSelect: def.writerSelect });
    const bad = sumMismatches(nodes);
    const hs = holesOf(ranked, nodes).filter((h) => !h.hold);
    // 11/23 統括役: 竹内さんが読む形（短い日本語・数と理由）。主でない版（並べて見る用）は1行だけ
    const top = nodes[0];
    if (def.compare && !def.primary) {
      lines.push(`- 並べて見る（${def.label.replace(/（.*$/, "")}${def.writerSelect === "style" ? "・文の癖で選んだ番" : def.writerSelect === "device" ? "・端末の記録で選んだ番" : ""}）: ${value ?? "—"}%（${top.n}番中 ${top.ok}番）`);
    } else {
      const mb = missBreakdownOf(nodes);
      const aside = [mb.decided ? `竹内さんの決定で正解が変わった ${mb.decided}` : "", mb.minority ? `竹内さんが少数側 ${mb.minority}` : "", mb.split ? `竹内さんご自身が割れている ${mb.split}` : "", mb.timed ? `時刻で送る物 ${mb.timed}` : "", mb.fixed_since ? `今は直っている前の番 ${mb.fixed_since}` : ""].filter(Boolean);
      // 見込みは作業ごとに1行（部品に割った作業も元の作業として1回だけ）
      const uniq = [...new Map(its.filter((i) => i.forecast_low != null).map((i) => [i.id, i])).values()].sort((a, b) => (b.forecast_high ?? 0) - (a.forecast_high ?? 0));
      const STAGE_JA: Record<string, string> = { todo: "まだ", building: "作っている", built_off: "作った（off）", testing: "試験中", passed: "試験を通った", on: "本番 on", waiting_owner: "竹内さん待ち", blocked: "止まっている" };
      const rng = (i: ForecastItem) => (i.forecast_low === i.forecast_high ? `${i.forecast_low}%` : `${i.forecast_low}〜${i.forecast_high}%`);
      lines.push(`### ${def.label.replace(/（.*$/, "")}${def.primary ? "（主の数）" : ""}`,
        def.okLabel
          ? (top.n ? `- 今 ${value ?? "—"}%（${top.n}番中 ${top.ok}番が${def.okLabel}）。${def.missLabel ?? "進まなかった"} ${top.misses}番` : `- まだ数が無い（番が0・出所 ${def.source.split("（")[0]} を夜に回す）`)
          : `- 今 ${value ?? "—"}%（${top.n}番中 ${top.ok}番が竹内さんと同じ一手）。外れ ${top.misses}番のうち 直す所 ${mb.real}${aside.length ? `・分けて外した ${aside.join("・")}` : ""}`,
        ...uniq.slice(0, 4).map((i) => `- 見込み${(i.forecast_exam as { phase?: string } | null)?.phase ? `（${(i.forecast_exam as { phase?: string }).phase}）` : ""} #${i.id}（${STAGE_JA[i.stage] ?? i.stage}）: ${i.forecast_before ?? "—"}% → ${rng(i)}${i.blocker ? `・止まり: ${String(i.blocker).slice(0, 30)}` : ""}`),
        ...ranked.slice(0, 3).map((r, k) => { const it = r.items.length ? its.find((x) => x.id === r.items[0]) ?? null : null; // 葉に近い作業が先頭（rankLeaves の並び）
          return `- 次の一手 ${k + 1}: ${leafJa(r.key)}（外れ ${r.misses}${r.hold ? "・数が少ない" : ""}）→ ${r.hole || !it ? "作業がまだ無い所（持ち主を決める）" : `#${it.id}（${STAGE_JA[it.stage] ?? it.stage}${it.blocker ? `・止まり: ${String(it.blocker).slice(0, 20)}` : ""}）`}`; }),
        ...(hs.length ? [`- 作業がまだ無い所: ${hs.slice(0, 4).map((h) => `${leafJa(h.key)}（${h.misses}）`).join("・")}`] : []),
        ...(bad.length ? [`- ⚠ 数え方の点検: 子を足して親に戻らない所 ${bad.length}（数え方の誤り）`] : []));
    }
    for (const b of bad) fix.push(`地図の数え方の誤り: ${b.key} の子の合計 n ${b.childN}/${b.n}・外れ ${b.childMisses}/${b.misses} → ${def.owner}`);
    // 並べて見る用の版（主でない compare 付き）の穴は台帳に足さない（主の版と重なる）
    // 2026-11-23 作業員N2（竹内さんの決定 KB 0f38f47f・統括役の頼み・作業員P と揃えた）: 上位3つの線を外し、本当の外れが3以上の穴を全部台帳へ（題で重ねない・--write の時だけ）。
    //   持ち主は葉の持ち主の案（ownerOfLeaf）・統括に届いているか（leafReachOf・conductor_lessons の現行の leaf_keys）を必ず付ける。止める: MAP_HOLES_ALL=off（前の上位3つ・根の持ち主）
    const holesAll = (o.env ?? process.env).MAP_HOLES_ALL?.trim().toLowerCase() !== "off";
    // 2026-11-23 統括役の決め（案b）: 申込までの地図の進みの根は、作業員A の弱い駅の線（n10以上・前の週より5pt下がった／止まり＋離れが過半数）も穴の理由にする。
    //   弱い駅は駅の鍵で1つの穴（その駅の下の葉の穴は出さない）。前の週の進みは A の数 route:station:<駅>:progress（scope takeuchi・7日前）
    let weak: Array<{ key: string; n: number; misses: number; reasons: string[] }> = [];
    if (holesAll && def.builder === "route_progress" && !(def.compare && !def.primary)) {
      const { data: pq } = await sb.from("quality_daily").select("metric,value,n").like("metric", "route:station:%:progress").eq("scope", "takeuchi").eq("day", jstDay(now - 7 * 86_400_000)).limit(300);
      const prev = new Map(((pq ?? []) as Array<{ metric: string; value: number | null; n: number | null }>).map((r) => [r.metric.replace(/^route:station:/, "").replace(/:progress$/, ""), { n: r.n ?? 0, value: num(r.value) }]));
      weak = weakStationHolesOf(nodes, prev);
    }
    const holeList: Array<{ key: string; n: number; misses: number; reasons?: string[] }> = [
      ...weak,
      ...(def.compare && !def.primary ? [] : holesAll ? hs.filter((x) => x.misses >= 3) : hs.slice(0, 3)).filter((h) => !weak.some((w) => h.key === w.key || h.key.startsWith(`${w.key}/`))),
    ];
    for (const h of holeList) {
      const own = holesAll ? ownerOfLeaf(h.key, def.owner) : { owner: def.owner, why: "根の持ち主" };
      const rr = await holeReachOf(sb, h.key, reachCache).catch(() => ({ reach: "未確認" as const, via: null, cutRows: [] as string[] }));
      const reach = rr.reach;
      fix.push(`地図の穴: ${h.key}（外れ ${h.misses}・作業も見込みも無い・統括に届いているか ${reach}${rr.cutRows?.length ? `・切れている材料 ${rr.cutRows.slice(0, 3).join("・")}` : ""}）→ 持ち主の案 ${own.owner}（${own.why}）`);
      holes.push({ title: `地図の穴: ${h.key}`, owner: own.owner, reach, misses: h.misses, next: `外れ ${h.misses}/${h.n}・${h.reasons?.length ? `弱い駅（${h.reasons.join("・")}）` : "作業も見込みも無い葉"}（台帳 #610 の地図）・持ち主の案 ${own.owner}（${own.why}）・統括に届いているか ${reach} → 外れの番を実物で読み、原因の4つで直しを作る` });
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
  const noWhy = no.filter((x) => !String(x.forecast_basis ?? "").startsWith("見込みを付けない理由"));
  lines.push(`### 見込みと実測の突き合わせ`,
    `- 見込みのある作業 ${withF.length}・本番に入って7日/14日の頃 ${fc.due}・突き合わせ済み ${fc.checked}（うち見込みの幅の中 ${fc.inBand}）`, ...fc.lines,
    `- 見込みの無い大事な作業（P0/P1）${no.length}: 理由が書いてある ${no.length - noWhy.length}・理由も無い ${noWhy.length}${noWhy.length ? `（${noWhy.slice(0, 8).map((x) => `#${x.id}`).join("・")}）` : ""}`);
  fix.push(...fc.fix);
  qd.push({ day, metric: "forecast:items", scope: "all", value: withF.length, n: withF.length },
    { day, metric: "forecast:due", scope: "all", value: fc.due, n: withF.length },
    { day, metric: "forecast:checked", scope: "all", value: fc.checked, n: withF.length },
    { day, metric: "forecast:in_band", scope: "all", value: fc.checked ? Math.round((fc.inBand / fc.checked) * 1000) / 10 : null, n: fc.checked },
    { day, metric: "forecast:no_forecast_p01", scope: "all", value: no.length, n: no.length, detail: { ids: no.map((x) => x.id).slice(0, 50) } });
  return { lines, fix, qd, holes };
}

export { MAP_ROOTS, rootOf, rankLeaves, sumMismatches, leavesOf, holesOf, covers };

/** 連携の地図の見張りの最新（cron_run_logs・cron_name=linkage-watch・ok の最新1行）。無ければ null */
export async function loadLinkageStatus(sb: SupabaseClient): Promise<LinkageStatus | null> {
  const { data } = await sb.from("cron_run_logs").select("started_at,result_json").eq("cron_name", "linkage-watch").eq("ok", true).order("started_at", { ascending: false }).limit(1);
  const r = (data?.[0] ?? null) as { started_at: string; result_json: { cut?: Array<{ id: string }>; off?: Array<{ id: string }>; unmeasured?: Array<{ id: string }> } | null } | null;
  if (!r?.result_json) return null;
  return { cut: new Set((r.result_json.cut ?? []).map((x) => x.id)), off: new Set((r.result_json.off ?? []).map((x) => x.id)), at: r.started_at,
    unmeasured: r.result_json.unmeasured ? new Set(r.result_json.unmeasured.map((x) => x.id)) : undefined };
}
/** 統括の学びの葉の印（conductor_lessons.is_current の leaf_keys を全部） */
export async function loadLessonLeafKeys(sb: SupabaseClient): Promise<string[]> {
  const { data } = await sb.from("conductor_lessons").select("leaf_keys").eq("is_current", true).limit(1000);
  return [...new Set(((data ?? []) as Array<{ leaf_keys: string[] | null }>).flatMap((r) => r.leaf_keys ?? []))];
}
/** 穴の葉が統括に届いているか（学び・材料の2つの道）。作業員N2 の台帳の conductor_reach に使う */
export async function holeReachOf(sb: SupabaseClient, holeKey: string, cache: { lessons?: string[]; linkage?: LinkageStatus | null } = {}) {
  cache.lessons ??= await loadLessonLeafKeys(sb);
  if (cache.linkage === undefined) cache.linkage = await loadLinkageStatus(sb);
  const def = rootOf(holeKey.split("/")[0]);
  return conductorReachOf(holeKey, cache.lessons, def?.rebaseFrom ?? [], cache.linkage);
}
