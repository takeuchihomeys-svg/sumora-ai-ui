// 2026-11-15 作業員H: 試験の記録（exam_runs）はサーバーの鍵が無い時に公開の鍵で書きに行かない（EXAM_RUNS_REQUIRE_SERVICE_KEY・既定 on）
//   11/15 01:42Z の形: 係の env にサーバーの鍵が無く、公開の鍵に落ちて RLS で 401（試験の記録が DB に残らない・黙って落ちる）。DB は使わない（書く所は偽物）。
// 実行: npx tsx app/lib/__tests__/exam-runs-service-key.test.ts
import { upsertExamRun, examRunsServiceKeyMissing, type ExamRunRow } from "../exam-runs";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); } }

(async () => {
  let calls = 0;
  const fake = { from: (_t: string) => ({ upsert: async () => { calls++; return { error: null }; } }) };
  const row = { label: "test-1115" } as unknown as ExamRunRow;
  const warns: string[] = []; const w0 = console.warn; console.warn = (m: unknown) => { warns.push(String(m)); };
  const noKey = await upsertExamRun(fake, row, { NEXT_PUBLIC_SUPABASE_ANON_KEY: "x" });
  console.warn = w0;
  ok("鍵が無い（既定）→ 書きに行かない・no_service_key・1行出す", !noKey.ok && noKey.error === "no_service_key" && calls === 0 && warns.length === 1 && /書けない/.test(warns[0]), JSON.stringify({ noKey, calls, warns }));
  const withKey = await upsertExamRun(fake, row, { SUPABASE_SERVICE_ROLE_KEY: "y" });
  ok("鍵がある → 今まで通り書く", withKey.ok && calls === 1);
  const off = await upsertExamRun(fake, row, { EXAM_RUNS_REQUIRE_SERVICE_KEY: "off" });
  ok("=off なら前の形（鍵が無くても書きに行く）", off.ok && calls === 2);
  ok("判定の純関数", examRunsServiceKeyMissing({}) && !examRunsServiceKeyMissing({ SUPABASE_SERVICE_ROLE_KEY: "y" }) && !examRunsServiceKeyMissing({ EXAM_RUNS_REQUIRE_SERVICE_KEY: "off" }));
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
