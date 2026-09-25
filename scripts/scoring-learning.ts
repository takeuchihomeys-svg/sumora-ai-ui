// scripts/scoring-learning.ts
// 物件の点の重みの学習を手で回す・版を見る・切り替える・戻す（/api/cron/scoring-learning と同じ処理）。
// 決定論・LLM を呼ばない。正解は「スタッフが選んで送った事実」（お客様の反応は使わない）。
//
// 実行:
//   npx tsx --env-file=.env.local scripts/scoring-learning.ts --dry [--until=2026-09-25T12:00:00Z] [--days=180] [--out=path.json]   … 測りと提案（DB に書かない）
//   npx tsx --env-file=.env.local scripts/scoring-learning.ts --run                                                               … 測り・提案を DB に残す（週1回の cron と同じ）
//   npx tsx --env-file=.env.local scripts/scoring-learning.ts --status                                                            … 版と直近の結果
//   npx tsx --env-file=.env.local scripts/scoring-learning.ts --activate=N                                                        … 版 N を入れる（0＝コードの定数に戻す）
//   npx tsx --env-file=.env.local scripts/scoring-learning.ts --rollback                                                          … 前の版に戻す
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { runScoringLearning, listWeightVersions, activateWeightVersion, rollbackWeightVersion } from "../app/lib/scoring-learning-server";
import { FEATURE_JA } from "../app/lib/scoring-learning";
import { SEGMENT_JA } from "../app/lib/scoring-learning-episodes";
import { reasonJa } from "../app/lib/property-brain";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

async function main() {
  if (args.status) {
    console.log(await listWeightVersions(sb));
    const { data } = await sb.from("scoring_learning_runs").select("id, created_at, episodes_total, holdout_n, improved, decision, proposed_version, auto_applied, auto_reason").order("id", { ascending: false }).limit(5);
    console.log(data);
    return;
  }
  if (args.activate != null) { console.log(await activateWeightVersion(sb, parseInt(String(args.activate), 10), "manual")); return; }
  if (args.rollback) { console.log(await rollbackWeightVersion(sb)); return; }

  const dry = !args.run;
  const r = await runScoringLearning(sb, { dry, until: args.until ? String(args.until) : undefined, days: args.days ? parseInt(String(args.days), 10) : 180, autoApplyEnabled: false });
  const m = (x: typeof r.metrics.all) => `${x.episodes}回 1位 ${pct(x.top1)}（でたらめ ${pct(x.randTop1)}）・3位以内 ${pct(x.top3)}（でたらめ ${pct(x.randTop3)}）・相対順位 ${x.relRank}・全部同点 ${x.allTied}`;
  console.log(`■ 期間 ${r.days}日（〜${r.until}）・今の版 ${r.activeVersion}・${dry ? "dry（DB に書かない）" : "run"}`);
  console.log("■ 件数", r.counts);
  console.log(`■ 今の点での順位\n  全体: ${m(r.metrics.all)}`);
  for (const [s, x] of Object.entries(r.metrics.bySource)) console.log(`  ${s}: ${m(x)}`);
  console.log(`  学び用: ${m(r.metrics.train)}\n  確かめ用: ${m(r.metrics.holdout)}`);
  console.log(`  （参考・提案ではない）AD の札を0にした時 全体: ${m(r.metrics.adNeutralAll)}\n  （参考）AD の札を0にした時 確かめ用: ${m(r.metrics.adNeutralHoldout)}`);
  console.log("■ 特徴ごと（選んだ方が良い率・回数・z）");
  for (const [f, s] of Object.entries(r.features).sort((a, b) => Math.abs(b[1].z) - Math.abs(a[1].z))) if (s.episodes) console.log(`  ${FEATURE_JA[f] ?? f}: ${pct(s.winRate)}（${s.episodes}回・z ${s.z}）`);
  console.log("■ 条件の種類ごと（|z|≥2 の特徴）");
  for (const [seg, v] of Object.entries(r.segments)) {
    const hits = Object.entries(v.features).filter(([, s]) => Math.abs(s.z) >= 2).map(([f, s]) => `${FEATURE_JA[f] ?? f} ${pct(s.winRate)}（${s.episodes}回）`);
    console.log(`  ${SEGMENT_JA[seg] ?? seg}（${v.episodes}回）: ${hits.join(" ／ ") || "はっきりした差なし"}`);
  }
  console.log("■ 札ごと（選んだ方が札を持つ率・回数≥10）");
  for (const [c, s] of Object.entries(r.codes).filter(([, s]) => s.episodes >= 10).sort((a, b) => Math.abs(b[1].z) - Math.abs(a[1].z)).slice(0, 25)) console.log(`  ${c}（${reasonJa(c)}）: ${pct(s.winRate)}（${s.episodes}回・z ${s.z}）`);
  console.log("■ 提案");
  for (const c of r.proposal.changes) console.log(`  ${c.code}（${reasonJa(c.code)}）: ${c.from} → ${c.to}（${c.episodes}回・選ばれる率 ${pct(c.winRate)}・z ${c.z}）`);
  if (!r.proposal.changes.length) console.log("  なし");
  console.log("■ 出さなかった札（上位）");
  for (const s of r.proposal.skipped.filter((x) => x.episodes >= 5).slice(0, 15)) console.log(`  ${s.code}: ${s.reason}（${s.episodes}回・${pct(s.winRate)}・z ${s.z}）`);
  console.log(`■ 確かめ用: ${r.evaluation.improved ? "当たりが良くなった" : "入れない"} — ${r.evaluation.reason}`);
  console.log(`  今: ${m(r.evaluation.base)}\n  案: ${m(r.evaluation.proposed)}`);
  console.log(`■ 自動で入れるか: ${r.autoApply.apply ? "入れる" : "入れない"}（${r.autoApply.reason}）`);
  if (!dry) console.log(`■ 記録: run ${r.runId}・提案の版 ${r.proposedVersion ?? "なし"}${r.error ? `・エラー ${r.error}` : ""}`);
  if (args.out) writeFileSync(String(args.out), JSON.stringify(r, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
