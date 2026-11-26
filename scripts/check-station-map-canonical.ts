// scripts/check-station-map-canonical.ts — station_map の ITANDI 列が、正本（chrome-extension/popup-maps.js の ITANDI_LINE_MAP_FILL）から
// リアプロの列で作った値と違う行を数える（読むだけ・書かない）。
// 2026-11-26 竹内さん「station_map を正本と比べる点検を仕組みにする」。
// 直した後の確かめ: npx tsx --env-file=.env.local scripts/check-station-map-canonical.ts [--json=out.json]
// ・レインズは2026-11-26から対象外（見ない）。
// ・営業時間（JST 9〜22時）の全件読みは避ける。この点検は頁（1000件ずつ）で読む。夜に回す。
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import vm from "vm";

// 正本の表を popup-maps.js から取り出す（ブラウザ用の js を、窓の無い箱の中で実行する）
const mapsSrc = readFileSync(join(__dirname, "..", "chrome-extension", "popup-maps.js"), "utf8");
const canon = vm.runInNewContext(mapsSrc + "\n;({ ITANDI_LINE_MAP_FILL })", { window: undefined }) as {
  ITANDI_LINE_MAP_FILL: Record<string, string | string[]>;
};
const FILL = canon.ITANDI_LINE_MAP_FILL;

function toItandi(realproLines: string[]): { lines: string[]; unmapped: string[] } {
  const out = new Set<string>();
  const unmapped: string[] = [];
  for (const rp of realproLines) {
    const v = FILL[rp];
    if (v === undefined) { unmapped.push(rp); continue; }
    for (const x of Array.isArray(v) ? v : [v]) out.add(x);
  }
  return { lines: [...out].sort(), unmapped };
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
type Row = { token: string; realpro_lines: string[] | null; itandi_lines: string[] | null; source: string | null };

(async () => {
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("station_map").select("token, realpro_lines, itandi_lines, source").order("token").range(from, from + 999);
    if (error) throw error;
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }

  type Diff = { token: string; source: string | null; realpro: string[]; itandi_now: string[]; itandi_canon: string[]; unmapped: string[] };
  const diffs: Diff[] = [];
  const pattern: Record<string, number> = {};
  let checked = 0;
  for (const r of rows) {
    const rp = Array.isArray(r.realpro_lines) ? r.realpro_lines : [];
    if (!rp.length) continue;
    checked++;
    const canonical = toItandi(rp);
    const now = (Array.isArray(r.itandi_lines) ? r.itandi_lines : []).slice().sort();
    const same = JSON.stringify(now) === JSON.stringify(canonical.lines);
    if (same && canonical.unmapped.length === 0) continue;
    diffs.push({ token: r.token, source: r.source, realpro: rp, itandi_now: now, itandi_canon: canonical.lines, unmapped: canonical.unmapped });
    for (const x of now.filter((v) => !canonical.lines.includes(v))) pattern[`DB にあり・正本に無い「${x}」`] = (pattern[`DB にあり・正本に無い「${x}」`] ?? 0) + 1;
    for (const x of canonical.lines.filter((v) => !now.includes(v))) pattern[`正本にあり・DB に無い「${x}」`] = (pattern[`正本にあり・DB に無い「${x}」`] ?? 0) + 1;
    for (const u of canonical.unmapped) pattern[`正本の表に無い路線「${u}」`] = (pattern[`正本の表に無い路線「${u}」`] ?? 0) + 1;
  }

  console.log(`station_map 行 ${rows.length} / リアプロ路線のある行 ${checked} / 正本とずれた行 ${diffs.length}`);
  for (const [k, n] of Object.entries(pattern).sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${n}\t${k}`);
  if (diffs.length === 0) console.log("  ✅ 正本と一致（ITANDI 列）");
  const out = process.argv.find((a) => a.startsWith("--json="))?.slice(7);
  if (out) writeFileSync(out, JSON.stringify(diffs, null, 1));
  if (diffs.length) process.exitCode = 1;
})().catch((e) => { console.error("失敗:", e.message); process.exit(1); });
