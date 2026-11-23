// scripts/audit-exam-switch-reach.ts — 試験の組で、on にしたスイッチの材料が1問でも立ったかを出す（読むだけ・LLM なし・DB なし・費用0）
//
// 2026-11-23 作業員A（台帳 #648・統括役の決め）: 昨夜の ess-1122r-pickupwhy-p1/p2 は SIP_JUDGE が1度も効いていなかった（写しに画像の読み0行）のに
//   「試験で確かめた」事になっていた。結果ごとに、スイッチの印（brain.material_marks）と要る材料（ledger.inserted）を見て、
//   効いた／効いていない（印0・材料0）／確かめられない（印が入る前の版・指示文が全問に入る・対応表に無い）を出す。対応表は scripts/lib/exam-switch-reach.ts
// 実行: npx tsx scripts/audit-exam-switch-reach.ts --label=<label>[,<label>…] [--dir=scripts/brain-exam/results] [--json]
//   label は前方一致でもよい（--label=ess-1122r-pickupwhy- で p1・p2 の両方）。--switches=A,B で on のスイッチを手で渡せる（メタが無い時）
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { switchReachOf, onSwitchesOfMeta, REACH_JA, type ReachRow } from "./lib/exam-switch-reach";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const dir = arg("dir", "scripts/brain-exam/results");
const want = arg("label").split(",").map((s) => s.trim()).filter(Boolean);
if (!want.length) { console.error("使い方: --label=<label>[,<label>…]（前方一致可） [--dir=] [--json]"); process.exit(1); }
const files = existsSync(dir) ? readdirSync(dir) : [];
const labels = [...new Set(files.filter((f) => f.endsWith(".jsonl") && !f.includes(".base-merged")).map((f) => f.replace(/\.jsonl$/, "")).filter((l) => want.some((w) => l === w || l.startsWith(w))))].sort();
const headHasCache = new Map<string, boolean>();
const headHas = (head: string | null) => (commit: string) => {
  if (!head) return false;
  const k = `${commit}..${head}`;
  if (!headHasCache.has(k)) { try { execSync(`git merge-base --is-ancestor ${commit} ${head}`, { stdio: "ignore" }); headHasCache.set(k, true); } catch { headHasCache.set(k, false); } }
  return headHasCache.get(k)!;
};
const out: Array<Record<string, unknown>> = [];
for (const label of labels) {
  const metaPath = join(dir, `${label}.meta.json`);
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : null;
  const on = arg("switches") ? arg("switches").split(",").map((s) => s.trim()).filter(Boolean) : onSwitchesOfMeta(meta);
  const rows: ReachRow[] = readFileSync(join(dir, `${label}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => {
    const r = JSON.parse(l) as { id: string; brain?: { material_marks?: Record<string, number> | null } | null; ledger?: { inserted?: Record<string, number> } | null };
    return { id: r.id, marks: r.brain?.material_marks ?? null, ledger: r.ledger?.inserted ?? null, metaKeys: Object.entries((r.brain ?? {}) as Record<string, unknown>).filter(([, v]) => v != null && v !== "").map(([k]) => k) };
  });
  const reach = switchReachOf(on, rows, headHas(meta?.head ?? null));
  out.push({ label, head: meta?.head ?? null, problems: new Set(rows.map((r) => r.id)).size, reach });
  if (!process.argv.includes("--json")) {
    console.log(`■ ${label}（HEAD ${meta?.head ?? "?"}・問題 ${new Set(rows.map((r) => r.id)).size}・on ${on.join(",") || "なし"}）`);
    for (const x of reach) console.log(`  ${x.sw}: ${REACH_JA[x.status]}${x.hit.length ? `（${x.hit.join("・")}）` : ""}${x.withMaterial.length && x.withMaterial.length < x.problems ? `・材料のある問題 ${x.withMaterial.length}/${x.problems}` : ""}${x.note ? `・${x.note}` : ""}`);
    if (reach.some((x) => x.status === "no_material" || x.status === "not_reached")) console.log("  ⚠ この組の on と off の比べは、効いていないスイッチについては何も確かめていない");
  }
}
if (process.argv.includes("--json")) console.log(JSON.stringify(out));
if (!labels.length) console.log(`当たる結果が無い（${dir}・${want.join(",")}）`);
