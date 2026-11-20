// scripts/scrub-bundle-names.ts — 過去の学習の束（human_learn_profile.bundle）からお客様の名前を外す（2026-11-20）
//
// 竹内さん「入力内容として外す」「全部今から行う」。
//   既定は --dry-run（件数と段階名だけを出す。名前そのものは出さない・書かない）。
//   --apply で、名前が残っている行だけを書き換える。書き換える前に**元の束を控えフォルダへ保存**する（戻し用）。
//   ⚠ 1行ずつ読む・1行ずつ書く（小分け・営業時間内でも重くしない）。
//   ⚠ 控えには元の名前が入る。控えはリポジトリの外（--backup-dir）に置く。コミットしない。
//
// 実行:
//   npx tsx --env-file=.env.local scripts/scrub-bundle-names.ts                       （確かめるだけ）
//   npx tsx --env-file=.env.local scripts/scrub-bundle-names.ts --apply --backup-dir=<控えの場所>
//   戻す: 控えの <id>.json を bundle として PATCH（scripts/scrub-bundle-names.ts --restore=<控えの場所>）

import * as fs from "fs";
import * as path from "path";
import { stripCustomerNames } from "../app/lib/bundle-privacy";

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const backupDir = (args.find((a) => a.startsWith("--backup-dir="))?.slice(13)) ?? "";
const restoreDir = args.find((a) => a.startsWith("--restore="))?.slice(10);
const PAGE = 10;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

const NAME_RE = /今の客:[A-Za-z_]+ [^"\\]+/g;

async function fetchPage(offset: number) {
  const r = await fetch(`${URL_}/rest/v1/human_learn_profile?select=id,scope,created_at,bundle&order=created_at.asc&limit=${PAGE}&offset=${offset}`, { headers: H, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`読めません（${r.status}）offset=${offset}`);
  return (await r.json()) as Array<{ id: number; scope: string; created_at: string; bundle: unknown }>;
}

async function main() {
  if (!URL_ || !KEY) { console.error("環境変数が足りません（NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）"); process.exit(1); }

  // 控えの場所は、リポジトリの外かを確かめる
  if (apply) {
    if (!backupDir) { console.error("--apply には --backup-dir=<リポジトリの外の場所> が要ります"); process.exit(1); }
    if (path.resolve(backupDir).toLowerCase().startsWith(path.resolve(process.cwd()).toLowerCase())) {
      console.error("控えはリポジトリの中に置けません（個人の名前が入るため）"); process.exit(1);
    }
    fs.mkdirSync(backupDir, { recursive: true });
  }

  // ── 元に戻す（控えから bundle を書き戻す）
  if (restoreDir) {
    const files = fs.readdirSync(restoreDir).filter((f) => f.endsWith(".json"));
    let n = 0;
    for (const f of files) {
      const id = Number(f.replace(".json", ""));
      const bundle = JSON.parse(fs.readFileSync(path.join(restoreDir, f), "utf8"));
      const r = await fetch(`${URL_}/rest/v1/human_learn_profile?id=eq.${id}`, { method: "PATCH", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify({ bundle }) });
      if (!r.ok) throw new Error(`戻せません id=${id} (${r.status})`);
      n++;
    }
    console.log(`戻しました: ${n}行（控え: ${restoreDir}）`);
    return;
  }

  let scanned = 0;
  const targets: Array<{ id: number; scope: string; created_at: string; names: number; phases: Record<string, number>; cleaned: unknown }> = [];
  for (let off = 0; ; off += PAGE) {
    const rows = await fetchPage(off);
    if (!rows.length) break;
    for (const row of rows) {
      scanned++;
      const s = JSON.stringify(row.bundle);
      const hits = s.match(NAME_RE) || [];
      if (!hits.length) continue;
      const phases: Record<string, number> = {};
      for (const h of hits) { const p = h.split(" ")[0]; phases[p] = (phases[p] || 0) + 1; }
      const cleaned = stripCustomerNames(row.bundle as Record<string, unknown>);
      targets.push({ id: row.id, scope: row.scope, created_at: row.created_at, names: hits.length, phases, cleaned: cleaned.value });
    }
  }

  const totalHits = targets.reduce((a, t) => a + t.names, 0);
  console.log(`■ 確かめた行: ${scanned}行`);
  console.log(`■ 名前が残っている行: ${targets.length}行（名前の出どころ: ${totalHits}か所・名前そのものは表示しない）`);
  const byScope: Record<string, number> = {};
  for (const t of targets) byScope[t.scope] = (byScope[t.scope] || 0) + 1;
  console.log(`  scope 別: ${JSON.stringify(byScope)}`);
  const phaseAll: Record<string, number> = {};
  for (const t of targets) for (const [p, n] of Object.entries(t.phases)) phaseAll[p] = (phaseAll[p] || 0) + n;
  console.log(`  段階名（名前の前の部分）別: ${JSON.stringify(phaseAll)}`);
  if (!apply) { console.log("（--dry-run: 何も書いていません。--apply --backup-dir=<場所> で書き換えます）"); return; }

  let done = 0;
  for (const t of targets) {
    // 控え（元の束・名前入り）を先に保存
    const orig = await fetch(`${URL_}/rest/v1/human_learn_profile?select=bundle&id=eq.${t.id}`, { headers: H });
    const [o] = (await orig.json()) as Array<{ bundle: unknown }>;
    fs.writeFileSync(path.join(backupDir, `${t.id}.json`), JSON.stringify(o.bundle));
    const r = await fetch(`${URL_}/rest/v1/human_learn_profile?id=eq.${t.id}`, { method: "PATCH", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify({ bundle: t.cleaned }) });
    if (!r.ok) throw new Error(`書けません id=${t.id} (${r.status})`);
    done++;
  }
  console.log(`書き換えました: ${done}行（控え: ${backupDir}）`);

  // 確かめ直し: 残っていないか
  let left = 0;
  for (let off = 0; ; off += PAGE) {
    const rows = await fetchPage(off);
    if (!rows.length) break;
    for (const row of rows) if ((JSON.stringify(row.bundle).match(NAME_RE) || []).length) left++;
  }
  console.log(`確かめ直し: 名前が残っている行 ${left}行`);
}

main().catch((e) => { console.error("失敗:", e instanceof Error ? e.message : String(e)); process.exit(1); });
