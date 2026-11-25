/**
 * F58 拡張テスト→抜け→改善ループ
 *
 *   npx tsx scripts/ext-test-improve-loop.ts
 *   npx tsx scripts/ext-test-improve-loop.ts --fix     … 無料の配線抜けを直してから再テスト
 *   npx tsx scripts/ext-test-improve-loop.ts --scan-only … 配線抜けだけ（テストは回さない）
 *
 * 竹内さん「改善したらテストちゃんと行って、改善するところ見つかれば改善する仕組み」
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXT_TEST_IMPROVE_SUITE,
  applyFreeExtWiringFixes,
  evaluateExtTestLoop,
  scanExtWiringFindings,
  writeExtTestLoopStamp,
  type ExtTestRunItem,
} from "../app/lib/ext-test-improve-loop";

const args = process.argv.slice(2);
const doFix = args.includes("--fix");
const scanOnly = args.includes("--scan-only");
const root = process.cwd();

function manifestVer(): string {
  try {
    return String(
      JSON.parse(readFileSync(join(root, "chrome-extension", "manifest.json"), "utf8")).version || "",
    );
  } catch {
    return "";
  }
}

/** --fix 後はモジュール定数が古いままなのでファイルから読む */
function rulesReviewedFromDisk(): string {
  try {
    const src = readFileSync(join(root, "app", "lib", "auto-procedure-rules.ts"), "utf8");
    const m = src.match(/export const AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

function runOne(pathRel: string): ExtTestRunItem {
  const id =
    EXT_TEST_IMPROVE_SUITE.find((t) => t.path === pathRel)?.id ||
    pathRel.split("/").pop()?.replace(/\.(test\.)?(js|ts)$/, "") ||
    pathRel;
  const abs = join(root, pathRel);
  if (!existsSync(abs)) {
    return { id, path: pathRel, ok: false, ms: 0, detail: "file missing" };
  }
  const t0 = Date.now();
  const isTs = pathRel.endsWith(".ts");
  const cmd = isTs ? "npx" : "node";
  const cmdArgs = isTs ? ["tsx", abs] : [abs];
  const r = spawnSync(cmd, cmdArgs, {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
    env: process.env,
    timeout: 120_000,
  });
  const ms = Date.now() - t0;
  const out = `${r.stdout || ""}\n${r.stderr || ""}`.trim();
  const ok = r.status === 0;
  const detail = ok
    ? (out.split("\n").filter((l) => /OK|✓|pass/i.test(l)).slice(-1)[0] || "ok").slice(0, 120)
    : (out.split("\n").filter(Boolean).slice(-3).join(" | ") || `exit=${r.status}`).slice(0, 240);
  return { id, path: pathRel, ok, ms, detail };
}

async function main() {
  console.log("────────────────────────────────────────");
  console.log("【F58】拡張テスト→抜け→改善ループ");
  console.log(`  fix=${doFix ? "yes" : "no"}  scanOnly=${scanOnly ? "yes" : "no"}`);
  console.log("────────────────────────────────────────");

  let fixed: string[] = [];
  if (doFix) {
    fixed = applyFreeExtWiringFixes(root);
    console.log(`■ 無料直し: ${fixed.length ? fixed.join("・") : "なし"}`);
  }

  const findings0 = scanExtWiringFindings(root);
  console.log(`■ 配線抜けスキャン: ${findings0.length}件`);
  for (const f of findings0.slice(0, 10)) {
    console.log(`  ${f.fixable ? "🔧" : "・"} [${f.layer}] ${f.id}: ${f.gap}`);
    console.log(`     → ${f.next}`);
  }

  const runs: ExtTestRunItem[] = [];
  if (!scanOnly) {
    console.log(`■ スイート実行: ${EXT_TEST_IMPROVE_SUITE.length}本`);
    for (const t of EXT_TEST_IMPROVE_SUITE) {
      process.stdout.write(`  … ${t.id} `);
      const r = runOne(t.path);
      runs.push(r);
      console.log(r.ok ? `✓ ${r.ms}ms` : `✗ ${r.ms}ms ${r.detail.slice(0, 80)}`);
    }
  }

  // テスト後にもう一度スキャン（--fix 後の残り）
  const findings = scanExtWiringFindings(root);
  // --fix で直したものは findings から消えているはず。fixed を記録用に残す
  const stamp = evaluateExtTestLoop({
    runs: scanOnly
      ? EXT_TEST_IMPROVE_SUITE.map((t) => ({
          id: t.id,
          path: t.path,
          ok: true,
          ms: 0,
          detail: "scan-only skipped",
        }))
      : runs,
    findings,
    fixed,
    manifest_ver: manifestVer(),
    rules_reviewed: rulesReviewedFromDisk(),
  });

  // scan-only はテスト未実行なので ok にしない
  if (scanOnly) {
    stamp.ok = false;
    stamp.line = `配線スキャンのみ 抜け=${findings.length}（テスト未実行）`;
    stamp.next = findings.length
      ? `抜けを直す（--fix）→ npx tsx scripts/ext-test-improve-loop.ts`
      : "npx tsx scripts/ext-test-improve-loop.ts でスイート実行";
    stamp.fail_n = 0;
    stamp.pass_n = 0;
    stamp.suite_n = 0;
    stamp.runs = [];
  }

  const path = writeExtTestLoopStamp(stamp, root);
  console.log("────────────────────────────────────────");
  console.log(`■ 判定: ${stamp.ok ? "✓完了" : "未完"}`);
  console.log(`  ${stamp.line}`);
  console.log(`  次: ${stamp.next}`);
  console.log(`  スタンプ: ${path}`);
  console.log("────────────────────────────────────────");

  if (stamp.ok) process.exit(0);
  if (stamp.fail_n > 0) process.exit(1);
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
