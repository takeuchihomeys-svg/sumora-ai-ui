/**
 * F64 根本原因→修正→実証完了まで回す関所
 *
 *   npx tsx --env-file=.env.local scripts/root-cause-improve-loop.ts
 *   npx tsx --env-file=.env.local scripts/root-cause-improve-loop.ts --plan-only
 *
 * 竹内さん「表面の改善ばかりで根本的でない／完了するまで試行／統括proと設計知見連携」
 * 完了線は app/lib/root-cause-improve-loop.ts の evaluateRootCauseImproveLoop。
 */
import { createClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROOT_CAUSE_CANON_CASES,
  ROOT_CAUSE_LOOP_STAMP_REL,
  evaluateRootCauseImproveLoop,
  type RootCauseCase,
  type RootCauseLoopStamp,
} from "../app/lib/root-cause-improve-loop";
import { auditExtTestImproveLoop } from "../app/lib/ext-test-improve-loop";

const args = process.argv.slice(2);
const planOnly = args.includes("--plan-only");
const root = process.cwd();

function codeExtVersion(): string {
  try {
    return String(
      JSON.parse(readFileSync(join(root, "chrome-extension", "manifest.json"), "utf8")).version || "",
    );
  } catch {
    return "";
  }
}

function stepKeys(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  const out: string[] = [];
  for (const s of steps) {
    if (typeof s === "string") {
      out.push(s.slice(0, 60));
      continue;
    }
    const k = String((s as { k?: string })?.k || "").trim();
    if (k) out.push(k.slice(0, 60));
  }
  return out;
}

async function loadLatestAudit(): Promise<{
  keys: string[];
  extVersion: string;
  id: string | null;
  nextMoveHint: string;
}> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  if (!url || !key) {
    return { keys: [], extVersion: "", id: null, nextMoveHint: "env無し" };
  }
  const sb = createClient(url, key);
  const { data, error } = await sb
    .from("search_audits")
    .select("id,steps,ext_version,created_at,mode")
    .eq("site", "realpro")
    .in("mode", ["brain_aix", "aix", "auto"])
    .order("created_at", { ascending: false })
    .limit(8);
  if (error || !data?.length) {
    return { keys: [], extVersion: "", id: null, nextMoveHint: error?.message || "監査0" };
  }
  const keys: string[] = [];
  let extVersion = "";
  let id: string | null = null;
  let nextMoveHint = "";
  for (const row of data) {
    if (!id) id = String(row.id);
    if (!extVersion && row.ext_version) extVersion = String(row.ext_version);
    const ks = stepKeys(row.steps);
    for (const k of ks) {
      if (!keys.includes(k)) keys.push(k);
      if (/next_move|並べ替え|premature/.test(k)) {
        const steps = Array.isArray(row.steps) ? row.steps : [];
        for (const s of steps) {
          const kk = typeof s === "string" ? s : String((s as { k?: string })?.k || "");
          const d = typeof s === "string" ? "" : String((s as { d?: string })?.d || "");
          if (/next_move|並べ替え|premature/.test(`${kk} ${d}`) && !nextMoveHint) {
            nextMoveHint = `${kk}:${d}`.slice(0, 120);
          }
        }
      }
    }
  }
  return { keys, extVersion, id, nextMoveHint: nextMoveHint || "next_move印なし" };
}

async function main() {
  console.log("────────────────────────────────────────");
  console.log("【F64】根本原因改善ループ");
  console.log(`  planOnly=${planOnly ? "yes" : "no"}`);

  const f58 = auditExtTestImproveLoop(root);
  const codeV = codeExtVersion();
  const audit = await loadLatestAudit();

  const cases: RootCauseCase[] = ROOT_CAUSE_CANON_CASES.map((c) => ({
    ...c,
    dbEvidence:
      audit.id
        ? `最新監査#${String(audit.id).slice(0, 8)} ver=${audit.extVersion || "-"} keys=${audit.keys.length} hint=${audit.nextMoveHint}`
        : "未測（監査が読めない）",
  }));

  const result = evaluateRootCauseImproveLoop({
    cases,
    extTestOk: !!f58.ok,
    latestAuditKeys: audit.keys,
    latestExtVersion: audit.extVersion || "",
    codeExtVersion: codeV,
  });

  console.log(`  F58: ${f58.ok ? "✓" : "✗"} ${f58.line}`);
  console.log(`  版: code=${codeV} latest_audit=${audit.extVersion || "-"}`);
  console.log(`  監査keys: ${audit.keys.length}  id=${audit.id || "-"}`);
  console.log(`  → ${result.line}`);
  if (result.gaps.length) {
    console.log("  gaps:");
    for (const g of result.gaps.slice(0, 8)) console.log(`    - ${g}`);
  }
  for (const c of result.cases) {
    console.log(`  case[${c.id}]: ${c.ok ? "✓" : "✗"} ${c.gaps.join("／") || "ok"}`);
  }
  console.log(`  next: ${result.next}`);

  if (planOnly) {
    process.exit(result.ok ? 0 : 2);
  }

  const stamp: RootCauseLoopStamp = {
    at: new Date().toISOString(),
    ok: result.ok,
    line: result.line,
    next: result.next,
    gaps: result.gaps,
    cases: result.cases,
    latest_ext_version: audit.extVersion || "",
    code_ext_version: codeV,
    ext_test_ok: !!f58.ok,
    audit_keys_n: audit.keys.length,
  };
  const stampPath = join(root, ROOT_CAUSE_LOOP_STAMP_REL);
  mkdirSync(join(root, "memory"), { recursive: true });
  writeFileSync(stampPath, JSON.stringify(stamp, null, 2), "utf8");
  console.log(`  stamp → ${ROOT_CAUSE_LOOP_STAMP_REL}`);
  if (!existsSync(stampPath)) {
    console.error("stamp write failed");
    process.exit(1);
  }
  process.exit(result.ok ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});