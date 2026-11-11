// 2026-11-10 作業員8: 試験の係の前段で鍵が要る読みを解く決め（exam-near-hook）
// 実行: npx tsx scripts/lib/__tests__/exam-near-hook.test.ts（env 不要・全 OK で exit 0）
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pendingCounts, decideNearResolve, isExamJob, ownerBaseDue } from "../exam-near-hook";

let passed = 0, failed = 0;
function t(name: string, cond: boolean, extra?: unknown) {
  if (cond) { passed++; console.log("  OK  " + name); } else { failed++; console.log("  NG  " + name + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 300) : "")); }
}

const root = mkdtempSync(join(tmpdir(), "near-hook-"));
try {
  mkdirSync(join(root, "2026-11-09", "pending"), { recursive: true });
  mkdirSync(join(root, "2026-11-10", "pending"), { recursive: true });
  mkdirSync(join(root, "2026-11-08", "pending-leaked-before-8c1b057c"), { recursive: true });
  writeFileSync(join(root, "2026-11-09", "pending", "k-a.json"), "{}");
  writeFileSync(join(root, "2026-11-09", "pending", "k-b.json"), "{}");
  writeFileSync(join(root, "2026-11-09", "pending", "note.txt"), "");
  writeFileSync(join(root, "2026-11-08", "pending-leaked-before-8c1b057c", "k-c.json"), "{}");
  mkdirSync(join(root, "keys"), { recursive: true });
  const c = pendingCounts(root);
  t("日ごとの頼みの数（.json だけ・空の日と退けた置き場は数えない）", JSON.stringify(c) === JSON.stringify({ "2026-11-09": 2 }), c);
  t("置き場が無ければ空", Object.keys(pendingCounts(join(root, "none"))).length === 0);
} finally { rmSync(root, { recursive: true, force: true }); }

t("試験の依頼だけ（tsc・tsc-remote・読むだけの cmd は除く）", isExamJob({}) && isExamJob({ runner: "cmd" }) && !isExamJob({ runner: "tsc-remote" }) && !isExamJob({ runner: "tsc" }) && !isExamJob({ runner: "cmd", readOnly: true }));
const counts = { "2026-11-10": 3, "2026-11-09": 2 };
const has = () => true;
const d1 = decideNearResolve({ job: {}, counts, configEnv: "C:/x/.env.local", env: {}, envExists: has });
t("頼みがあり鍵の env があれば解く（日は古い順・数は合計）", d1.run && d1.days.join() === "2026-11-09,2026-11-10" && d1.total === 5 && d1.envPath === "C:/x/.env.local", d1);
t("config が無ければ EXAM_NEAR_RESOLVE_ENV", (() => { const d = decideNearResolve({ job: {}, counts, env: { EXAM_NEAR_RESOLVE_ENV: "C:/y" }, envExists: has }); return d.run && d.envPath === "C:/y"; })());
t("鍵の env が無ければ解かない（no_env）", decideNearResolve({ job: {}, counts, env: {}, envExists: has }).run === false);
t("env のファイルが無ければ解かない（env_missing）", (() => { const d = decideNearResolve({ job: {}, counts, configEnv: "C:/x", env: {}, envExists: () => false }); return !d.run && d.why === "env_missing"; })());
t("頼みが無ければ解かない", (() => { const d = decideNearResolve({ job: {}, counts: {}, configEnv: "C:/x", env: {}, envExists: has }); return !d.run && d.why === "no_pending"; })());
t("tsc-remote の依頼では解かない", (() => { const d = decideNearResolve({ job: { runner: "tsc-remote" }, counts, configEnv: "C:/x", env: {}, envExists: has }); return !d.run && d.why === "not_exam"; })());
t("EXAM_NEAR_RESOLVE_HOOK=off で止まる", (() => { const d = decideNearResolve({ job: {}, counts, configEnv: "C:/x", env: { EXAM_NEAR_RESOLVE_HOOK: "OFF" }, envExists: has }); return !d.run && d.why === "switch_off"; })());

// 2026-11-11 作業員8: 取りこぼしの網を1日1回・JST 1:30 以降
{
  const at = (jst: string) => Date.parse(`${jst}+09:00`);
  t("JST 1:29 は流さない", !ownerBaseDue(null, at("2026-11-12T01:29:00")).due);
  t("JST 1:30 は流す（日は JST）", (() => { const d = ownerBaseDue("2026-11-11", at("2026-11-12T01:30:00")); return d.due && d.day === "2026-11-12"; })());
  t("同じ日に2回は流さない", !ownerBaseDue("2026-11-12", at("2026-11-12T10:00:00")).due);
  t("係が 1:30 に止まっていても、その日のうちに立ち上がれば流す", ownerBaseDue("2026-11-11", at("2026-11-12T09:00:00")).due);
  t("EXAM_OWNER_BASE_NIGHTLY=off で流さない", !ownerBaseDue(null, at("2026-11-12T02:00:00"), { EXAM_OWNER_BASE_NIGHTLY: "off" }).due);
}

console.log(`\n${passed} OK / ${failed} NG`);
process.exit(failed ? 1 : 0);
