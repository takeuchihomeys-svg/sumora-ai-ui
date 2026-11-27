// scripts/audit-switch-marks.ts — 既定 off のスイッチの「材料の印」の点検と、印を足す順番の一覧（台帳 #803・統括役の決め③）
// 2026-11-27 作業員L: app/lib の既定 off のスイッチのうち、印か要る材料の行（SWITCH_TARGET_MARK・SWITCH_REACH・SNAPSHOT_NEED）が無い物を出す。
//   --write-allowlist で今の物を許しの一覧（scripts/lib/switch-mark-allowlist.json）に書く（初回だけ・以後は足さない＝新しいスイッチはテストで止まる）。
//   --order（.env.local が要る・台帳 work_items を読む軽い読み）で、印の無いスイッチのうち off のまま試験の候補に並ぶ物を、値打ちの高い順（台帳の優先・段・古さ）に並べる。
// 実行: npx tsx scripts/audit-switch-marks.ts [--write-allowlist] ／ npx tsx --env-file=.env.local scripts/audit-switch-marks.ts --order [--top=20]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { offSwitchesInDir, markCoverage } from "./lib/switch-mark-coverage";
import { SWITCH_REACH } from "./lib/exam-switch-reach";
import { SNAPSHOT_NEED, SWITCH_TARGET_MARK } from "./lib/exam-snapshot-need";

export const ALLOWLIST_FILE = join(__dirname, "lib", "switch-mark-allowlist.json");
export function coveredSwitches(): Set<string> {
  const r = SWITCH_REACH as Record<string, { mark?: string; needs?: string[] }>;
  return new Set([...Object.keys(SWITCH_TARGET_MARK), ...Object.keys(SNAPSHOT_NEED), ...Object.entries(r).filter(([, v]) => v.mark || v.needs?.length).map(([k]) => k)]);
}
export function loadAllowlist(file = ALLOWLIST_FILE): Set<string> {
  try { return new Set((JSON.parse(readFileSync(file, "utf8")) as { switches?: string[] }).switches ?? []); } catch { return new Set(); }
}

if (require.main === module) (async () => {
  const off = offSwitchesInDir(join(__dirname, "..", "app", "lib"));
  const cov = markCoverage(off, coveredSwitches(), loadAllowlist());
  console.log(`既定 off のスイッチ ${off.length}: 印・要る材料あり ${cov.covered.length}・印なし（今ある物・警告）${cov.allowed.length}・印なし（新しい・止める）${cov.fresh.length}${cov.fresh.length ? `（${cov.fresh.slice(0, 10).join(",")}）` : ""}`);
  if (process.argv.includes("--write-allowlist")) {
    if (existsSync(ALLOWLIST_FILE)) { console.log("許しの一覧は既にある＝足さない（新しいスイッチには印を付ける決まり）"); }
    else { writeFileSync(ALLOWLIST_FILE, JSON.stringify({ note: "2026-11-27 作業員L: この時点で既定 off で印の無いスイッチ（警告だけ）。ここに足さない＝新しいスイッチは material_marks の印と SWITCH_TARGET_MARK を付ける（統括役の決め）", switches: [...cov.allowed, ...cov.fresh].sort() }, null, 1)); console.log(`書いた: ${ALLOWLIST_FILE}`); }
  }
  if (process.argv.includes("--order")) {
    const { createClient } = await import("@supabase/supabase-js");
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
    const no = new Set([...cov.allowed, ...cov.fresh]);
    const { data } = await sb.from("work_items").select("id, switch_name, stage, priority, title, updated_at").not("switch_name", "is", null).in("stage", ["built_off", "testing", "passed", "todo", "building"]).limit(2000);
    const STAGE_W: Record<string, number> = { passed: 0, testing: 1, built_off: 2, building: 3, todo: 4 };
    const rows = ((data ?? []) as Array<{ id: number; switch_name: string; stage: string; priority: number | null; title: string; updated_at: string }>).filter((r) => no.has(r.switch_name))
      .sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9) || (STAGE_W[a.stage] ?? 9) - (STAGE_W[b.stage] ?? 9) || a.updated_at.localeCompare(b.updated_at));
    const top = Number(process.argv.find((a) => a.startsWith("--top="))?.slice(6) ?? "20") || 20;
    console.log(`\n印を足す順番（印なし ${no.size} のうち off のまま台帳に並ぶ ${rows.length}・値打ち＝台帳の優先→段（passed・testing・built_off の順）→古い順）:`);
    for (const r of rows.slice(0, top)) console.log(`- #${r.id} p${r.priority ?? "-"} [${r.stage}] ${r.switch_name}: ${String(r.title).slice(0, 50)}`);
  }
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
