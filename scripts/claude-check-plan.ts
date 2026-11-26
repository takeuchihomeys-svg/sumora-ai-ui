// scripts/claude-check-plan.ts — 本番と割れやすい場面の直しの、Claude の確かめの組を作る（読むだけ・LLM なし・流すのは出した1行）
// 2026-11-25 作業員A（統括役の頼み）: 効く問題から型の合う物を最大5問・--stage=brain・1回・見込み費用つき。表は scripts/lib/claude-check-gate.ts の SPLIT_SCENES
// 実行: npx tsx scripts/claude-check-plan.ts --switch=BRAIN_CHECK_PROMISE_FLOW [--eff=q465,q466] [--max=5]
//   --eff が無い時は memory/night_bundle_candidates.md の「組: …（SWITCH=on…）」の効く問題を読む
import { existsSync, readFileSync } from "node:fs";
import { parseCandidateBlocks } from "./lib/exam-worth";
import { claudeCheckTargets, claudeCheckLabel, claudeCheckRecord, loadProblemsLite, CLAUDE_BRAIN_USD_PER_REP, CLAUDE_CHECK_NIGHT_CAP_USD } from "./lib/claude-check-gate";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const sw = arg("switch");
if (!sw) { console.log("使い方: --switch=<スイッチ> [--eff=q…] [--max=5]"); process.exit(1); }
const max = Number(arg("max", "5")) || 5;

/** スイッチの効く問題（--eff か候補の書き付け） */
export function effOfSwitch(swName: string): string[] {
  if (arg("eff")) return arg("eff").split(",").map((x) => x.trim()).filter(Boolean);
  const f = ["memory/night_bundle_candidates.md", "../../../memory/night_bundle_candidates.md"].find((p) => existsSync(p));
  if (!f) return [];
  const groups = parseCandidateBlocks(readFileSync(f, "utf8").split("\n")).filter((g) => g.switches.includes(swName));
  return [...new Set(groups.flatMap((g) => g.eff))];
}

const probs = loadProblemsLite();
const eff = effOfSwitch(sw);
const targets = claudeCheckTargets(eff, probs).slice(0, max);
const rec = claudeCheckRecord(sw);
console.log(`■ Claude の確かめ（${sw}）: 効く問題 ${eff.length}・割れやすい場面の型に当たる ${targets.length}${rec ? `・記録あり ${rec.label}（${rec.pass}/${rec.n}）` : "・記録なし"}`);
if (!targets.length) { console.log("  型に当たる効く問題が無い＝確かめは要らない"); process.exit(0); }
const day = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
const label = claudeCheckLabel(sw, day);
console.log(`  問題: ${targets.map((t) => `${t.id}（${t.scenes.join("・")}）`).join("・")}`);
console.log(`  見込み: ${targets.length}問×1回×$${CLAUDE_BRAIN_USD_PER_REP} ≒ $${(targets.length * CLAUDE_BRAIN_USD_PER_REP).toFixed(2)}（Claude の分・22時以降・試験の係が空いた後・1晩の上限 ${CLAUDE_CHECK_NIGHT_CAP_USD}）`);
console.log(`  流す: ${sw}=on REPLAY_FLOOR_FILE=scripts/.replay-out/brain-exam-floor-${label}.json LLM_TEST_FINAL_CLAUDE=1 npx tsx --env-file=.env.local scripts/brain-exam.ts --label=${label} --only=${targets.map((t) => t.id).join(",")} --stage=brain`);
