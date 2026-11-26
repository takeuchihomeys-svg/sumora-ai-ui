// scripts/apply-station-map-site-lines.ts — station_map の ITANDI・REINS の列を、リアプロの列から対応表で作った値に合わせる（2026-11-26）
//
// 既定は dry-run（何も書かない）。書くのは竹内さんの OK の後だけ:
//   npx tsx --env-file=.env.local scripts/apply-station-map-site-lines.ts --mode=fill
//   npx tsx --env-file=.env.local scripts/apply-station-map-site-lines.ts --mode=fill --apply --backup-dir=C:\Users\Admin\Desktop\station-map-backup-2026-11-26
//
// --mode=fill          … 空の列だけ埋める（今ある値は触らない）。最も安全。
// --mode=fill-and-fix  … 空を埋め＋今ある値がずれている物も対応表の値に直す（上書き・控えが必要）。
// --backup-dir=<場所>  … --apply の時は必須。変える前の行（token・itandi_lines・reins_line）を JSON で残す（リポジトリの外）。
// 表に無い路線（unmapped）の行は、ITANDI の列を作らない（今の値のまま）。
// 営業時間（JST 9〜22時）の全件読みを避けるため、書く時は 22時以降にする（CLAUDE.md の決まり）。
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { mapRealproToItandi, mapRealproToReins } from "../app/lib/station-line-maps";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const modeArg = argv.find((a) => a.startsWith("--mode="))?.slice(7) ?? "fill";
if (modeArg !== "fill" && modeArg !== "fill-and-fix") { console.error("--mode は fill か fill-and-fix"); process.exit(1); }
const mode = modeArg as "fill" | "fill-and-fix";
const backupDir = argv.find((a) => a.startsWith("--backup-dir="))?.slice(13) ?? "";
if (apply && !backupDir) { console.error("--apply には --backup-dir=<リポジトリの外の場所> が要ります（変える前の行の控え）"); process.exit(1); }

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
type Row = { token: string; realpro_lines: string[] | null; itandi_lines: string[] | null; reins_line: string | null };
type Change = { token: string; before: { itandi_lines: string[] | null; reins_line: string | null }; set: { itandi_lines?: string[]; reins_line?: string }; kind: string[] };

(async () => {
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("station_map").select("token, realpro_lines, itandi_lines, reins_line").order("token").range(from, from + 999);
    if (error) throw error;
    rows.push(...(data as Row[]));
    if (!data || data.length < 1000) break;
  }

  const changes: Change[] = [];
  for (const r of rows) {
    const rp = Array.isArray(r.realpro_lines) ? r.realpro_lines : [];
    if (!rp.length) continue;
    const it = mapRealproToItandi(rp);
    const itNew = it.unmapped.length ? null : it.lines;
    const reNew = mapRealproToReins(rp);
    const itNow = Array.isArray(r.itandi_lines) ? r.itandi_lines : [];
    const set: Change["set"] = {};
    const kind: string[] = [];
    if (itNew !== null && JSON.stringify([...itNow].sort()) !== JSON.stringify([...itNew].sort())) {
      if (itNow.length === 0) { set.itandi_lines = itNew; kind.push("itandi:空を埋める"); }
      else if (mode === "fill-and-fix") { set.itandi_lines = itNew; kind.push("itandi:ずれを直す"); }
    }
    if (reNew !== null && (r.reins_line ?? null) !== reNew) {
      if (!r.reins_line) { set.reins_line = reNew; kind.push("reins:空を埋める"); }
      else if (mode === "fill-and-fix") { set.reins_line = reNew; kind.push("reins:ずれを直す"); }
    }
    if (kind.length) changes.push({ token: r.token, before: { itandi_lines: r.itandi_lines, reins_line: r.reins_line }, set, kind });
  }

  const tally: Record<string, number> = {};
  for (const c of changes) for (const k of c.kind) tally[k] = (tally[k] ?? 0) + 1;
  console.log(`■ mode=${mode}・対象 ${changes.length} 行（全 ${rows.length} 行）`);
  for (const [k, n] of Object.entries(tally).sort()) console.log(`  ${n}\t${k}`);
  for (const c of changes.slice(0, 5)) console.log("  例: " + c.token + " " + c.kind.join(" / "));

  if (!apply) { console.log("（dry-run: 何も書いていません。--apply --backup-dir=<場所> で書きます）"); return; }

  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFile = path.join(backupDir, `station_map_before_${mode}_${stamp}.json`);
  writeFileSync(backupFile, JSON.stringify(changes.map((c) => ({ token: c.token, before: c.before, kind: c.kind })), null, 1));
  console.log("控えを書きました: " + backupFile);

  let done = 0;
  for (const c of changes) {
    const { error } = await db.from("station_map").update(c.set).eq("token", c.token);
    if (error) { console.error("失敗（ここで止める）: " + c.token + " " + error.message); process.exit(1); }
    done++;
  }
  console.log(`書きました: ${done} 行（戻す時は控え ${backupFile} の before を各 token に書き戻す）`);
})().catch((e) => { console.error(e); process.exit(1); });
