// scripts/backtest-ad-points.ts
// AD の段の点（property-brain REASON_POINTS の AD_*）の当て直し（読むだけ・DB に書かない・LLM を呼ばない）。
//
// 2026-09-30 竹内「AD1 で加点高すぎる。AD1 の加点は 0 くらいで、AD1.5 がプラス 10 点、AD2 がプラス 22 点等…
//   AD1 はあって当たり前で、逆に AD1 未満は他に物件ある場合はお客さんに出さないレベル。AD1 か 2 かで売り上げは倍」
// ■ 物差しは scoring-learning と同じ（正解＝スタッフが選んで送った事実・rankMetrics の 1位率／3位以内率／相対順位）
//   札（AD の段）は変わらず点だけ変わるので、同じ回の札に旧の点と新の点を当てて比べる
// ■ 出す物: AD の段ごとの 選んだ／選ばない の数（スタッフが AD の高い物を選ぶ割合）／旧と新と候補の表／
//   同じ回の中で「通す AD2 以上」が「通す AD1」より下に並んだ組の数（釣り合い）／朱莉さん・R さんの回の並びの前後
//
// 実行: npx tsx --env-file=.env.local scripts/backtest-ad-points.ts [--days=180] [--akari=<batch_id>] [--rids=1772-1798]
import { createClient } from "@supabase/supabase-js";
import { baseReasonPoints, REASON_POINTS, HOLD_REASON_CODES, DROP_REASON_CODES } from "../app/lib/property-brain";
import { loadEpisodes } from "../app/lib/scoring-learning-server";
import { rankMetrics, splitHoldout, type Episode, type RankMetrics } from "../app/lib/scoring-learning";
import { pickupAdTier, type PickupAdTier } from "../app/lib/pickup-ad-priority";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "180"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const fmt = (m: RankMetrics) => `${m.episodes}回 1位 ${pct(m.top1)}・3位以内 ${pct(m.top3)}・相対順位 ${m.relRank}`;

/** 2026-09-30 より前の AD の点（9/25 案B＋9/27 の AD 1ヶ月未満） */
export const OLD_AD: Record<string, number> = { AD_1M: 15, AD_1_5M: 2, AD_HIGH: 20, AD_2_5M: 0, AD_VERY_HIGH: 0, AD_UNDER_1M: -15, AD_NONE: -20 };
const AD_KEYS = Object.keys(OLD_AD);
const NEW_AD: Record<string, number> = Object.fromEntries(AD_KEYS.map((k) => [k, REASON_POINTS[k]]));

const pts = (over: Record<string, number>) => (c: string) => (c in over ? over[c] : baseReasonPoints(c));
const scoreOf = (codes: string[], over: Record<string, number>) => Math.max(0, Math.min(200, 50 + codes.reduce((a, k) => a + pts(over)(k), 0)));
const isHeld = (codes: string[]) => codes.some((c) => DROP_REASON_CODES.has(c) || HOLD_REASON_CODES.has(c) || /_HELD$/.test(c) || /^(?:IMAGE|EQUIP|CONDITION)_.*_NG$/.test(c));
const TIERS: PickupAdTier[] = ["ad2", "ad15", "ad1", "unknown", "low"];

async function main() {
  const until = new Date().toISOString();
  const load = await loadEpisodes(sb as never, { until, days: DAYS });
  const eps = load.episodes;
  console.log(`■ 期間 ${DAYS}日・回 ${eps.length}`, load.counts);
  console.log("■ 旧の AD の点", OLD_AD, "\n■ 新の AD の点（コード）", NEW_AD);

  // ── AD の段ごとの 選んだ／選ばない（全部・通すだけ） ──
  {
    const cnt: Record<string, [number, number]> = {}, cntPass: Record<string, [number, number]> = {};
    for (const e of eps) for (const c of e.cands) {
      const t = pickupAdTier(c.codes);
      (cnt[t] ??= [0, 0])[c.chosen ? 0 : 1]++;
      if (!isHeld(c.codes)) (cntPass[t] ??= [0, 0])[c.chosen ? 0 : 1]++;
    }
    console.log("\n■ AD の段ごと 選んだ／選ばない（選ばれる率）");
    for (const t of TIERS) {
      const [a, b] = cnt[t] ?? [0, 0], [pa, pb] = cntPass[t] ?? [0, 0];
      console.log(`  ${t.padEnd(8)} 全部 ${a}／${b}（${pct(a / Math.max(1, a + b))}）・保留でない物 ${pa}／${pb}（${pct(pa / Math.max(1, pa + pb))}）`);
    }
    // 回の中で AD2 以上と AD1 が両方ある時、スタッフはどちらを選んだか（回ごとの率の平均）
    let n = 0, sum = 0;
    for (const e of eps) {
      const hi = e.cands.filter((c) => pickupAdTier(c.codes) === "ad2" && !isHeld(c.codes)), lo = e.cands.filter((c) => pickupAdTier(c.codes) === "ad1" && !isHeld(c.codes));
      let w = 0, k = 0;
      for (const a of hi) for (const b of lo) if (a.chosen !== b.chosen) { w += a.chosen ? 1 : 0; k++; }
      if (k) { n++; sum += w / k; }
    }
    console.log(`  同じ回に 通す AD2以上 と 通す AD1 があり片方だけ選ばれた組: ${n}回・AD2以上を選んだ率 ${pct(sum / Math.max(1, n))}`);
    let n2 = 0, s2 = 0;
    for (const e of eps) {
      const hi = e.cands.filter((c) => pickupAdTier(c.codes) === "ad15" && !isHeld(c.codes)), lo = e.cands.filter((c) => pickupAdTier(c.codes) === "ad1" && !isHeld(c.codes));
      let w = 0, k = 0;
      for (const a of hi) for (const b of lo) if (a.chosen !== b.chosen) { w += a.chosen ? 1 : 0; k++; }
      if (k) { n2++; s2 += w / k; }
    }
    console.log(`  同じ回に 通す AD1.5 と 通す AD1 があり片方だけ選ばれた組: ${n2}回・AD1.5 を選んだ率 ${pct(s2 / Math.max(1, n2))}`);
    // AD2 以上の中の細かい段（2・2.5・3以上）
    const fine = (c: { codes: string[] }) => { const s = new Set(c.codes.map((x) => x.replace(/_HELD$/, ""))); return s.has("AD_VERY_HIGH") ? "3+" : s.has("AD_2_5M") ? "2.5" : s.has("AD_HIGH") ? "2" : null; };
    const fc: Record<string, [number, number]> = {};
    for (const e of eps) for (const c of e.cands) { const f = fine(c); if (f && !isHeld(c.codes)) (fc[f] ??= [0, 0])[c.chosen ? 0 : 1]++; }
    console.log("  AD2 以上の中（保留でない物）:", Object.entries(fc).map(([k, [a, b]]) => `${k} ${a}／${b}（${pct(a / (a + b))}）`).join("・"));
    for (const [hiT, loT] of [["3+", "2"], ["2.5", "2"], ["3+", "2.5"]]) {
      let n3 = 0, s3 = 0;
      for (const e of eps) {
        const hi = e.cands.filter((c) => fine(c) === hiT && !isHeld(c.codes)), lo = e.cands.filter((c) => fine(c) === loT && !isHeld(c.codes));
        let w = 0, k = 0;
        for (const a of hi) for (const b of lo) if (a.chosen !== b.chosen) { w += a.chosen ? 1 : 0; k++; }
        if (k) { n3++; s3 += w / k; }
      }
      console.log(`  同じ回の AD${hiT} と AD${loT}（片方だけ選ばれた組）: ${n3}回・AD${hiT} を選んだ率 ${pct(s3 / Math.max(1, n3))}`);
    }
  }

  // ── 表の比べ ──
  const { train, holdout } = splitHoldout(eps);
  const cmp = (title: string, over: Record<string, number>) => {
    const a = rankMetrics(eps, pts(over)), tr = rankMetrics(train, pts(over)), ho = rankMetrics(holdout, pts(over));
    console.log(`  ${title}\n     全部 ${fmt(a)}\n     学び用 ${fmt(tr)}／確かめ用 ${fmt(ho)}`);
    return { a, tr, ho };
  };
  console.log("\n■ 表の比べ（札は同じ・点だけ）");
  cmp("旧", OLD_AD);
  cmp("新（コード）", NEW_AD);
  // AD2 より上（2.5・3以上）の上乗せだけ変えた表（1.5=10・2=22 は竹内さんの線のまま）
  for (const [h25, h3] of [[0, 0], [2, 2], [3, 3], [4, 0], [4, 4], [6, 6]]) cmp(`2.5以上 +${h25}・3以上 さらに +${h3}（AD2.5 ${22 + h25}・AD3 ${22 + h25 + h3}）`, { ...NEW_AD, AD_2_5M: h25, AD_VERY_HIGH: h3 });
  const grid: Array<Record<string, number>> = [];
  for (const h15 of [8, 10, 12]) for (const h2 of [20, 22, 25]) for (const h25 of [0, 3, 6]) for (const h3 of [0, 3, 6]) grid.push({ ...NEW_AD, AD_1M: 0, AD_1_5M: h15, AD_HIGH: h2, AD_2_5M: h25, AD_VERY_HIGH: h3 });
  const ranked = grid.map((g) => ({ g, m: rankMetrics(train, pts(g)) })).sort((x, y) => x.m.relRank - y.m.relRank || y.m.top3 - x.m.top3);
  console.log("  候補（学び用の相対順位の小さい順・上位6 → 確かめ用）");
  for (const r of ranked.slice(0, 6)) console.log(`    1.5=${r.g.AD_1_5M} 2=${r.g.AD_HIGH} 2.5+=${r.g.AD_2_5M} 3+=${r.g.AD_VERY_HIGH}: 学び用 ${fmt(r.m)}／確かめ用 ${fmt(rankMetrics(holdout, pts(r.g)))}`);

  // ── 釣り合い: 同じ回で 通す AD2 以上 が 通す AD1 より点が下の組 ──
  const lose = (over: Record<string, number>) => {
    let pairs = 0, lost = 0; const ex: string[] = [];
    for (const e of eps) {
      const pass = e.cands.filter((c) => !isHeld(c.codes));
      for (const a of pass.filter((c) => pickupAdTier(c.codes) === "ad2")) for (const b of pass.filter((c) => pickupAdTier(c.codes) === "ad1")) {
        pairs++;
        if (scoreOf(a.codes, over) < scoreOf(b.codes, over)) { lost++; if (ex.length < 5) ex.push(`${e.id} ${a.key}(${scoreOf(a.codes, over)}) < ${b.key}(${scoreOf(b.codes, over)}) 差の札: ${b.codes.filter((x) => !a.codes.includes(x)).join(",")}`); }
      }
    }
    return { pairs, lost, ex };
  };
  console.log("\n■ 釣り合い（同じ回の 通す AD2以上 と 通す AD1 の組で AD2 が下に並んだ数）");
  for (const [n, o] of [["旧", OLD_AD], ["新", NEW_AD]] as const) { const r = lose(o); console.log(`  ${n}: ${r.lost}/${r.pairs}（${pct(r.lost / Math.max(1, r.pairs))}）`); for (const x of r.ex) console.log(`     ${x}`); }

  // ── 朱莉さん・R さんの回の並び ──
  const showRound = async (title: string, filter: (q: any) => any) => {
    const { data } = await filter(sb.from("property_pickups").select("id, rank, property_name, room_no, status, reason_codes, score, verdict").order("id"));
    const rows = (data ?? []) as Array<{ id: number; property_name: string; room_no: string | null; status: string; reason_codes: string[] | null; score: number | null; verdict: string | null }>;
    if (!rows.length) { console.log(`\n■ ${title}: 行なし`); return; }
    const list = rows.map((r) => { const c = r.reason_codes ?? []; return { r, t: pickupAdTier(c), h: isHeld(c), s0: scoreOf(c, OLD_AD), s1: scoreOf(c, NEW_AD) }; });
    // 売上サポの並び（sortForReview）と同じ: 判定の点 → 同じ点なら通す＞保留
    const o0 = [...list].sort((a, b) => b.s0 - a.s0 || Number(a.h) - Number(b.h)), o1 = [...list].sort((a, b) => b.s1 - a.s1 || Number(a.h) - Number(b.h));
    console.log(`\n■ ${title}（${rows.length}件）: 新の順 | 旧の順 | id | 物件 | AD の段 | 旧の点 → 新の点 | 送った`);
    o1.forEach((x, i) => console.log(`  ${String(i + 1).padStart(2)} | ${String(o0.indexOf(x) + 1).padStart(2)} | ${x.r.id} | ${`${x.r.property_name} ${x.r.room_no ?? ""}`.slice(0, 24).padEnd(24)} | ${x.t.padEnd(7)} | ${x.s0}${x.h ? "保留" : ""} → ${x.s1}${x.h ? "保留" : ""} | ${x.r.status === "sent" ? "★送った" : ""}`));
  };
  // 朱莉さん（物件顧客 04e88194…）の 9/30 の回（まとめた回すべて）
  const akari = String(args.akari ?? "04e88194-9f90-4c09-8f40-151100420ee1");
  await showRound(`朱莉さんの 9/30 の回（${akari.slice(0, 8)}）`, (q) => q.eq("property_customer_id", akari).gte("created_at", "2026-09-29T15:00:00Z"));
  const rids = String(args.rids ?? "1772-1798").split("-").map(Number);
  await showRound(`R さんの回（id ${rids.join("〜")}）`, (q) => q.gte("id", rids[0]).lte("id", rids[1] ?? rids[0]));
}
main().catch((e) => { console.error(e); process.exit(1); });
