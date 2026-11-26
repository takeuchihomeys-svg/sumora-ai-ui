// scripts/playbook-gap-audit.ts — 手順書の「抜け」を読むだけで洗い出す（2026-11-27）
//
// 竹内さん「ちゃんと手順書ぬけのないように」「抜けのない仕組みもちゃんと作って強化する」。
// この script は書き込まない。やること:
//   ① DB の最新の束（scope ごと1行・GET のみ）を読む
//   ② 今のコード（buildPlaybook）で手順書を作り直し、その gaps（抜けの一覧）を出す（束は触らない）
//   ③ 束に入っている手順書（保存済み）の gaps と版（build_v・rules_v）を並べる
//   ④ 拡張のコードと決まりの一覧（checkRulesInCode）を、手元のファイルで突き合わせる
//
// 実行:
//   npx tsx --env-file=.env.local scripts/playbook-gap-audit.ts                 （both: realpro / itandi）
//   npx tsx --env-file=.env.local scripts/playbook-gap-audit.ts --json=<控えの場所>  （結果をJSONで書く・リポジトリの外）
// ⚠ 名前（今の客:…）は出さない。出るのは欄名と場面の名前だけ。
// ⚠ 営業時間（JST 9〜22時）でも安全: 1行ずつ・1scopeずつ GET（全件読みはしない）。

import * as fs from "fs";
import * as path from "path";
import { buildPlaybook, checkPlaybook, PLAYBOOK_BUILD_V } from "../app/lib/action-playbook";
import { AUTO_RULES, AUTO_RULES_REVIEWED_UP_TO, checkRulesInCode } from "../app/lib/auto-procedure-rules";
import { gapKey, diffGaps, type GapBaseline } from "../app/lib/playbook-gap-baseline";

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const SITES = ["realpro", "itandi"] as const;

type Row = { id: number; scope: string; created_at: string; bundle: Record<string, unknown> };

export type GapReport = {
  site: string;
  row_id: number | null;
  row_at: string | null;
  stored: { build_v: number | null; rules_v: string | null; gaps: string[] } | null;
  fresh: { build_v: number; rules_v: string; gaps: string[]; problems: string[] } | null;
  note: string;
};

async function latest(scope: string): Promise<Row | null> {
  const r = await fetch(`${URL_}/rest/v1/human_learn_profile?select=id,scope,created_at,bundle&scope=eq.${scope}&order=created_at.desc&limit=1`, { headers: H, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`読めません scope=${scope} (${r.status})`);
  const [row] = (await r.json()) as Row[];
  return row ?? null;
}

/** 1つの束から抜けの報告を作る（純関数に近い: 束は clone して使う） */
export function gapReportFor(site: string, row: Row | null): GapReport {
  if (!row) return { site, row_id: null, row_at: null, stored: null, fresh: null, note: "束の行が無い" };
  const bundle = row.bundle ?? {};
  const storedPb = (bundle as { playbook?: { build_v?: number; rules_v?: string; gaps?: string[] } }).playbook;
  const stored = storedPb
    ? { build_v: storedPb.build_v ?? null, rules_v: storedPb.rules_v ?? null, gaps: Array.isArray(storedPb.gaps) ? storedPb.gaps : [] }
    : null;
  let fresh: GapReport["fresh"] = null;
  try {
    const clone = JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>;
    const pb = buildPlaybook(clone as never, site);
    fresh = { build_v: PLAYBOOK_BUILD_V, rules_v: String(pb.rules_v ?? ""), gaps: pb.gaps ?? [], problems: checkPlaybook(pb) };
  } catch (e) {
    fresh = { build_v: PLAYBOOK_BUILD_V, rules_v: "", gaps: [], problems: [`作り直しに失敗: ${e instanceof Error ? e.message : String(e)}`] };
  }
  return { site, row_id: row.id, row_at: row.created_at, stored, fresh, note: "" };
}

/** 拡張のファイルと決まりの一覧の食い違い（手元のファイル・GET なし） */
export function ruleIssuesFromRepo(root: string): string[] {
  const ext = path.join(root, "chrome-extension");
  const read = (f: string) => { try { return fs.readFileSync(path.join(ext, f), "utf8"); } catch { return ""; } };
  return checkRulesInCode({
    pageScript: read("page-script.js"),
    searchAudit: read("search-audit.js"),
    manifestJson: read("manifest.json"),
    bulkDl: read("bulk-dl.js"),
    background: read("background.js"),
  }, AUTO_RULES);
}

async function main() {
  if (!URL_ || !KEY) { console.error("環境変数が足りません（NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）"); process.exit(1); }
  const reports: GapReport[] = [];
  for (const site of SITES) {
    const row = await latest(site);
    reports.push(gapReportFor(site, row));
  }
  const root = process.cwd();
  const ruleIssues = ruleIssuesFromRepo(root);

  for (const r of reports) {
    console.log(`■ ${r.site}: 行 ${r.row_id ?? "-"} ${r.row_at ?? ""}`);
    if (r.note) { console.log(`  ${r.note}`); continue; }
    if (r.stored) console.log(`  保存済みの手順書: build_v=${r.stored.build_v ?? "?"} rules_v=${r.stored.rules_v ?? "?"} 抜け=${r.stored.gaps.length}件`);
    else console.log("  保存済みの手順書: なし");
    if (r.fresh) {
      console.log(`  今のコードで作り直し: build_v=${r.fresh.build_v} rules_v=${r.fresh.rules_v} 抜け=${r.fresh.gaps.length}件 問題=${r.fresh.problems.length}件`);
      for (const g of r.fresh.gaps) console.log(`    ・${g}`);
      for (const p of r.fresh.problems) console.log(`    ✗ ${p}`);
    }
  }
  console.log(`■ 拡張と決まりの一覧（手元）: 見直し上限=${AUTO_RULES_REVIEWED_UP_TO}・決まり ${AUTO_RULES.length}件`);
  if (!ruleIssues.length) console.log("  ✅ 食い違い無し");
  for (const i of ruleIssues) console.log(`  ✗ ${i}`);

  // 基準（受け入れた抜け）と比べる。増えた抜けは止める（--check）。基準を書き換えるのは --write-baseline だけ（竹内さんの確認つき）
  const baselineFile = path.join(root, "memory", "playbook_gaps_baseline.json");
  const siteKeys = (r: GapReport) => (r.fresh?.gaps ?? []).map((g) => g);
  if (process.argv.includes("--write-baseline")) {
    const base: GapBaseline = {
      at: new Date().toISOString(),
      note: "受け入れた手順書の抜け（gapKey の型）。増えたら --check が止める。直したら --check で「直った」と出る。基準を書き換えるのは竹内さんの確認のあとだけ。",
      sites: Object.fromEntries(reports.filter((r) => r.fresh).map((r) => [r.site, [...new Set(siteKeys(r).map(gapKey))]])),
    };
    fs.writeFileSync(baselineFile, JSON.stringify(base, null, 2) + "\n");
    console.log(`基準を書きました: ${path.relative(root, baselineFile)}`);
  }
  let added = 0;
  if (process.argv.includes("--check") || process.argv.includes("--write-baseline")) {
    let base: GapBaseline | null = null;
    try { base = JSON.parse(fs.readFileSync(baselineFile, "utf8")) as GapBaseline; } catch { base = null; }
    if (!base) { console.log("✗ 基準ファイルが読めない（--write-baseline で作る）"); added++; }
    else {
      for (const r of reports) {
        if (!r.fresh) continue;
        const d = diffGaps(siteKeys(r), base.sites?.[r.site] ?? []);
        console.log(`■ 抜けの基準（${r.site}）: 受け入れ済み ${d.kept}件・新しい抜け ${d.added.length}件・直った ${d.removed.length}件`);
        for (const t of d.added) console.log(`  ❌ 新しい抜け: ${t}`);
        for (const k of d.removed) console.log(`  ✅ 直った（基準から外す）: ${k}`);
        added += d.added.length;
      }
    }
    console.log(added ? `❌ 新しい抜けが ${added}件（直すか、理由を書いて基準に加える＝竹内さんの確認）` : "✅ 新しい抜けは無い");
  }

  const jsonDir = process.argv.find((a) => a.startsWith("--json="))?.slice(7);
  if (jsonDir) {
    if (path.resolve(jsonDir).toLowerCase().startsWith(path.resolve(root).toLowerCase())) {
      console.error("控えはリポジトリの中に置けません（名前の欄名が入る可能性）"); process.exit(1);
    }
    fs.mkdirSync(jsonDir, { recursive: true });
    fs.writeFileSync(path.join(jsonDir, `playbook-gap-audit-${Date.now()}.json`), JSON.stringify({ at: new Date().toISOString(), reports, rule_issues: ruleIssues }, null, 2));
    console.log(`書きました（控え: ${jsonDir}）`);
  }
  if (added) process.exitCode = 1;
}

if (process.argv[1] && /playbook-gap-audit\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error("失敗:", e instanceof Error ? e.message : String(e)); process.exit(1); });
}
