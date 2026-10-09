// scripts/kb-eval.ts — 設計知見の RAG の正確さを測る（読むだけ・DB に書かない）
//
// 2026-10-08 竹内「ここでの設計知見で確かめる時、ちゃんと RAG で正確に確かめられるようにする」。
//   物差し: scripts/kb-eval-set.ts（竹内さんの決定 P0/P1 の行 → 担当が聞きそうな問い）。kb.ts と同じ並べ方（searchKb・P0 は別枠）で引き、
//   recall@1/@5/@10・MRR@10 を 段・場面・札・dev/holdout ごとに出す。あわせて
//   ① 退役した行が出ないか（並びに is_current=false の行が1つも無いか）
//   ② 退役した行の題で引くと、置き換えた新しい行（superseded_by）が上位に出るか
//   ③ 週の整理の要確認「上書き」の組（memory/rules_digest_review.md）で、古い行が新しい行より上に出る問いの数
//   ④ 正解より上に「正解より古い・近い（埋め込み 0.80 以上）」行が出た問いの数（食い違う古い行が先に読まれる危険）
// 実行: npx tsx --env-file=.env.local scripts/kb-eval.ts [--set=all|dev|ho] [--show-miss] [--json=<file>] [--compare=<file>]
//        [--weights=vector:1,keyword:0.5] [--scene-weight=0.5] [--no-scene]（場面を付けずに引く） [--no-stale]
//   OpenAI の埋め込みを問いの数＋退役の題の数だけ呼ぶ（1回 約0.0000004ドル・全部で $0.0001 程度）
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KB_EVAL, KB_EVAL_LEGACY, type KbEvalQ } from "./kb-eval-set";
import { embedTexts, loadRagRows } from "../app/lib/design-knowledge-rag-server";
import { cosine, hybridRank, splitPinned, KB_SCENES, KB_VEC_FETCH, reviewSupersedePairs, type RagRow, type Scored } from "../app/lib/design-knowledge-rag";
import { effectivePriority } from "../app/lib/design-knowledge-priority";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
const flag = (k: string) => process.argv.includes(`--${k}`);
const K = 10;
const OLD_RANK = flag("old-rank");
/** 監視する札（札ごとの当たり。gold の行の札にあれば数える） */
const WATCH_TAGS = ["AIX", "ブレイン", "内覧", "見積書", "物件オススメ", "物件検索", "2段", "出口の決定論", "分析強化の原則", "line-reply", "ブレイン診断", "採点", "挨拶", "保証会社"];

type Emb = { id: string; e: number[] };
async function loadEmbeddings(ids: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await sb.from("system_design_thinking").select("id, embedding").in("id", ids.slice(i, i + 150));
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ id: string; embedding: string | number[] | null }>) {
      const e = typeof r.embedding === "string" ? (JSON.parse(r.embedding) as number[]) : r.embedding;
      if (e?.length) out.set(r.id, e);
    }
  }
  return out;
}

/** 問い1つを kb.ts と同じ形で引く（hits＝上位 k・pinned＝P0 の別枠） */
export async function rankForEval(q: string, rows: RagRow[], opts: { scene?: KbEvalQ["scene"] | null; p0Emb: Map<string, number[]>; vecCache: Map<string, { vec: number[] | null; sims: Map<string, number> }>; weights?: Record<string, number>; sceneWeight?: number }): Promise<{ pinned: Scored[]; hits: Scored[]; all: Scored[]; qvec: number[] | null }> {
  let c = opts.vecCache.get(q);
  if (!c) {
    const { vectors } = await embedTexts([q]);
    const sims = new Map<string, number>();
    if (vectors[0]) {
      const { data, error } = await sb.rpc("match_design_thinking_exact", { query_embedding: vectors[0], match_count: KB_VEC_FETCH });
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Array<{ id: string; similarity: number }>) sims.set(r.id, r.similarity);
    }
    c = { vec: vectors[0], sims };
    opts.vecCache.set(q, c);
  }
  // --old-rank: 10/07 の並べ方（近さは上位 80・keyword 0.5・tag 0.3・同義なし・場面は題の型も）で前後を比べる
  const sims = OLD_RANK ? new Map([...c.sims].sort((a, b) => b[1] - a[1]).slice(0, 80)) : c.sims;
  const all = hybridRank(rows, sims, q, { nowIso: new Date().toISOString(), scene: opts.scene ?? null, weights: OLD_RANK ? { keyword: 0.5, tag: 0.3, ...(opts.weights ?? {}) } : opts.weights, sceneWeight: opts.sceneWeight, ...(OLD_RANK ? { syn: false, sceneTagOnly: false } : {}) });
  const p0Sims = new Map<string, number>();
  if (c.vec) for (const [id, e] of opts.p0Emb) p0Sims.set(id, cosine(c.vec, e));
  const sp = splitPinned(all, K, { p0Sims, scene: !!opts.scene && opts.scene !== "other" });
  return { ...sp, all, qvec: c.vec };
}

/** 題の最初の句（— ・：・（ の前・8字未満なら40字まで）＝担当が題を覚えていて短く引く形 */
export function selfQuery(title: string): string {
  const t = String(title ?? "").replace(/^【[^】]*】s*/, "").trim();
  const head = t.split(/s*[—:：（(]s*/)[0].trim();
  return (head.length >= 8 ? head : t).slice(0, 40);
}

type Agg = { n: number; r1: number; r5: number; r10: number; mrr: number };
const agg = (): Agg => ({ n: 0, r1: 0, r5: 0, r10: 0, mrr: 0 });
function add(a: Agg, rank: number) { a.n++; if (rank === 1) a.r1++; if (rank > 0 && rank <= 5) a.r5++; if (rank > 0 && rank <= 10) { a.r10++; a.mrr += 1 / rank; } }
const fmt = (a: Agg) => a.n ? `n=${String(a.n).padStart(3)}  @1 ${(a.r1 / a.n).toFixed(2)}  @5 ${(a.r5 / a.n).toFixed(2)}  @10 ${(a.r10 / a.n).toFixed(2)}  MRR ${(a.mrr / a.n).toFixed(3)}` : "n=0";
const toObj = (a: Agg) => ({ n: a.n, r1: a.n ? a.r1 / a.n : 0, r5: a.n ? a.r5 / a.n : 0, r10: a.n ? a.r10 / a.n : 0, mrr: a.n ? a.mrr / a.n : 0 });

export type EvalSummary = { at: string; questions: number; legacy?: Record<string, ReturnType<typeof toObj>>; overall: ReturnType<typeof toObj>; dev: ReturnType<typeof toObj>; ho: ReturnType<typeof toObj>; byPriority: Record<string, ReturnType<typeof toObj>>; byScene: Record<string, ReturnType<typeof toObj>>; byTag: Record<string, ReturnType<typeof toObj>>; stale: { retiredShown: number; supersede: ReturnType<typeof toObj> & { pairs: number }; reviewOldAbove: number; reviewPairsSeen: number; olderNearAbove: number }; self?: ReturnType<typeof toObj> & { misses: string[] }; misses: string[] };

export async function runKbEval(opts: { set?: "all" | "dev" | "ho"; noScene?: boolean; weights?: Record<string, number>; sceneWeight?: number; stale?: boolean; reviewPath?: string; legacy?: boolean; self?: boolean } = {}): Promise<EvalSummary> {
  const rows = await loadRagRows(sb);
  const byId = new Map(rows.map((r) => [r.id, r]));
  // 退役した gold は置き換えた新しい行（superseded_by）を追って正解にする（決定が変わったら新しい決定が正解）
  const { data: ret } = await sb.from("system_design_thinking").select("id, title, superseded_by").eq("is_current", false).limit(5000);
  const retired = (ret ?? []) as Array<{ id: string; title: string; superseded_by: string | null }>;
  const followed = new Set<string>();
  const findGold = (g: string): RagRow | undefined => {
    const hit = rows.find((r) => g.startsWith("title:") ? r.title.startsWith(g.slice(6)) : r.id.startsWith(g));
    if (hit) return hit;
    let cur = retired.find((r) => g.startsWith("title:") ? r.title.startsWith(g.slice(6)) : r.id.startsWith(g));
    for (let i = 0; cur && i < 5; i++) {
      const next = cur.superseded_by ? byId.get(cur.superseded_by) : undefined;
      if (next) { followed.add(g); return next; }
      cur = retired.find((r) => r.id === cur!.superseded_by);
    }
    return undefined;
  };
  const pick = (x: KbEvalQ) => opts.set === "dev" ? !x.ho : opts.set === "ho" ? !!x.ho : true;
  // 新しい物差し（KB_EVAL）と前の物差し（10/06・10/07 の問い・KB_EVAL_LEGACY）を同じ並べ方で測る
  const set: Array<KbEvalQ & { from?: string }> = [...KB_EVAL.filter(pick), ...(opts.legacy === false ? [] : KB_EVAL_LEGACY.filter(pick))];
  const missingGold = [...new Set(set.flatMap((x) => x.gold).filter((g) => !findGold(g)))];
  const noGoldQs = set.filter((x) => !x.gold.some(findGold)).length;
  const p0Ids = rows.filter((r) => effectivePriority(r) === 0).map((r) => r.id);
  const goldIds = [...new Set(set.flatMap((x) => x.gold).map((g) => findGold(g)?.id).filter(Boolean) as string[])];
  const emb = await loadEmbeddings([...new Set([...p0Ids, ...goldIds])]);
  const p0Emb = new Map(p0Ids.filter((id) => emb.has(id)).map((id) => [id, emb.get(id)!]));
  const vecCache = new Map<string, { vec: number[] | null; sims: Map<string, number> }>();
  const review = existsSync(opts.reviewPath ?? "") ? reviewSupersedePairs(readFileSync(opts.reviewPath!, "utf8")) : [];
  const oldOf = new Map<string, string[]>();
  for (const p of review) if (byId.has(p.oldId) && byId.has(p.newId)) oldOf.set(p.newId, [...(oldOf.get(p.newId) ?? []), p.oldId]);

  const overall = agg(), dev = agg(), ho = agg();
  const legacy: Record<string, Agg> = {};
  const byPriority: Record<string, Agg> = {}, byScene: Record<string, Agg> = {}, byTag: Record<string, Agg> = {};
  const misses: string[] = [];
  let reviewOldAbove = 0, reviewPairsSeen = 0, olderNearAbove = 0;
  // 正解より上に出た「古い・近い」行を見るため、上位の行の埋め込みは必要な分だけ読む
  const extraEmb = new Map<string, number[]>();
  for (const x of set) {
    const golds = x.gold.map(findGold).filter(Boolean) as RagRow[];
    if (!golds.length) continue;
    const scene = opts.noScene ? null : x.scene ?? null;
    const r = await rankForEval(x.q, rows, { scene, p0Emb, vecCache, weights: opts.weights, sceneWeight: opts.sceneWeight });
    const goldSet = new Set(golds.map((g) => g.id));
    let rank = 0;
    if (r.pinned.some((s) => goldSet.has(s.row.id))) rank = 1; // P0 の別枠に出た＝一番上に見える
    else { const i = r.hits.findIndex((s) => goldSet.has(s.row.id)); rank = i >= 0 ? i + 1 : 0; }
    const pr = `P${Math.min(...golds.map((g) => effectivePriority(g)))}`;
    const sc = x.scene ? KB_SCENES[x.scene].tag : "場面なし";
    if (x.from) { add((legacy["前の物差し 全体"] ??= agg()), rank); add((legacy[`前の物差し ${x.from}`] ??= agg()), rank); }
    else {
      for (const a of [overall, x.ho ? ho : dev, (byPriority[pr] ??= agg()), (byScene[sc] ??= agg())]) add(a, rank);
      const gtags = new Set(golds.flatMap((g) => g.tags ?? []));
      for (const t of WATCH_TAGS) if (gtags.has(t)) add((byTag[t] ??= agg()), rank);
    }
    if (!rank || rank > 5) misses.push(`${x.from ? `[前:${x.from}] ` : ""}${rank ? `${rank}位` : "圏外"}  ${x.q}${x.scene ? `（${sc}）` : ""} → 正解 ${golds.map((g) => g.id.slice(0, 8)).join("/")}「${golds[0].title.slice(0, 40)}」／1位「${(r.pinned[0] ?? r.hits[0])?.row.title.slice(0, 40) ?? "なし"}」`);
    // ③ 上書きの組: 正解（新）の古い行が正解より上に出たか
    const fullIdx = (id: string) => r.all.findIndex((s) => s.row.id === id);
    for (const g of golds) for (const o of oldOf.get(g.id) ?? []) { reviewPairsSeen++; const io = fullIdx(o), ig = fullIdx(g.id); if (io >= 0 && io < K && (ig < 0 || io < ig)) { reviewOldAbove++; misses.push(`[古い行が上] ${x.q} → 古い ${o.slice(0, 8)}（${io + 1}位）が新しい ${g.id.slice(0, 8)}（${ig + 1}位）より上`); } }
    // ④ 正解より上の、正解より古い・近い行（P0/P1 の決まり同士の食い違いの危険）
    const top = rank ? r.hits.slice(0, Math.max(0, rank - 1)) : r.hits.slice(0, 5);
    const need = top.map((s) => s.row.id).filter((id) => !emb.has(id) && !extraEmb.has(id));
    if (need.length) for (const [id, e] of await loadEmbeddings(need)) extraEmb.set(id, e);
    const g0 = golds[0], ge = emb.get(g0.id);
    const older = ge ? top.find((s) => { const e = emb.get(s.row.id) ?? extraEmb.get(s.row.id); return !!e && s.row.created_at < g0.created_at && effectivePriority(s.row) <= 1 && cosine(e, ge) >= 0.8; }) : undefined;
    if (older) { olderNearAbove++; misses.push(`[古い近い行が上] ${x.q} → ${older.row.id.slice(0, 8)}（${older.row.created_at.slice(0, 10)}「${older.row.title.slice(0, 30)}」）が正解 ${g0.id.slice(0, 8)}（${g0.created_at.slice(0, 10)}）より上`); }
  }

  // ①② 退役した行
  let retiredShown = 0;
  const sup = agg(); let pairs = 0;
  if (opts.stale !== false) {
    const retiredIds = new Set(retired.map((r) => r.id));
    for (const [, c] of vecCache) for (const id of c.sims.keys()) if (retiredIds.has(id) && byId.has(id)) retiredShown++; // 並べる行に退役が混ざっていないか（loadRagRows が現行だけ）
    for (const r of retired) {
      if (!r.superseded_by || !byId.has(r.superseded_by)) continue;
      pairs++;
      const rr = await rankForEval(r.title, rows, { p0Emb, vecCache, weights: opts.weights, sceneWeight: opts.sceneWeight });
      if (rr.all.some((s) => retiredIds.has(s.row.id))) retiredShown++;
      const i = rr.hits.findIndex((s) => s.row.id === r.superseded_by);
      add(sup, rr.pinned.some((s) => s.row.id === r.superseded_by) ? 1 : i >= 0 ? i + 1 : 0);
    }
  }
  // ⑤ 題の頭で引く（P0/P1 の全行・題の最初の句だけで自分が上位に出るか＝壊れた行・文字化けの題・埋め込みの抜けを見つける）
  const self = agg(); const selfMiss: string[] = [];
  if (opts.self !== false) for (const r of rows.filter((x) => effectivePriority(x) <= 1)) {
    const head = selfQuery(r.title);
    if (!head) continue;
    const rr = await rankForEval(head, rows, { p0Emb, vecCache, weights: opts.weights, sceneWeight: opts.sceneWeight });
    const i = rr.pinned.some((s) => s.row.id === r.id) ? 1 : rr.hits.findIndex((s) => s.row.id === r.id) + 1;
    add(self, i);
    if (!i || i > 5) selfMiss.push(`${i || "圏外"} ${r.id.slice(0, 8)} 「${head}」`);
  }
  if (followed.size) console.log(`  退役した正解を置き換えた新しい行で数えた: ${[...followed].join(", ")}`);
  if (noGoldQs) console.log(`⚠ 正解の行が1つも現行に無い問い ${noGoldQs}（数えていない）`);
  if (missingGold.length) console.log("⚠ 正解の行が現行に無い（退役したら kb-eval-set.ts の gold を新しい行に直す）:", missingGold.join(", "));
  const m = (o: Record<string, Agg>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toObj(v)]));
  return { at: new Date().toISOString(), questions: overall.n, legacy: m(legacy), overall: toObj(overall), dev: toObj(dev), ho: toObj(ho), byPriority: m(byPriority), byScene: m(byScene), byTag: m(byTag), stale: { retiredShown, supersede: { ...toObj(sup), pairs }, reviewOldAbove, reviewPairsSeen, olderNearAbove }, self: { ...toObj(self), misses: selfMiss }, misses };
}

function printSummary(s: EvalSummary, prev?: EvalSummary) {
  const d = (a: number, b?: number) => b == null ? "" : ` (${a - b >= 0 ? "+" : ""}${(a - b).toFixed(2)})`;
  const line = (name: string, a: ReturnType<typeof toObj>, b?: ReturnType<typeof toObj>) => console.log(`  ${name.padEnd(16)} n=${String(a.n).padStart(3)}  @1 ${a.r1.toFixed(2)}${d(a.r1, b?.r1)}  @5 ${a.r5.toFixed(2)}${d(a.r5, b?.r5)}  @10 ${a.r10.toFixed(2)}${d(a.r10, b?.r10)}  MRR ${a.mrr.toFixed(3)}${d(a.mrr, b?.mrr)}`);
  console.log(`=== 設計知見の RAG の正確さ（問い ${s.questions}・kb.ts と同じ並べ方・P0 は別枠）${prev ? `／前 ${prev.at.slice(0, 16)} と比べた差` : ""}`);
  line("全体", s.overall, prev?.overall); line("dev", s.dev, prev?.dev); line("holdout", s.ho, prev?.ho);
  for (const k of Object.keys(s.legacy ?? {}).sort()) line(k, s.legacy![k], prev?.legacy?.[k]);
  console.log("--- 段ごと（正解の行の段）");
  for (const k of Object.keys(s.byPriority).sort()) line(k, s.byPriority[k], prev?.byPriority[k]);
  console.log("--- 場面ごと（問いに付けた --scene）");
  for (const k of Object.keys(s.byScene).sort()) line(k, s.byScene[k], prev?.byScene[k]);
  console.log("--- 札ごと（正解の行の札）");
  for (const k of Object.keys(s.byTag).sort((a, b) => s.byTag[b].n - s.byTag[a].n)) line(k, s.byTag[k], prev?.byTag[k]);
  const st = s.stale;
  console.log("--- 古い行");
  console.log(`  退役した行が並びに出た: ${st.retiredShown}`);
  console.log(`  退役した行の題で引いて置き換えた新しい行が出るか（${st.supersede.pairs}組）: @5 ${st.supersede.r5.toFixed(2)}・@10 ${st.supersede.r10.toFixed(2)}・MRR ${st.supersede.mrr.toFixed(3)}`);
  console.log(`  要確認の「上書き」の組で古い行が新しい正解より上: ${st.reviewOldAbove}/${st.reviewPairsSeen}`);
  console.log(`  正解より上に「正解より古い P0/P1・埋め込み 0.80 以上」の行が出た問い: ${st.olderNearAbove}/${s.questions}`);
  if (s.self?.n) { console.log(`--- 題の頭で引く（P0/P1 の全 ${s.self.n}行・自分が上位に出るか）`); line("題の頭", s.self, prev?.self); for (const m of s.self.misses.slice(0, 15)) console.log("  - " + m); }
}

if (process.argv[1]?.includes("kb-eval")) (async () => {
  const wArg = arg("weights");
  const weights = wArg ? Object.fromEntries(wArg.split(",").map((p) => { const [k, v] = p.split(":"); return [k, Number(v)]; })) : undefined;
  const s = await runKbEval({ set: (arg("set") || "all") as "all", noScene: flag("no-scene"), weights, sceneWeight: arg("scene-weight") ? Number(arg("scene-weight")) : undefined, stale: !flag("no-stale"), self: !flag("no-self"), reviewPath: join(process.cwd(), "memory", "rules_digest_review.md") });
  const prev = arg("compare") && existsSync(arg("compare")) ? JSON.parse(readFileSync(arg("compare"), "utf8")) as EvalSummary : undefined;
  printSummary(s, prev);
  if (flag("show-miss")) { console.log(`--- 上位5に入らなかった問い ${s.misses.length}`); for (const x of s.misses) console.log("  - " + x); }
  if (arg("json")) { writeFileSync(arg("json"), JSON.stringify(s, null, 1)); console.log("書きました:", arg("json")); }
})().catch((e) => { console.error(e); process.exit(1); });
export { printSummary };
