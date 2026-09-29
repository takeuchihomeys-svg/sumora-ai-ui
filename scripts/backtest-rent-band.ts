// scripts/backtest-rent-band.ts
// 家賃の位置の採点（property-brain RENT_BAND_RULE）の当て直し（読むだけ・DB に書かない・LLM を呼ばない）。
//
// 2026-09-29 竹内「家賃帯が低ければ低い方が良いわけではない…条件内で見る形」（R さん: 7万〜8万で上位オススメ7件が 7万円未満）。
// ■ 物差しは scoring-learning の当て直しと同じ（正解＝スタッフが選んで送った事実・rankMetrics の 1位率／3位以内率／相対順位・
//   splitHoldout で古い7割で点を選び、新しい3割で確かめる）
// ■ 材料
//   snapshot・pool … loadEpisodes（judgeProperty をその時点の条件でやり直す）を 旧（setRentBandEnabled(false)）と新で2回読む
//   pickup        … 保存済みの札（旧）に、資料の家賃（factsFromPickup）とその時点の条件で家賃の札だけ付け直す（新・rejudgeRentCodes）
// ■ 安さを望むお客様: 条件欄（RENT_CHEAP_RE＝written.rentCheap・目安の額 rentTarget）と、その回より前の発言（audit-rent-band と同じ語）
// ■ 出す物: 全体・材料ごと・お客様の種類ごとの前後／点の表の候補（学び用で選ぶ→確かめ用で見る）／R さんの回の前後の並び／目安の額を読めたお客様
//
// 実行: npx tsx --env-file=.env.local scripts/backtest-rent-band.ts [--days=180] [--out=path.json]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import {
  RENT_BAND_RULE, RENT_BAND_POINTS, setRentBandEnabled, rentPositionCodes, buildCustomerProfile, baseReasonPoints, settleHeldAd, settleFitBonus,
  scoreFromCodes, HOLD_REASON_CODES, DROP_REASON_CODES, FIT_CODES, readRentTarget, type CustomerLike, type CustomerProfile,
} from "../app/lib/property-brain";
import { loadEpisodes, listWeightVersions } from "../app/lib/scoring-learning-server";
import { rankMetrics, splitHoldout, activeWeights, type Episode, type RankMetrics, type WeightMap } from "../app/lib/scoring-learning";
import { customerAt, episodeFromPickups, type ConditionHistoryRow } from "../app/lib/scoring-learning-episodes";
import { factsFromPickup } from "../app/lib/recommendation-snapshot-server";
import { YUMA_CONVERSATION_ID, isTestConversation } from "../app/lib/test-conversations";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "180"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = Record<string, any>;
const D = 24 * 3600_000;
const num = (v: unknown) => { const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
async function all(build: (a: number, b: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>, page = 1000): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < 200; p++) {
    const { data, error } = await build(p * page, p * page + page - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out = out.concat(data);
    if (data.length < page) break;
  }
  return out;
}
const chunks = <T,>(xs: T[], n: number) => { const o: T[][] = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o; };

function changedEpisodeIds(b: Episode[], a: Episode[]): string[] {
  const m = new Map(a.map((e) => [e.id, e]));
  return b.filter((e) => { const x = m.get(e.id); return x && x.cands.some((c, i) => c.codes.join() !== e.cands[i]?.codes.join()); }).map((e) => e.id);
}
const RENT_NEW =/^RENT_(?:BAND_|TARGET_|NEAR_MIN$|UNDER_MIN$)/;
const isHold = (c: string) => HOLD_REASON_CODES.has(c) || /^(?:IMAGE|EQUIP|CONDITION)_.*_NG$/.test(c);

/**
 * 保存済みの札（旧の判定）に家賃の札だけ付け直す（新）。上限内（RENT_OK）か旧の下限の札（RENT_BELOW_MIN）がある行だけ。
 *   保留が増えたら AD の段は _HELD（settleHeldAd）・全部合うは付け直す（settleFitBonus）＝ judgeProperty と同じ決まり
 */
export function rejudgeRentCodes(codes: string[], total: number | null, p: CustomerProfile, rentOnly: number | null = null): string[] {
  if (total == null || !(codes.includes("RENT_OK") || codes.includes("RENT_BELOW_MIN"))) return codes;
  if (p.rentMax != null && total > p.rentMax) return codes;   // 資料の家賃と保存の判定が食い違う行は触らない
  let base = codes.filter((c) => c !== "RENT_OK" && c !== "RENT_BELOW_MIN" && !RENT_NEW.test(c) && !(FIT_CODES as readonly string[]).includes(c)
    && !(p.rentTarget != null && /^RENT_CHEAP_/.test(c)));
  base.push(...rentPositionCodes(total, p, rentOnly).map((r) => r.code));
  base = settleHeldAd(base, base.some((c) => DROP_REASON_CODES.has(c) || isHold(c)));
  return settleFitBonus(base);
}

// ─── 安さの言い方（audit-rent-band と同じ） ─────────────────────────────────
const MSG_RENT_CHEAP = /(?:家賃|賃料|月々|毎月)[^、。,\n]{0,12}(?:低い|低め|安い|安め|安く|抑え|おさえ|下げ)|安い(?:方|ほう)が|なるべく安|できるだけ安|出来るだけ安|出来る限り安|安(?:い|め)(?:の|な)?(?:物件|お部屋|部屋|所|ところ)/;
const MSG_SOFT_TARGET = /(?:できれば|出来れば|理想は|なるべく|本当は)[^。\n]{0,10}\d+(?:\.\d+)?\s*万|\d+(?:\.\d+)?\s*万(?:円)?(?:台|くらい|ぐらい|程度|前後)?(?:が理想|だと(?:嬉|うれ|助か|有難|ありがた)|に(?:抑え|おさえ)たい)/;
const MSG_NEG = /こだわらない|気にしない|高くても|多少高く|上がっても/;

async function main() {
  const until = new Date().toISOString();
  const versions = await listWeightVersions(sb as never);
  const act = activeWeights(versions);
  const W: WeightMap | null = act?.weights ?? null;
  console.log(`■ 期間 ${DAYS}日（〜${until}）・重みの版 ${act?.version ?? 0}`);

  // ── 旧と新で snapshot・pool を読む（新は目安の無い安さの人にも帯を付けて読み、neutral は後で帯を外して作る） ──
  setRentBandEnabled(false);
  const before = await loadEpisodes(sb as never, { until, days: DAYS, sources: ["snapshot", "pool"] });
  setRentBandEnabled(true);
  (RENT_BAND_RULE as { cheapWithoutTarget: string }).cheapWithoutTarget = "band";
  const after = await loadEpisodes(sb as never, { until, days: DAYS, sources: ["snapshot", "pool"] });
  console.log("■ 件数（旧）", before.counts, "\n■ 件数（新）", after.counts);

  // ── お客様（回 → お客様） ──
  const snapIds = after.episodes.filter((e) => e.source === "snapshot").map((e) => Number(e.id.split(":")[1]));
  const poolIds = after.episodes.filter((e) => e.source === "pool").map((e) => e.id.split(":")[1]);
  const custOfEp = new Map<string, string>();
  for (const c of chunks(snapIds, 200)) { const { data } = await sb.from("recommendation_snapshots").select("id, property_customer_id").in("id", c); for (const r of data ?? []) custOfEp.set(`snap:${r.id}`, String(r.property_customer_id)); }
  for (const c of chunks(poolIds, 200)) { const { data } = await sb.from("property_candidate_pools").select("id, property_customer_id").in("id", c); for (const r of data ?? []) custOfEp.set(`pool:${r.id}`, String(r.property_customer_id)); }

  // ── 売上サポの回（保存の札＝旧・家賃の札の付け直し＝新） ──
  const sinceIso = new Date(Date.now() - DAYS * D).toISOString();
  const pk = (await all((a, b) => sb.from("property_pickups").select("id, batch_id, property_customer_id, conversation_id, rank, property_name, room_no, status, sent_at, created_at, reason_codes, score, summary_text, pdf_text")
    .gte("created_at", sinceIso).order("id").range(a, b) as never, 200)).filter((r) => r.property_customer_id && r.conversation_id !== YUMA_CONVERSATION_ID && !isTestConversation(r.conversation_id));
  const custIds = [...new Set([...pk.map((r) => String(r.property_customer_id)), ...custOfEp.values()])];
  const custs = new Map<string, Row>();
  const hist: Row[] = [];
  for (const c of chunks(custIds, 80)) {
    const { data } = await sb.from("property_customers").select("id, rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet, move_in_time, created_at, floor_area_min, raw_format_text, desired_area").in("id", c);
    for (const r of data ?? []) custs.set(r.id, r);
    hist.push(...await all((a, b) => sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, created_at").in("property_customer_id", c).range(a, b) as never));
  }
  const histOf = new Map<string, ConditionHistoryRow[]>();
  for (const h of hist) (histOf.get(h.property_customer_id) ?? histOf.set(h.property_customer_id, []).get(h.property_customer_id)!).push(h as ConditionHistoryRow);
  const profAt = (pc: string, at: string) => { const base = custs.get(pc); if (!base) return null; const { c } = customerAt(base, histOf.get(pc) ?? [], at); return buildCustomerProfile(c as CustomerLike, [], [], null, { today: at }); };

  // 発言（安さ）
  const convs = await all((a, b) => sb.from("conversations").select("id, property_customer_id").not("property_customer_id", "is", null).range(a, b) as never);
  const custOfConv = new Map(convs.map((c) => [String(c.id), String(c.property_customer_id)]));
  const msgs = await all((a, b) => sb.from("messages").select("conversation_id, text, created_at").eq("sender", "customer").not("text", "is", null).gte("created_at", new Date(Date.now() - (DAYS + 60) * D).toISOString()).order("id").range(a, b) as never);
  const cheapMsgAt = new Map<string, number[]>();
  for (const m of msgs) {
    const pc = custOfConv.get(String(m.conversation_id)); if (!pc) continue;
    const t = String(m.text).normalize("NFKC");
    if (MSG_NEG.test(t) && !MSG_SOFT_TARGET.test(t)) continue;
    if (MSG_RENT_CHEAP.test(t) || MSG_SOFT_TARGET.test(t)) (cheapMsgAt.get(pc) ?? cheapMsgAt.set(pc, []).get(pc)!).push(Date.parse(m.created_at));
  }
  const kindOf = (pc: string | undefined, at: string): "目安あり" | "家賃を安く（欄）" | "家賃を安く（発言）" | "言っていない" => {
    if (!pc) return "言っていない";
    const p = profAt(pc, at);
    if (p?.rentTarget != null) return "目安あり";
    if (p?.written?.rentCheap) return "家賃を安く（欄）";
    if ((cheapMsgAt.get(pc) ?? []).some((t) => t <= Date.parse(at))) return "家賃を安く（発言）";
    return "言っていない";
  };

  const pkBefore: Episode[] = [], pkAfter: Episode[] = [];
  const pkCust = new Map<string, string>();
  const kindOfEp = new Map<string, string>();
  const groups = new Map<string, Row[]>();
  for (const r of pk) { const k = String(r.batch_id ?? ""); if (!k) continue; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
  for (const [, rows] of groups) {
    const pc = String(rows[0].property_customer_id);
    const at = String(rows[0].created_at);
    const p = profAt(pc, at);
    const e0 = episodeFromPickups(rows, []);
    if (!e0 || !p) continue;
    const rows2 = rows.map((r) => {
      let f: Row = {}; try { f = factsFromPickup(r) as Row; } catch { /* 読めない */ }
      const rent = num(f.rent); const total = rent != null ? rent + (num(f.admin_fee_yen) ?? 0) : null;
      return { ...r, reason_codes: rejudgeRentCodes((Array.isArray(r.reason_codes) ? r.reason_codes : []) as string[], total, p, rent) };
    });
    const e1 = episodeFromPickups(rows2, [])!;
    pkBefore.push(e0); pkAfter.push(e1);
    kindOfEp.set(e0.id, kindOf(pc, at));
    pkCust.set(e0.id, pc);
  }
  for (const e of after.episodes) kindOfEp.set(e.id, kindOf(custOfEp.get(e.id), e.at));

  // neutral（目安の無い安さの人は帯を付けない）の新
  const stripBand = (eps: Episode[]) => eps.map((e) => {
    const k = kindOfEp.get(e.id);
    if (k !== "家賃を安く（欄）") return e;
    return { ...e, cands: e.cands.map((c) => ({ ...c, codes: settleFitBonus(c.codes.filter((x) => !/^RENT_BAND_/.test(x))) })) };
  });

  {
    // 旧と新で回の組が同じか（違えば比べられない。2026-09-29 に loadEpisodes のページの並びの抜け・重なりを見つけて直した）
    const ib = new Set(before.episodes.map((e) => e.id)), ia = new Set(after.episodes.map((e) => e.id));
    const diff = [...ib].filter((x) => !ia.has(x)).length + [...ia].filter((x) => !ib.has(x)).length;
    console.log(`■ 旧と新で回の組の違い: ${diff}回${diff ? "（⚠ 比べる前に揃っていない）" : ""}`);
  }
  const B = [...before.episodes, ...pkBefore];
  const A_band = [...after.episodes, ...pkAfter];
  const A_neutral = stripBand(A_band);
  const base = (over: Record<string, number>) => (c: string) => (c in over ? over[c] : baseReasonPoints(c));
  const fmt = (m: RankMetrics) => `${m.episodes}回 1位 ${pct(m.top1)}・3位以内 ${pct(m.top3)}・相対順位 ${m.relRank}・全部同点 ${m.allTied}`;
  const cmp = (title: string, b: Episode[], a: Episode[], over: Record<string, number> = {}) => {
    const mb = rankMetrics(b, base({}), W), ma = rankMetrics(a, base(over), W);
    console.log(`  ${title}\n    旧: ${fmt(mb)}\n    新: ${fmt(ma)}`);
    return { before: mb, after: ma };
  };
  const out: Row = { days: DAYS, rule: RENT_BAND_RULE, points: RENT_BAND_POINTS };

  // ── 点の表の候補（学び用 7割で選ぶ） ──
  //   時期で分ける（splitHoldout）と、家賃の札が変わる回（候補に家賃の値がある回）は新しい3割にほぼ全部入り、学び用では何も動かない
  //   （2026-09-29 の実行: 学び用 390回はどの表でも旧と同じ）→ 札が変わった回だけをお客様ごとに 7:3 に分けて選ぶ（同じ人が両方に入らない）
  const changedIds = new Set(changedEpisodeIds(B, A_neutral));
  const custKey = (e: Episode) => custOfEp.get(e.id) ?? pkCust.get(e.id) ?? e.id;
  const hash = (s: string) => { let x = 2166136261; for (const ch of s) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0; return x; };
  const trB = B.filter((e) => changedIds.has(e.id) && hash(custKey(e)) % 10 < 7), hoB = B.filter((e) => changedIds.has(e.id) && hash(custKey(e)) % 10 >= 7);
  const idsTr = new Set(trB.map((e) => e.id)), idsHo = new Set(hoB.map((e) => e.id));
  console.log(`\n■ 札が変わった回 ${changedIds.size}（学び用 ${trB.length}回・${new Set(trB.map(custKey)).size}人／確かめ用 ${hoB.length}回・${new Set(hoB.map(custKey)).size}人）`);
  {
    const t = splitHoldout(B);
    const ids = new Set(t.holdout.map((x) => x.id));
    out.time_holdout = cmp(`（参考）時期で分けた新しい3割 ${t.holdout.length}回・今の表`, t.holdout, A_neutral.filter((e) => ids.has(e.id)));
  }
  const pick = (eps: Episode[], ids: Set<string>) => eps.filter((e) => ids.has(e.id));
  const grid: Array<Record<string, number>> = [];
  for (const mid of [0, -3, -5]) for (const lower of [-5, -8, -10]) for (const low of [-8, -12, -15, -20]) for (const under of [-10, -20]) for (const near of [0, -3, -5]) {
    if (lower > mid || low > lower) continue;
    grid.push({ RENT_BAND_UPPER: 0, RENT_BAND_MID: mid, RENT_BAND_LOWER: lower, RENT_BAND_LOW: low, RENT_UNDER_MIN: under, RENT_NEAR_MIN: near });
  }
  const scoreTr = (over: Record<string, number>, eps: Episode[]) => rankMetrics(pick(eps, idsTr), base(over), W);
  const ranked = grid.map((g) => ({ g, n: scoreTr(g, A_neutral), b: scoreTr(g, A_band) }))
    .sort((x, y) => x.n.relRank - y.n.relRank || y.n.top3 - x.n.top3 || y.n.top1 - x.n.top1);
  console.log(`\n■ 点の表の候補（学び用 ${trB.length}回・neutral・相対順位の小さい順・上位8）`);
  for (const r of ranked.slice(0, 8)) console.log(`  中${r.g.RENT_BAND_MID} 下${r.g.RENT_BAND_LOWER} 8割未満${r.g.RENT_BAND_LOW} 下限未満${r.g.RENT_UNDER_MIN} 下限少し${r.g.RENT_NEAR_MIN}: ${fmt(r.n)}（band: 相対 ${r.b.relRank}）`);
  const cur = { RENT_BAND_UPPER: RENT_BAND_POINTS.RENT_BAND_UPPER, RENT_BAND_MID: RENT_BAND_POINTS.RENT_BAND_MID, RENT_BAND_LOWER: RENT_BAND_POINTS.RENT_BAND_LOWER, RENT_BAND_LOW: RENT_BAND_POINTS.RENT_BAND_LOW, RENT_UNDER_MIN: RENT_BAND_POINTS.RENT_UNDER_MIN, RENT_NEAR_MIN: RENT_BAND_POINTS.RENT_NEAR_MIN };
  console.log(`  今の表（コード）: ${fmt(scoreTr(cur, A_neutral))}`);
  console.log(`  旧（学び用）: ${fmt(rankMetrics(pick(B, idsTr), base({}), W))}`);
  // 家賃の札ごとの、選んだ物・選ばなかった物の数（札が変わった回・新）
  {
    const cnt = new Map<string, [number, number]>();
    for (const e of A_neutral.filter((x) => changedIds.has(x.id))) for (const c of e.cands) for (const k of c.codes.filter((x) => /^RENT_/.test(x))) { const v = cnt.get(k) ?? [0, 0]; v[c.chosen ? 0 : 1]++; cnt.set(k, v); }
    console.log("\n■ 家賃の札ごと（札が変わった回・選んだ／選ばない）");
    for (const [k, [a, b]] of [...cnt.entries()].sort()) console.log(`  ${k}: ${a}／${b}`);
    // 下限未満（保留）にした物のうちスタッフが選んだ物（目で読む）
    for (const e of A_neutral.filter((x) => changedIds.has(x.id))) for (const c of e.cands.filter((x) => x.chosen && x.codes.includes("RENT_UNDER_MIN")))
      console.log(`    下限未満なのに選んだ: ${e.id}（${kindOfEp.get(e.id)}・${e.cands.length}件）${c.key} 比 ${c.feats.rent_ratio ?? "-"}・AD ${c.feats.ad_months ?? "-"}`);
    out.code_counts = Object.fromEntries(cnt);
  }
  out.grid = ranked.map((r) => ({ ...r.g, train_neutral: r.n, train_band: r.b }));

  console.log(`\n■ 確かめ用（お客様で分けた3割・${hoB.length}回）: 今の表（コード）`);
  out.holdout = { neutral: cmp("neutral", pick(B, idsHo), pick(A_neutral, idsHo)), band: cmp("band（目安の無い安さの人にも帯）", pick(B, idsHo), pick(A_band, idsHo)) };
  out.holdout_best_grid = cmp(`学び用の1番の表 ${JSON.stringify(ranked[0].g)}`, pick(B, idsHo), pick(A_neutral, idsHo), ranked[0].g);

  console.log("\n■ 全部の回（今の表）");
  out.all = { neutral: cmp("全体・neutral", B, A_neutral), band: cmp("全体・band", B, A_band) };
  for (const src of ["snapshot", "pool", "pickup"]) out[`src_${src}`] = cmp(`材料 ${src}`, B.filter((e) => e.source === src), A_neutral.filter((e) => e.source === src));
  console.log("\n■ お客様の種類ごと（今の表）");
  for (const k of ["言っていない", "家賃を安く（欄）", "家賃を安く（発言）", "目安あり"]) {
    const f = (eps: Episode[]) => eps.filter((e) => kindOfEp.get(e.id) === k);
    out[`kind_${k}`] = { neutral: cmp(`${k}・neutral`, f(B), f(A_neutral)), band: cmp(`${k}・band`, f(B), f(A_band)) };
  }

  // ── 家賃の札が変わった回だけ（効き目が見える所） ──
  const chIds = changedIds;
  console.log(`\n■ 札が変わった回だけ（${chIds.size}回）`);
  out.changed = cmp("変わった回", B.filter((e) => chIds.has(e.id)), A_neutral.filter((e) => chIds.has(e.id)));

  // ── 回ごとに選んだ物の順位が上がった／下がった ──
  const rankOf = (e: Episode, over: Record<string, number> = {}) => {
    const s = e.cands.map((c) => ({ c, s: 50 + c.codes.reduce((a, k) => a + (W && k in W ? W[k] : base(over)(k)), 0) }));
    const ch = s.filter((x) => x.c.chosen);
    return Math.min(...ch.map((x) => 1 + s.filter((y) => y.s > x.s).length + s.filter((y) => y !== x && y.s === x.s).length / 2));
  };
  let up = 0, down = 0, same = 0; const moves: Row[] = [];
  const am = new Map(A_neutral.map((e) => [e.id, e]));
  for (const e of B) { const a = am.get(e.id); if (!a || !chIds.has(e.id)) continue; const r0 = rankOf(e), r1 = rankOf(a); if (r1 < r0) up++; else if (r1 > r0) down++; else same++; moves.push({ id: e.id, kind: kindOfEp.get(e.id), n: e.cands.length, before: r0, after: r1 }); }
  console.log(`  選んだ物の一番良い順位: 上がった ${up}・下がった ${down}・同じ ${same}`);
  const bm = new Map(B.map((e) => [e.id, e]));
  const show = (id: string) => {
    const e0 = bm.get(id)!, e1 = am.get(id)!;
    const sc = (codes: string[]) => 50 + codes.reduce((a, k) => a + (W && k in W ? W[k] : baseReasonPoints(k)), 0);
    const rows = e1.cands.map((c, i) => ({ c, s0: sc(e0.cands[i].codes), s1: sc(c.codes) })).sort((a, b) => b.s1 - a.s1);
    for (const r of rows) console.log(`      ${r.c.chosen ? "★" : "  "} ${String(r.c.key).slice(0, 22).padEnd(22)} 比 ${r.c.feats.rent_ratio ?? "-"}・築 ${r.c.feats.building_age ?? "-"}・AD ${r.c.feats.ad_months ?? "-"}  ${r.s0} → ${r.s1}  ${r.c.codes.filter((k) => /^RENT_/.test(k)).join(",")}`);
  };
  for (const m of moves.filter((x) => x.after > x.before)) { console.log(`    下がった ${m.id}（${m.kind}・${m.n}件）: ${m.before} → ${m.after}`); if (args.detail) show(m.id); }
  if (args.detail) for (const m of moves.filter((x) => x.after < x.before).slice(0, 6)) { console.log(`    上がった ${m.id}（${m.kind}・${m.n}件）: ${m.before} → ${m.after}`); show(m.id); }
  out.moves = moves;

  // ── R さんの回（9/29・リアプロ・27件）: 保存の札（旧）と家賃の札の付け直し（新）の並び ──
  {
    const ids = String(args.rids ?? "1772-1798").split("-").map(Number);
    const { data: rr } = await sb.from("property_pickups").select("id, batch_id, property_customer_id, conversation_id, rank, property_name, room_no, status, sent_at, created_at, reason_codes, score, verdict, summary_text, pdf_text")
      .gte("id", ids[0]).lte("id", ids[1] ?? ids[0]).order("id");
    const rows = (rr ?? []) as Row[];
    if (rows.length) {
      const pc = String(rows[0].property_customer_id);
      const p = profAt(pc, String(rows[0].created_at))!;
      console.log(`\n■ R さんの回（id ${ids.join("〜")}・下限 ${p.rentMin ?? "-"}・上限 ${p.rentMax ?? "-"}・目安 ${p.rentTarget ?? "-"}・家賃を安く ${p.written?.rentCheap ? "あり" : "なし"}）`);
      const isHeld = (codes: string[]) => codes.some((c) => DROP_REASON_CODES.has(c) || isHold(c));
      const list = rows.map((r) => {
        let f: Row = {}; try { f = factsFromPickup(r) as Row; } catch { /* 読めない */ }
        const rent = num(f.rent), adm = num(f.admin_fee_yen);
        const total = rent != null ? rent + (adm ?? 0) : null;
        const c0 = (Array.isArray(r.reason_codes) ? r.reason_codes : []) as string[];
        const c1 = rejudgeRentCodes(c0, total, p, rent);
        return { id: r.id, name: `${String(r.property_name ?? "").slice(0, 16)} ${r.room_no ?? ""}`.trim(), plan: f.floor_plan ?? "", age: num(f.building_age), total, ratio: total != null && p.rentMax ? +(total / p.rentMax).toFixed(2) : null,
          s0: scoreFromCodes(c0), s1: scoreFromCodes(c1), h0: isHeld(c0), h1: isHeld(c1), rentCodes: c1.filter((k) => /^RENT_/.test(k)).join(",") };
      });
      const r0 = [...list].sort((a, b) => Number(a.h0) - Number(b.h0) || b.s0 - a.s0), r1 = [...list].sort((a, b) => Number(a.h1) - Number(b.h1) || b.s1 - a.s1);
      console.log("  新の順 | 旧の順 | id | 物件 | 間取り | 築 | 家賃＋管理費（÷上限） | 旧の点 → 新の点 | 家賃の札");
      r1.forEach((x, i) => console.log(`  ${String(i + 1).padStart(2)} | ${String(r0.indexOf(x) + 1).padStart(2)} | ${x.id} | ${x.name.padEnd(20)} | ${x.plan} | ${x.age ?? "-"} | ${x.total ?? "-"}（${x.ratio ?? "-"}） | ${x.s0}${x.h0 ? "保留" : ""} → ${x.s1}${x.h1 ? "保留" : ""} | ${x.rentCodes}`));
      out.r_round = r1;
    }
  }

  // ── 目安の額を読めたお客様（全員） ──
  console.log("\n■ 目安の額を読めたお客様（条件欄・全員）");
  const allCust = await all((a, b) => sb.from("property_customers").select("id, rent_max, max_rent, rent_min, preferences, other_requests, additional_conditions").range(a, b) as never);
  const tg: Row[] = [];
  for (const c of allCust) { const p = buildCustomerProfile(c as CustomerLike, [], [], null, {}); const t = readRentTarget(c as CustomerLike, p.rentMin ?? null, p.rentMax); if (t != null) tg.push({ id: String(c.id).slice(0, 8), min: p.rentMin, max: p.rentMax, target: t.yen, withAdmin: t.withAdmin }); }
  for (const x of tg) console.log(`  ${x.id} 下限${x.min ?? "-"}・上限${x.max} → 目安 ${x.target}（${x.withAdmin ? "管理費込み" : "家賃だけ"}）`);
  console.log(`  ${tg.length}人 / ${allCust.length}人`);
  out.targets = tg;

  if (args.out) writeFileSync(String(args.out), JSON.stringify(out, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
