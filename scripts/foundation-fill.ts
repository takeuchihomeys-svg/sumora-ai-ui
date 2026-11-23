// scripts/foundation-fill.ts — 土台の埋まりの表（読むだけ・LLM なし・費用0・作業員N・2026-11-21・台帳の priority 0「土台の統括」）
//
// 竹内さん 11/21「土台足りていない部分あればちゃんといれていき、細部までもととのえていくようにする」。
//   check-foundation（土台の帳面の4列）＋ foundation-scene-grid（土台×場面）を1つの表にそろえ、欄ごとに 埋まり・正しさ・持ち主・次の一手 を出す（形は scripts/lib/foundation-fill.ts）。
//   --md      … memory/foundation_fill.md に表を書く
//   --write   … 埋まっていない欄を台帳（work_items・origin=found_gap）に持ち主つきで足す（題の頭で重ねない・新しい穴は自動で持ち主付け）
//   --json    … 表と数を JSON で
// 読む物: 設計知見の現行 P0〜P2（1回）・quality_daily の7日の metric・手元のファイル。9〜22時でも軽い読み。
// 実行: npx tsx --env-file=.env.local scripts/foundation-fill.ts [--md] [--write] [--json]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { checkFoundation } from "./check-foundation";
import { sceneGrid } from "./foundation-scene-grid";
import { foundationFillOf, fillTotalsOf, foundationLeavesOf, FILL_COL_JA, SITUATION_CANDIDATES, type FillRow } from "./lib/foundation-fill";
import { LINKAGE_SWITCH_DEFAULTS } from "../app/lib/linkage-switch-defaults";
import { KB_SCENES } from "../app/lib/design-knowledge-rag";

export const FOUNDATION_FILL_MD = "C:/Users/竹内 悠馬/sumora-ai-ui/memory/foundation_fill.md";
const sceneJa = (s: string) => (KB_SCENES as Record<string, { tag: string }>)[s]?.tag.replace("場面:", "") ?? s;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function foundationFill(sb: any) {
  const cf = await checkFoundation();
  const grid = await sceneGrid(sb).catch(() => null);
  const seen = new Set(cf.metricsSeen);
  const fill = foundationFillOf(cf.rows, cf.gaps, grid, {
    metricSeen: (m) => seen.has(m),
    switchDefault: (s) => { const d = LINKAGE_SWITCH_DEFAULTS[s]; return d && d !== "なし" && d !== "?" ? d : null; },
  });
  // 葉（作業員P の #610 の木とつなぐ・found:<土台id>:<場面>:<欄>）
  return { fill, totals: fillTotalsOf(fill, grid), grid, tables: cf.tables, leaves: foundationLeavesOf(fill, grid?.scenes ?? []) };
}

const mark = (filled: boolean, correct: boolean | null) => (!filled ? "✗" : correct === true ? "✓正" : correct === false ? "✓誤" : "✓?");

export function fillMarkdown(r: Awaited<ReturnType<typeof foundationFill>>, nowIso: string): string {
  const { fill, totals } = r;
  const L: string[] = [];
  L.push(`# 土台の埋まり（${nowIso.slice(0, 16)}Z・scripts/foundation-fill.ts が書く・手で直さない）`, "",
    `- 表: ${r.tables.join("・")}・土台 ${totals.n}・欄が全部そろった ${totals.full}`,
    `- 場面の決まりの空き（場面ごとの決まりの無い欄）${totals.sceneGap}/${totals.sceneCells}・うち全場面の決まりも無い欄 ${totals.sceneStrict}`,
    `- 物差しの無い土台 ${totals.noMeasure}（${totals.noMeasureNames.join("・") || "—"}）`,
    `- 正しさ（測れた欄のうち正しい）${totals.correctRate ?? "—"}%（測れた欄 ${totals.correctMeasured}）`,
    "- 印: ✗ 無い／✓正 埋まって中身も正しい／✓誤 埋まっているが正しくない／✓? 埋まっているが正しさは未測定", "",
    `| 土台 | 持ち主 | 細かさの段 | 正しさ | ${(["rules", "measures", "metric", "parts", "scene_rules", "scene_measure"] as const).map((c) => FILL_COL_JA[c]).join(" | ")} | 次の一手（最初の欄） |`,
    `|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const f of fill) {
    const c = (col: string) => { const x = f.cells.find((y) => y.col === col); return x ? mark(x.filled, x.correct) : "—"; };
    const nx = f.cells.find((x) => !x.filled) ?? f.cells.find((x) => x.correct === false) ?? f.cells.find((x) => x.next);
    L.push(`| ${f.name} | ${f.owner} | ${f.depth} | ${f.correctOk}/${f.correctMeasured} | ${c("rules")} | ${c("measures")} | ${c("metric")} | ${c("parts")} | ${c("scene_rules")} | ${c("scene_measure")} | ${nx ? `${FILL_COL_JA[nx.col]}: ${nx.next ?? "—"}（${nx.owner}）` : "—"} |`);
  }
  L.push("", "## 欄ごとの次の一手（埋まっていない・正しくない欄）");
  for (const f of fill) for (const x of f.cells) if (!x.filled || x.correct === false) L.push(`- ${f.name}｜${FILL_COL_JA[x.col]}｜${x.owner}｜${x.next ?? "—"}｜${x.detail.slice(0, 90)}`);
  L.push("", "## 場面の決まりの無い場面（土台8つ）");
  for (const f of fill) if (f.emptyScenes.length) L.push(`- ${f.name}（${f.cells[0].owner}）: ${f.emptyScenes.map(sceneJa).join("・")}`);
  L.push("", "## 状況で分ける候補（未確認・竹内さんの実送信で形が割れる所まで分ける。割れない所は分けない）");
  for (const [s, xs] of Object.entries(SITUATION_CANDIDATES)) L.push(`- ${sceneJa(s)}: ${xs.join("／")}`);
  L.push("", "## 正しさの測り方", "- 決まり: 竹内さんの実送信の何%が守っているか（守り率の台本は未作成＝今は全部 ✓?）", "- 物差し: 本番の数が7日に quality_daily へ出ているか", "- 本番の数字: 7日に入っているか", "- 部品: コードの既定が on か（連携の地図に無いスイッチは未測定）", "");
  return L.join("\n");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function addFillGaps(sb: any, fill: FillRow[]): Promise<number> {
  const { data: open } = await sb.from("work_items").select("title").eq("origin", "found_gap").not("stage", "in", "(done,dropped)").limit(3000);
  const have = ((open ?? []) as Array<{ title: string }>).map((r) => r.title);
  // 題の頭（scene-grid の題と同じ頭も）で重ねない
  const headOf = (f: FillRow, col: string) => col === "scene_rules" ? `土台「${f.name}」の場面ごとの決まりが無い` : col === "scene_measure" ? `土台「${f.name}」の物差しが` : `土台「${f.name}」の${FILL_COL_JA[col as keyof typeof FILL_COL_JA]}が無い`;
  let added = 0;
  for (const f of fill) for (const x of f.cells) {
    if (x.filled) continue;
    const head = headOf(f, x.col);
    if (have.some((t) => t.startsWith(head))) continue;
    const title = x.col === "scene_rules" ? `${head}（${f.emptyScenes.map(sceneJa).join("・")}）` : x.col === "scene_measure" ? `${head}${x.detail === "無い" ? "無い" : "場面で分かれていない（全体だけ）"}` : head;
    const { data: ins } = await sb.from("work_items").insert({ title, origin: "found_gap", stage: "todo", area: "土台", owner: x.owner, priority: 10, next_step: `土台の埋まりの表（foundation-fill）で見つけた・${x.next ?? ""}` }).select("id").single();
    if (ins) { added++; have.push(title); await sb.from("work_item_events").insert({ item_id: (ins as { id: number }).id, to_stage: "todo", actor: "foundation-fill", kind: "assign", note: `持ち主 ${x.owner}・土台の統括の子` }); }
  }
  return added;
}

if (process.argv[1]?.endsWith("foundation-fill.ts")) (async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const r = await foundationFill(sb);
  if (process.argv.includes("--json")) { console.log(JSON.stringify({ totals: r.totals, fill: r.fill, leaves: r.leaves })); return; }
  const md = fillMarkdown(r, new Date().toISOString());
  if (process.argv.includes("--md")) writeFileSync(FOUNDATION_FILL_MD, md);
  console.log(md);
  if (process.argv.includes("--write")) console.log(`台帳に足した ${await addFillGaps(sb, r.fill)}行`);
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
