// scripts/plan-week-combo.ts — 台帳 #799 ⑤: その週に on にした直しを全部 on にした組を、係の候補の形（組・効く・守り）で作る（読むだけ・LLM なし・試験は積まない）
// 2026-11-26 作業員L（統括役の頼み）: 週1回。直しの効く問題は、係の候補（memory/night_bundle_candidates.md の 組: の塊）と係の結果（exam-queue/results の only・guards）から。
//   比べる前は、その週の最初の on より前の origin/main（git rev-list）。費用は晩の上限 $10 の内の見込み。流す晩の案は 11/30 以降の日曜（A の3晩の計画の後）。
//   --write=<候補の md> で、その塊を候補の最後に足す（同じ組の名前の塊が既にあれば足さない）。計算は scripts/lib/week-combo.ts
// 実行: npx tsx --env-file=.env.local scripts/plan-week-combo.ts [--days=7] [--candidates=../../../memory/night_bundle_candidates.md] [--not-before=2026-11-30] [--write=<md>]
import { createClient } from "@supabase/supabase-js";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { examCacheRoot } from "./lib/llm-cassette";
import { parseCandidateBlocks } from "./lib/exam-worth";
import { weekComboOf, type WeekFix } from "./lib/week-combo";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
/** 係の結果からスイッチごとの問題（守りは外す・新しい順） */
export function resultProblemsOf(dir: string, sw: string): { eff: string[]; guards: string[] } {
  const eff: string[] = [], guards: string[] = [];
  if (!existsSync(dir)) return { eff, guards };
  const rows: Array<{ at: string; only: string[]; guards: string[] }> = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f.endsWith(".reps.json")) continue;
    try {
      const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as { switch?: string; only?: string; guards?: string[]; at?: string };
      if (!j.switch || !String(j.switch).split(/[（(,、\s]/).includes(sw) || !j.only) continue;
      rows.push({ at: String(j.at ?? ""), only: String(j.only).split(",").filter(Boolean), guards: j.guards ?? [] });
    } catch { /* 壊れたファイルは飛ばす */ }
  }
  for (const r of rows.sort((a, b) => b.at.localeCompare(a.at))) {
    for (const id of r.only) if (!r.guards.includes(id) && !eff.includes(id)) eff.push(id);
    for (const g of r.guards) if (!guards.includes(g)) guards.push(g);
  }
  return { eff, guards };
}

if (require.main === module) (async () => {
  // 週1回: --weekly の時は JST の土曜だけ（晩の費用0の仕事が毎晩呼ぶ・日曜の晩の組の前の日に候補を作る）
  if (process.argv.includes("--weekly") && new Date(Date.now() + 9 * 3_600_000).getUTCDay() !== 6) { console.log("週の全部 on の組: 土曜だけ作る（今日は作らない）"); return; }
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const days = Number(arg("days", "7")) || 7;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  const { data: ev, error } = await sb.from("work_item_events").select("item_id, at").eq("to_stage", "on").gte("at", since).order("at").limit(500);
  if (error) throw new Error(error.message);
  const ids = [...new Set((ev ?? []).map((r) => Number(r.item_id)))];
  const { data: its } = ids.length ? await sb.from("work_items").select("id, switch_name").in("id", ids) : { data: [] };
  const swOf = new Map((its ?? []).map((r) => [Number(r.id), String(r.switch_name ?? "")]));
  const candPath = arg("candidates", "../../../memory/night_bundle_candidates.md");
  const blocks = existsSync(candPath) ? parseCandidateBlocks(readFileSync(candPath, "utf8").split("\n")) : [];
  const RES = join(examCacheRoot(), "exam-queue", "results");
  const fixes: WeekFix[] = [];
  for (const r of ev ?? []) {
    const sw = swOf.get(Number(r.item_id)) ?? ""; if (!sw || fixes.some((f) => f.switchName === sw)) continue;
    const bs = blocks.filter((b) => b.switches.includes(sw));
    const rp = resultProblemsOf(RES, sw);
    const eff = [...new Set([...bs.flatMap((b) => b.eff), ...rp.eff])];
    const guards = [...new Set([...bs.flatMap((b) => b.guards), ...rp.guards])].filter((g) => !eff.includes(g));
    fixes.push({ switchName: sw, itemId: Number(r.item_id), onAt: String(r.at), eff, guards });
  }
  const first = fixes.map((f) => f.onAt).sort()[0];
  const baseRef = first ? (() => { try { return execFileSync("git", ["rev-list", "-1", `--before=${first}`, "origin/main"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().slice(0, 9) || null; } catch { return null; } })() : null;
  console.log(`その週（${days}日）に on にした直し: ${fixes.length}本（スイッチのある物）${fixes.map((f) => `\n- #${f.itemId} ${f.switchName}: 効く ${f.eff.length}・守り ${f.guards.length}`).join("")}`);
  const c = weekComboOf(fixes, { day: today, baseRef, notBefore: arg("not-before", "2026-11-30") });
  if (!c) { console.log("組を作らない（スイッチのある直しが2本未満）"); return; }
  console.log(`\n${c.block}`);
  const w = arg("write", "");
  if (w) {
    const cur = existsSync(w) ? readFileSync(w, "utf8") : "";
    if (cur.includes(`組: ${c.name} `)) console.log(`\n候補に同じ組（${c.name}）がある＝足さない`);
    else { appendFileSync(w, `\n${c.block}\n`); console.log(`\n候補に足した: ${w}`); }
  }
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
