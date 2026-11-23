// scripts/foundation-scene-rule-drafts.ts — 土台の表の「場面の決まりの空き」を、竹内さん本人の実送信の過半数の形で埋める案をまとめて作る（読むだけ・LLM なし・費用0・作業員N2・2026-11-23・台帳 #505）
//
// 竹内さんの決定（11/23・KB 0f38f47f）の型（土台→細分化→物差し→弱い所を自動で見つけて直す→統括につなぐ）で、土台ごとの「場面の決まり」の空きを埋める元を作る。
//   土台ごとに、竹内さん本人の番を場面で分けて数える台本がある物はそれを流し（60日・夜だけ）、案（設計知見の P2 の JSON・"draft" の目印つき＝kb-insert は
//   --approved 無しでは入れない）と、割れた場面の確認案（竹内さんへ）を1か所（--out-dir）に集める。台本の無い土台は「形の決め方が無い＝持ち主に頼む」として並べる。
//   DB には書かない。設計知見にも入れない（統括役が読んでから kb-insert --approved）。
// 実行（22時以降）: npx tsx --env-file=.env.local scripts/foundation-scene-rule-drafts.ts [--days=60] [--out-dir=<置き場>] [--plan]（--plan は流さずに計画だけ・昼でも可）
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { foundationFill } from "./foundation-fill";
import { runTsx } from "./lib/self-improve-growth";
import { sceneRulePlanOf } from "./lib/foundation-scene-rule-plan";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const days = Number(arg("days", "60")) || 60;
  const outDir = arg("out-dir", "memory/foundation_scene_rule_drafts");
  const ff = await foundationFill(sb);
  const plan = sceneRulePlanOf(ff.fill.map((f) => ({ id: f.id, name: f.name, owner: f.owner, emptyScenes: f.emptyScenes })), { days, outDir });
  console.log(`# 場面の決まりの空き（土台 ${plan.length}・空きの欄 ${plan.reduce((a, p) => a + p.scenes.length, 0)}）`);
  for (const p of plan) console.log(`- ${p.name}（${p.owner}）: 空き ${p.scenes.join("・")}｜${p.cmd ? `流す: npx tsx ${p.cmd.join(" ")}` : `形の決め方が無い（${p.why}）`}`);
  if (process.argv.includes("--plan")) return;
  const h = (new Date().getUTCHours() + 9) % 24;
  if (h >= 9 && h < 22 && !process.argv.includes("--force")) { console.error("60日の数えは22時以降（--plan で計画だけは昼でも出せる）"); process.exit(1); }
  mkdirSync(outDir, { recursive: true });
  const done: string[] = [];
  for (const p of plan.filter((x) => x.cmd)) {
    try {
      const out = runTsx(p.cmd!, 20 * 60_000);
      writeFileSync(join(outDir, `${p.id}.log.txt`), out);
      done.push(`- ${p.name}: 済み（${p.files.join("・") || `${p.id}.log.txt`}）`);
    } catch (e) { done.push(`- ${p.name}: 止まった（${e instanceof Error ? e.message.slice(0, 120) : e}）`); }
  }
  const md = [`# 場面の決まりの案（${new Date().toISOString().slice(0, 16)}Z・${days}日・竹内さん本人の番・scripts/foundation-scene-rule-drafts.ts）`, "",
    "読んでから kb-insert --approved=<誰が・何を読んだ> で入れる（案の JSON には draft の目印がある）。割れた場面は確認案の md を竹内さんへの確認事項に。", "",
    ...done, "", "## 形の決め方が無い土台（持ち主に頼む）", ...plan.filter((x) => !x.cmd).map((x) => `- ${x.name}（${x.owner}）: ${x.scenes.join("・")}｜${x.why}`)].join("\n");
  writeFileSync(join(outDir, "README.md"), md + "\n");
  console.log(md);
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
