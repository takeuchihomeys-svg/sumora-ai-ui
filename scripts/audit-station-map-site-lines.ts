// scripts/audit-station-map-site-lines.ts — station_map の ITANDI/REINS の列が、リアプロの列から対応表で作った値と違う行を数える（読むだけ・書かない）
// 実行: npx tsx --env-file=.env.local scripts/audit-station-map-site-lines.ts [--json=out.json]
// 2026-11-10 作業員B（DB_STRUCTURE.md 混ざっている所 4）
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { mapRealproToItandi, mapRealproToReins } from "../app/lib/station-line-maps";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
type Row = { token: string; realpro_lines: string[] | null; itandi_lines: string[] | null; reins_line: string | null; source: string | null };
(async () => {
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("station_map").select("token, realpro_lines, itandi_lines, reins_line, source").order("token").range(from, from + 999);
    if (error) throw error;
    rows.push(...(data as Row[]));
    if (!data || data.length < 1000) break;
  }
  const diffs: Array<{ token: string; source: string | null; realpro: string[]; itandi_now: string[]; itandi_new: string[] | null; reins_now: string | null; reins_new: string | null; unmapped: string[] }> = [];
  const pairCount: Record<string, number> = {};
  for (const r of rows) {
    const rp = Array.isArray(r.realpro_lines) ? r.realpro_lines : [];
    if (!rp.length) continue;
    const it = mapRealproToItandi(rp);
    const itNew = it.unmapped.length ? null : it.lines;
    const reNew = mapRealproToReins(rp);
    const itNow = Array.isArray(r.itandi_lines) ? r.itandi_lines : [];
    const itDiff = itNew !== null && JSON.stringify([...itNow].sort()) !== JSON.stringify([...itNew].sort());
    const reDiff = reNew !== null && (r.reins_line ?? null) !== reNew;
    if (itDiff || reDiff || it.unmapped.length) {
      diffs.push({ token: r.token, source: r.source, realpro: rp, itandi_now: itNow, itandi_new: itDiff ? itNew : null, reins_now: r.reins_line, reins_new: reDiff ? reNew : null, unmapped: it.unmapped });
      if (itDiff) for (const x of itNow.filter((v) => !itNew!.includes(v))) { const k = `ITANDI 今「${x}」`; pairCount[k] = (pairCount[k] ?? 0) + 1; }
      if (itDiff) for (const x of itNew!.filter((v) => !itNow.includes(v))) { const k = `ITANDI 新「${x}」`; pairCount[k] = (pairCount[k] ?? 0) + 1; }
      if (reDiff) { const k = `REINS 「${r.reins_line}」→「${reNew}」`; pairCount[k] = (pairCount[k] ?? 0) + 1; }
      for (const u of it.unmapped) { const k = `表に無い「${u}」`; pairCount[k] = (pairCount[k] ?? 0) + 1; }
    }
  }
  console.log(`行 ${rows.length} / 違う行 ${diffs.length}（ITANDI ${diffs.filter((d) => d.itandi_new).length}・REINS ${diffs.filter((d) => d.reins_new).length}・表に無い路線を含む ${diffs.filter((d) => d.unmapped.length).length}）`);
  for (const [k, n] of Object.entries(pairCount).sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${k}`);
  const out = process.argv.find((a) => a.startsWith("--json="))?.slice(7);
  if (out) writeFileSync(out, JSON.stringify(diffs, null, 1));
})();
