// scripts/build-customer-pref-episodes.ts
// 「今までお客様に実際に送った物件」を起点に、お客様ごとのこだわりに合わせた重みを学ぶための材料を組み立てる（読むだけ・DB に書かない・LLM を呼ばない）。
// 組み立ては app/lib/customer-pref-learning-server.ts の loadPrefEpisodes（毎週の cron と同じ1か所）。純関数は app/lib/customer-pref-episodes.ts。
// 結果は JSON（既定: scratchpad の pcs/）→ scripts/backtest-customer-pref-weights.ts が読む。
//
// 2026-09-29 竹内「実際に今までお客さんに送った物件の部分で実績してもできるから、その点も併せて分析すればよりスコアリング強化できる」
//   正解は「スタッフが選んで送った事実」。お客様の返信の有無は使わない。重みはここでは直さない。
//
// ■ 材料
//   送付   … sent_properties のお客様に届いた行（全期間・2026-08-14〜）を 30分以内の連なりで1束に
//   候補   … 束の前 72h の売上サポの回（property_pickups・札は保存済み）→ 無ければ拡張の回（property_candidate_pools）をまとめて今の判定で付け直す
//   🌟     … recommendation_snapshots（🌟を送った時点の候補＝直近72hに送った物件の中で🌟にした物）は週1回の学習と同じ組み立て（参考として並べる）
//   条件   … property_customers を property_condition_history で送った時点へ戻す。履歴の無い欄（こだわり・NG の 9/27 前・ペット・自由文）は
//            行がその回より前から変わっていない時だけ使う（conditionsReadableAt・今の値を過去の回に当てない・2026-09-29 反証レビュー）
//   お客様 … 鍵は物件顧客 ID の先頭8文字。🌟だけのお客様も条件・履歴・発言を同じように読む（読めない回は strength=null）
//   強さ   … recommend-score-drift.customerStrength（条件欄・自由文・強い言い方・NG 欄・発言・言い直し）＋ 送った物件がその条件を満たす率
// ■ 個人情報: お客様は物件顧客 ID の先頭8文字だけ。名前・発言は出さない。YUMA（テスト用）は外す
//
// 実行: npx tsx --env-file=.env.local scripts/build-customer-pref-episodes.ts [--days=400] [--out-dir=path] [--show=5]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { loadPrefEpisodes, materialSummary } from "../app/lib/customer-pref-learning-server";
import { familyJa, type StrengthLevel } from "../app/lib/recommend-score-drift";
import { reasonJa } from "../app/lib/property-brain";
import { learnableByFamily, learnableByCode, type PrefEpisode } from "../app/lib/customer-pref-episodes";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "400"), 10);
const SHOW = parseInt(String(args.show ?? "5"), 10);
const OUT_DIR = String(args["out-dir"] ?? join(process.env.CLAUDE_SCRATCHPAD ?? process.env.TEMP ?? ".", "pcs"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const pct = (x: number | null | undefined) => (x == null ? "-" : `${Math.round(x * 100)}%`);

async function main() {
  const until = Date.now();
  const load = await loadPrefEpisodes(sb as never, { days: DAYS, until: new Date(until).toISOString() });
  const { episodes, counts, bundleStats, unreadableCount, prefOf } = load;
  // 学べる件数の強さは「その回の時点のお客様の書き方・言い方」だけ（sentFit で上げた強さは、同じ送付を正解にも使うので循環する＝表には使わない）
  const strengthOf = (e: PrefEpisode, family: string): StrengthLevel => (e as (typeof episodes)[number]).strength?.[family]?.level ?? "none";
  const byCust = new Map<string, number>();
  for (const e of episodes) byCust.set(e.customerKey, (byCust.get(e.customerKey) ?? 0) + 1);

  // ── 報告 ─────────────────────────────────────────────────────────────────────
  const bundleEps = episodes.filter((e) => e.source !== "snapshot");
  const summaryAll = materialSummary(episodes), summaryBundle = materialSummary(bundleEps);
  console.log(`=== 送った物件を起点にした学習の材料（${DAYS}日・YUMA 除く・読むだけ）===`);
  console.log("材料:", JSON.stringify(counts));
  console.log("束:", JSON.stringify(bundleStats));
  console.log("その回の時点で読めなかった欄（回の数）:", JSON.stringify(unreadableCount));
  const line = (t: string, s: ReturnType<typeof materialSummary>) => console.log(`${t}: お客様 ${s.customers}人・回 ${s.rounds}・候補 ${s.candidates}件（選んだ ${s.chosen}）・候補に当たらなかった送付 ${s.unmatchedSends}件\n  材料別: ${JSON.stringify(s.bySource)}\n  月別: ${JSON.stringify(s.byMonth)}\n  経路: ${JSON.stringify(s.byVia)}`);
  line("■ 送付の束の回（売上サポ／拡張の回の候補）", summaryBundle);
  line("■ 全部（🌟の回を含む）", summaryAll);
  console.log(`  候補で条件が読めている数（回の候補 ${summaryAll.candidates}件中）: ${Object.entries(summaryAll.familyCoverage).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${familyJa(f)} ${n}`).join("・")}`);
  console.log(`  訴求の文がある回 ${episodes.filter((e) => e.appealTexts.length).length}・👑 と違う物を選んだ回（仮説の材料） ${episodes.filter((e) => e.hyp).length}`);

  const klass = new Map<string, number>();
  for (const p of prefOf.values()) klass.set(p.base.klass, (klass.get(p.base.klass) ?? 0) + 1);
  console.log(`\n■ お客様のこだわりの強さ（${prefOf.size}人・書き方・言い方から）: ${[...klass].map(([k, n]) => `${k} ${n}人`).join("・")}`);
  const raisedCount = new Map<string, number>();
  for (const p of prefOf.values()) for (const f of p.raisedBySentFit) raisedCount.set(f, (raisedCount.get(f) ?? 0) + 1);
  console.log(`  送った物件がその条件を 85% 以上満たす（3件以上）stated の条件 ＝ sentFit で strong に上がる候補（参考・下の表には使わない）: ${[...raisedCount].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${familyJa(f)} ${n}人`).join("・") || "なし"}`);
  const fitAgg = new Map<string, { ok: number; known: number; custs: number }>();
  for (const p of prefOf.values()) for (const [f, v] of Object.entries(p.sentFit)) { const a = fitAgg.get(f) ?? { ok: 0, known: 0, custs: 0 }; a.ok += v.ok; a.known += v.known; a.custs++; fitAgg.set(f, a); }
  console.log(`  送った物件が条件を満たす率（全員・条件が読めた送付だけ）: ${[...fitAgg].sort((a, b) => b[1].known - a[1].known).map(([f, a]) => `${familyJa(f)} ${pct(a.ok / a.known)}（${a.known}件・${a.custs}人）`).join("・")}`);

  const famRows = learnableByFamily(episodes, strengthOf);
  console.log(`\n■ 条件の種類 × こだわりの強さ: 学べる回（選んだ物と選ばなかった物で満たすかが違う回）｜お客様｜選んだ物が満たす｜候補全体｜どの候補でも読めない回`);
  for (const r of famRows.filter((x) => x.rounds > 0 || x.level === "all")) console.log(`  ${familyJa(r.family)}｜${r.level}｜${r.rounds}｜${r.customers}｜${pct(r.chosenOk)}｜${pct(r.poolOk)}｜${r.blindRounds}`);
  const famBundle = learnableByFamily(bundleEps, strengthOf);
  console.log(`\n■ 〃 送付の束の回だけ（🌟の回を除く）`);
  for (const r of famBundle.filter((x) => x.rounds > 0)) console.log(`  ${familyJa(r.family)}｜${r.level}｜${r.rounds}｜${r.customers}｜${pct(r.chosenOk)}｜${pct(r.poolOk)}｜${r.blindRounds}`);

  const codeRows = learnableByCode(episodes, strengthOf);
  console.log(`\n■ 札ごと × 強さ: 学べる回（札の有無が違う回・凍結の札は除く）｜お客様｜選んだ方が持つ率（上位）`);
  for (const r of codeRows.filter((x) => x.level === "all").slice(0, 30)) {
    const sub = codeRows.filter((x) => x.code === r.code && x.level !== "all").map((x) => `${x.level} ${x.rounds}回 ${pct(x.winRate)}`).join(" / ");
    console.log(`  ${r.code}（${reasonJa(r.code)}）｜${r.rounds}｜${r.customers}｜${pct(r.winRate)}｜${sub}`);
  }

  console.log(`\n■ 実例（送付の束の回・新しい順・${SHOW}件）`);
  for (const e of [...bundleEps].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, SHOW)) {
    const p = prefOf.get(e.customerKey);
    const chosen = e.cands.filter((c) => c.chosen);
    const strong = Object.entries(p?.level ?? {}).filter(([, v]) => v === "strong").map(([f]) => familyJa(f));
    console.log(`  [${e.source}] 会話 ${e.customerKey}…・${e.at.slice(0, 16)}・経路 ${e.vias.join("+")}・送付 ${e.sent}件（候補に当たった ${e.matched}）・候補 ${e.cands.length}件${e.poolsMerged ? `・拡張の回 ${e.poolsMerged}回をまとめた` : ""}・こだわり ${p?.base.klass}（指数 ${p?.base.index}）・強い条件: ${strong.join("、") || "なし"}`);
    for (const c of chosen.slice(0, 3)) console.log(`    選んだ ${c.key}: ${typeof c.feats.score === "number" ? `${c.feats.score}点` : "点なし"}・${c.codes.slice(0, 8).join(" ")}`);
    const top = [...e.cands].filter((c) => !c.chosen && typeof c.feats.score === "number").sort((a, b) => (b.feats.score as number) - (a.feats.score as number))[0];
    if (top) console.log(`    選ばなかった中の1位 ${top.key}: ${top.feats.score}点・${top.codes.slice(0, 8).join(" ")}`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const custTable = [...prefOf].map(([k, p]) => ({
    customer: k, klass: p.base.klass, index: p.base.index, ngCount: p.base.ngCount, emphasisCount: p.base.emphasisCount, restatements: p.base.restatements, messages: p.base.messages,
    rounds: byCust.get(k) ?? 0, strong: Object.entries(p.level).filter(([, v]) => v === "strong").map(([f]) => f), raisedBySentFit: p.raisedBySentFit, sentFit: p.sentFit,
  }));
  // 個人情報を出さない: 発言・訴求の文・資料の文字は JSON に残さない（件数だけ）
  const slim = episodes.map(({ appealTexts, hyp, conversationId, ...e }) => ({ ...e, appealCount: appealTexts.length, hypothesis: hyp ? { crownKey: hyp.crownKey, chosenKey: hyp.chosenKey } : null, hasConversation: !!conversationId }));
  writeFileSync(join(OUT_DIR, "episodes.json"), JSON.stringify({ days: DAYS, builtAt: new Date(until).toISOString(), counts, bundleStats, episodes: slim }, null, 1));
  writeFileSync(join(OUT_DIR, "summary.json"), JSON.stringify({ days: DAYS, counts, bundleStats, unreadableCount, summaryAll, summaryBundle, learnableByFamily: famRows, learnableByFamilyBundle: famBundle, learnableByCode: codeRows, customers: custTable }, null, 1));
  console.log(`\n→ ${join(OUT_DIR, "episodes.json")}・${join(OUT_DIR, "summary.json")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
