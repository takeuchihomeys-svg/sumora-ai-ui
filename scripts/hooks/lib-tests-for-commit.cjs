// scripts/hooks/lib-tests-for-commit.cjs — pre-commit で「commit に入る物」に関わる app/lib/__tests__ の試験だけを流す（LLM 0・DB 0・費用0）
// 2026-11-27 作業員L（台帳 #822 の続き・統括役の決め）:
//   選び方: 入る物（git diff --cached）の app/ の各ファイル X について ① 名前が X で始まる試験 ② X を import する試験 ③ X のパス（app/lib/X.ts 等）を文字列で読む試験 ④ 入る試験そのもの
//   外す物: scripts/hooks/lib-tests-known.json の slow（1本 5秒を超える・夜に回す）・needsEnv（DB の url が要る・hook は .env を読まない）・knownFail（main でも落ちる＝知っている落ち）
//   止める: 選んだ試験が落ちた時だけ（知っている落ちは流さない。知っている落ちが入る物に関わる時は1行だけ出す）
//   上限: 合わせて LIB_TESTS_BUDGET_SEC（既定 60秒）。超えたら残りは流さずに通し、記録を残す
//   逃げ道: SKIP_LIB_TESTS=1（統括役の夜の merge でも効く）。記録は <git の共通の場所>/lib-tests-hook.log（git には入れない）
//   有効にするのは、この PC の倉庫の設定だけ（git config core.hooksPath scripts/hooks）。設定は commit しない
"use strict";
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const TEST_DIR = "app/lib/__tests__";

/** 入る物から流す試験を選ぶ（純関数）。tests: { file（basename）→ 中身 } */
function selectTests(staged, tests, known, libModules = new Set()) {
  // 名前で始まる試験（X-foo.test.ts）は、foo の付いた部品（app/lib/X-foo.ts）が別にある時は X の試験と見なさない（aix.ts で aix-*.test.ts を全部拾わない）
  const stemOf = (t) => t.replace(/\.test\.ts$/, "");
  const skip = new Set([...(known.slow || []).map((x) => x.file), ...(known.needsEnv || []), ...(known.knownFail || []).map((x) => x.file)]);
  const pick = new Set(); const knownHit = new Set();
  for (const p of staged) {
    const norm = p.replace(/\\/g, "/");
    if (norm.startsWith(`${TEST_DIR}/`) && norm.endsWith(".test.ts")) { const b = path.basename(norm); (skip.has(b) ? knownHit : pick).add(b); continue; }
    if (!/^app\/.+\.(ts|tsx)$/.test(norm) || norm.includes("/__tests__/")) continue;
    const base = path.basename(norm).replace(/\.(ts|tsx)$/, "");
    const inLib = norm.startsWith("app/lib/") && norm.split("/").length === 3;
    for (const [f, src] of Object.entries(tests)) {
      const hit = (inLib && (f === `${base}.test.ts` || ((f.startsWith(`${base}-`) || f.startsWith(`${base}.`)) && !libModules.has(stemOf(f)))))
        || (inLib && (src.includes(`"../${base}"`) || src.includes(`'../${base}'`) || src.includes(`"@/app/lib/${base}"`)))
        || src.includes(norm);
      if (!hit) continue;
      (skip.has(f) ? knownHit : pick).add(f);
    }
  }
  return { run: [...pick].sort(), knownHit: [...knownHit].sort() };
}

function tsxLoader() {
  if (process.env.TSX_LOADER) return process.env.TSX_LOADER;
  try { return require.resolve("tsx"); } catch { /* 倉庫に無い */ }
  // npx の置き場（この PC は npx tsx で入っている）
  const cache = path.join(process.env.LOCALAPPDATA || "", "npm-cache", "_npx");
  try { for (const d of fs.readdirSync(cache)) { const p = path.join(cache, d, "node_modules", "tsx", "dist", "loader.mjs"); if (fs.existsSync(p)) return "file:///" + p.replace(/\\/g, "/"); } } catch { /* 無い */ }
  return null;
}

function logLine(msg) {
  try { const dir = execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim(); fs.appendFileSync(path.join(dir, "lib-tests-hook.log"), `${new Date().toISOString()} ${msg}\n`); } catch { /* 記録できなくても通す */ }
}

function main() {
  if (process.env.SKIP_LIB_TESTS === "1") { logLine("SKIP_LIB_TESTS=1 で飛ばした"); console.log("[lib-tests] SKIP_LIB_TESTS=1 で飛ばしました"); return 0; }
  // LIB_TESTS_FILES=a,b で入る物を差し替えて試せる（有効にする前の確かめ用）
  const staged = process.env.LIB_TESTS_FILES ? process.env.LIB_TESTS_FILES.split(",").filter(Boolean) : execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  if (!staged.some((p) => p.startsWith("app/"))) return 0;
  let known = {}; try { known = JSON.parse(fs.readFileSync("scripts/hooks/lib-tests-known.json", "utf8")); } catch { /* 表が無ければ外す物なし */ }
  const tests = {}; for (const f of fs.readdirSync(TEST_DIR)) if (f.endsWith(".test.ts")) { try { tests[f] = fs.readFileSync(path.join(TEST_DIR, f), "utf8"); } catch { /* 読めない */ } }
  const libModules = new Set(fs.readdirSync("app/lib").filter((x) => /\.tsx?$/.test(x)).map((x) => x.replace(/\.tsx?$/, "")));
  const { run, knownHit } = selectTests(staged, tests, known, libModules);
  if (knownHit.length) console.log(`[lib-tests] 知っている落ち・遅い・DB が要る試験は流さない: ${knownHit.join(" ")}`);
  if (!run.length) return 0;
  const loader = tsxLoader();
  if (!loader) { logLine(`tsx が見つからない・${run.length}本を流さずに通した`); console.log("[lib-tests] tsx が見つからないので流さずに通します"); return 0; }
  const budget = Number(process.env.LIB_TESTS_BUDGET_SEC || 60) * 1000; const t0 = Date.now();
  const failed = []; let done = 0;
  for (const f of run) {
    const left = budget - (Date.now() - t0);
    if (left <= 0) { logLine(`上限 ${budget / 1000}秒を超えた・${run.length - done}本を流さずに通した（${run.slice(done).join(" ")}）`); console.log(`[lib-tests] 上限を超えたので残り ${run.length - done}本は流さずに通します（記録を残しました）`); break; }
    const r = spawnSync(process.execPath, ["--import", loader, path.join(TEST_DIR, f)], { encoding: "utf8", timeout: Math.min(left, 30_000) });
    done++;
    if (r.error && r.error.code === "ETIMEDOUT") { logLine(`時間切れ ${f}（流さずに通した）`); console.log(`[lib-tests] 時間切れ ${f}（記録して通します）`); continue; }
    if (r.status !== 0) failed.push({ f, out: `${r.stdout || ""}\n${r.stderr || ""}`.split(/\r?\n/).filter((l) => /✗|FAIL|Error|fail/.test(l)).slice(0, 3).join(" / ") });
  }
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  if (failed.length) {
    console.log(`[lib-tests] 落ちた ${failed.length}/${done}本（${sec}秒）。直すか、main でも落ちる物なら scripts/hooks/lib-tests-known.json の knownFail に足してください（急ぎは SKIP_LIB_TESTS=1）`);
    for (const x of failed) console.log(`  ✗ ${x.f}: ${x.out.slice(0, 200)}`);
    logLine(`止めた: ${failed.map((x) => x.f).join(" ")}`);
    return 1;
  }
  console.log(`[lib-tests] ${done}本 通った（${sec}秒）`);
  return 0;
}

module.exports = { selectTests };
if (require.main === module) process.exit(main());
