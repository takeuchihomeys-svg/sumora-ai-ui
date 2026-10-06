// scripts/audit-hooked-arrival-learning.ts（読むだけ・LLM なし・DB に書かない）
// 「刺さった新着1件」を物件検索の採点の学習に強い材料として入れる（2026-10-06 竹内さんの決定）ための材料の埋まり方・学んだ中身・採点への効き方。
//   週の学習（/api/cron/scoring-learning → hooked-arrival-learning-server.runHookLearning）と同じ関数で読む・学ぶ・確かめる。
//
//   1. 新着1件の🌟（recommendation_snapshots の候補1件以下・または本文が新着）に刺さったか（new-arrival-hook.newArrivalHookOf）
//   2. 物件の事実を埋める（新しい LLM 呼び出しはしない・hooked-arrival-learning.fillArrivalFacts）: 🌟の本文の値 → 候補の行 → 送った画像の読み取り
//      → 売上サポの行 → 相場の部屋 → 送付の記録
//   3. お客様の型（一人／二人以上 × 初期費用）ごとに、刺さった物に多い特徴を学ぶ（learnHookLeans・古い半分で学び新しい半分で確かめ）
//   4. 採点への効き方: scoring-learning の「スタッフが選んだ回」（🌟の回・拡張の回・売上サポの回）に加点を当て、1位一致・3位以内・相対順位が下がらないか
//
// 実行: npx tsx --env-file=.env.local scripts/audit-hooked-arrival-learning.ts [--days=400] [--evalDays=180] [--show=10] [--minLift=1.25] [--minHooked=8]（線の感度を見る時だけ）
import { createClient } from "@supabase/supabase-js";
import {
  learnHookLeans, hookLeanTable, evaluateHookBonus, pruneHookTable, hookTypeKeys, HOOK_FEATURE_JA, HOOK_LEARN_CONFIG, ARRIVAL_FACT_FIELDS,
  type HookRecord, type HookLeanTable,
} from "../app/lib/hooked-arrival-learning";
import { loadHookMaterials, hookFillSummary, hookEvalEpisodesOf } from "../app/lib/hooked-arrival-learning-server";
import { loadEpisodes } from "../app/lib/scoring-learning-server";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "400"), 10);
const EVAL_DAYS = parseInt(String(args.evalDays ?? "180"), 10);
const SHOW = parseInt(String(args.show ?? "10"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
const P = (...a: unknown[]) => console.log(...a);
const pct = (a: number, n: number) => (n ? `${Math.round((a / n) * 100)}%` : "-");

(async () => {
  const until = new Date().toISOString();
  const t0 = Date.now();
  const mats = await loadHookMaterials(sb as never, { until, days: DAYS });
  P(`=== 1. 新着1件の🌟（${DAYS}日・YUMA 除く・読み ${Math.round((Date.now() - t0) / 1000)}秒）===`);
  const hk = mats.filter((m) => m.hooked);
  P(`  ${mats.length}回・刺さった ${hk.length}（${pct(hk.length, mats.length)}）・断り ${mats.filter((m) => m.declined).length}・お客様の条件が引けた ${mats.filter((m) => m.type).length}・家賃の上限が分かる ${mats.filter((m) => m.rentMax).length}`);
  const sig: Record<string, number> = {}; for (const m of hk) for (const s of m.signals) sig[s] = (sig[s] ?? 0) + 1;
  P(`  刺さった印: ${JSON.stringify(sig)}`);

  P(`\n=== 2. 材料の埋まり方（全体／刺さった物・出どころの内訳）===`);
  P(`  項目 | 全体 | 刺さった | 出どころ（全体）`);
  const fill = hookFillSummary(mats);
  for (const k of ARRIVAL_FACT_FIELDS) {
    const x = fill[k];
    P(`  ${k} | ${x.filled}/${mats.length}（${pct(x.filled, mats.length)}）| ${x.hookedFilled}/${hk.length}（${pct(x.hookedFilled, hk.length)}）| ${Object.entries(x.sources).sort((a, b) => b[1] - a[1]).map(([a, b]) => `${a} ${b}`).join("・")}`);
  }
  const featN = (k: keyof typeof mats[number]["feats"]) => mats.filter((m) => m.type && m.feats[k] != null).length;
  P(`  特徴（型が分かる ${mats.filter((m) => m.type).length}回のうち）: 家賃÷上限 ${featN("rent_ratio")}・広さ ${featN("area_sqm")}・築年 ${featN("building_age")}・徒歩 ${featN("walk")}・敷礼0 ${featN("zero_zero")}`);

  const records: HookRecord[] = mats.filter((m) => m.type).map((m) => ({ at: m.sentAt, hooked: m.hooked, type: m.type!, feats: m.feats }));
  const CFG = { ...HOOK_LEARN_CONFIG, ...(args.minLift ? { minLift: parseFloat(String(args.minLift)) } : {}), ...(args.minHooked ? { minHooked: parseInt(String(args.minHooked), 10) } : {}) };
  const L = learnHookLeans(records, CFG);
  P(`\n=== 3. 型 × 特徴（全期間・刺さった物の中の割合 ÷ 送った物の中の割合＝lift）===`);
  P(`  線: lift≥${CFG.minLift}・刺さった≥${CFG.minHooked}・送った≥${CFG.minSent}・新しい半分で lift≥${CFG.confirmLift}かつ刺さった≥${CFG.confirmHooked}`);
  P(`  材料 ${L.records}回（刺さった ${L.hooked}）・学ぶ（古い半分）${L.train}・確かめ（新しい半分）${L.confirm}`);
  const typeN = new Map<string, { n: number; h: number }>();
  for (const r of records) for (const t of hookTypeKeys(r.type)) { const x = typeN.get(t) ?? { n: 0, h: 0 }; x.n++; if (r.hooked) x.h++; typeN.set(t, x); }
  for (const [t, x] of [...typeN].sort((a, b) => b[1].n - a[1].n)) P(`  型 ${t}: 送った ${x.n}・刺さった ${x.h}（${pct(x.h, x.n)}）`);
  for (const c of L.cells.filter((c) => c.sent >= 20)) P(`   ${c.type} | ${HOOK_FEATURE_JA[c.feature]} | 送った ${c.sentWith}/${c.sent}（${pct(c.sentWith, c.sent)}）| 刺さった ${c.hookedWith}/${c.hooked}（${pct(c.hookedWith, c.hooked)}）| lift ${c.lift ?? "-"}`);
  P(`\n  学んだ: ${L.leans.length}`);
  for (const l of L.leans) P(`   ✓ ${l.type} × ${HOOK_FEATURE_JA[l.feature]}: 学ぶ側 刺さった ${l.hookedWith}/${l.hooked}・送った ${l.sentWith}/${l.sent}・lift ${l.lift}／確かめ側 刺さった ${l.confirm.hookedWith}/${l.confirm.hooked}・lift ${l.confirm.lift}`);
  const skipBy: Record<string, number> = {}; for (const s of L.skipped) { const k = s.reason.replace(/（.*$/, ""); skipBy[k] = (skipBy[k] ?? 0) + 1; }
  P(`  落ちた: ${JSON.stringify(skipBy)}`);
  for (const s of L.skipped.filter((s) => /確かめられない|多くない/.test(s.reason) && !/lift 0\./.test(s.reason))) P(`   × ${s.type} × ${HOOK_FEATURE_JA[s.feature]}: ${s.reason}`);

  const table = hookLeanTable(L.leans);
  P(`\n=== 4. 採点への効き方（scoring-learning のスタッフが選んだ回・${EVAL_DAYS}日・加点 +${CFG.bonusEach}／上限 +${CFG.bonusMax}・入れる線 相対順位 ${CFG.minGain}）===`);
  P(`  学んだ表: ${JSON.stringify(table)}`);
  const { episodes, counts } = await loadEpisodes(sb as never, { until, days: EVAL_DAYS });
  P(`  回: ${JSON.stringify(counts)}`);
  const evs = hookEvalEpisodesOf(episodes);
  P(`  型が分かる回 ${evs.filter((e) => e.type).length}/${evs.length}`);
  const show = (lab: string, t: HookLeanTable) => {
    const r = evaluateHookBonus(evs, t, CFG);
    P(`  ${lab}: 1位 ${r.base.top1}→${r.withBonus.top1}・3位以内 ${r.base.top3}→${r.withBonus.top3}・相対順位 ${r.base.relRank}→${r.withBonus.relRank}（${r.base.episodes}回）・加点の候補 ${r.touched.cands}（${r.touched.episodes}回）・新だけ当たり ${r.pairs.newOnly}／旧だけ ${r.pairs.oldOnly} → ${r.use ? "使う" : "使わない"}: ${r.reason}`);
    for (const [src, v] of Object.entries(r.bySource)) P(`     ${src}: 1位 ${v.base.top1}→${v.withBonus.top1}・3位以内 ${v.base.top3}→${v.withBonus.top3}・相対順位 ${v.base.relRank}→${v.withBonus.relRank}（${v.base.episodes}回）`);
  };
  show("学んだ表", table);
  const pr = pruneHookTable(evs, table, CFG);
  P(`  1つずつ確かめて外した: ${pr.dropped.map((d) => `${d.type}×${HOOK_FEATURE_JA[d.feature]}（${d.reason}）`).join("／") || "なし"}`);
  show("残した表", pr.table);
  for (const l of L.leans) show(`  （単独）${l.type}×${HOOK_FEATURE_JA[l.feature]}`, { [l.type]: [l.feature] });

  P(`\n=== 例（刺さった新着・新しい順 ${SHOW}）===`);
  for (const m of hk.slice(-SHOW)) {
    const f = m.feats;
    P(`  ${m.sentAt.slice(0, 10)} ${m.name} ${m.room ?? ""} 印 ${m.signals.join("・")} 型 ${m.type ? hookTypeKeys(m.type).slice(1).join("/") : "?"} 家賃比 ${f.rent_ratio ?? "?"} 広さ ${f.area_sqm ?? "?"} 築 ${f.building_age ?? "?"} 徒歩 ${f.walk ?? "?"} 敷礼0 ${f.zero_zero ?? "?"}`);
  }
  P(`\n（全体 ${Math.round((Date.now() - t0) / 1000)}秒）`);
})().catch((e) => { console.error(e); process.exit(1); });
