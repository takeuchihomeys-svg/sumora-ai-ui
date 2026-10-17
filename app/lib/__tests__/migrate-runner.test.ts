// migrate-schema の文をまとめて流す — 2026-10-18（migrate-runner.ts）
// 実行: npx tsx app/lib/__tests__/migrate-runner.test.ts
import { readFileSync } from "fs";
import { join } from "path";
import { runStatementsBatched, terminate, isCommentOnly, buildBatchSql, shouldSkipUnchanged, sqlFingerprint } from "../migrate-runner";
import { splitSql } from "../sql-split";

let passed = 0, failed = 0;
const it = async (name: string, fn: () => void | Promise<void>) => { try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } };
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };
const ok = (c: unknown, m = "") => { if (!c) throw new Error("assert " + m); };

/** 手元の偽 exec: 「BAD」を含む呼び出しは失敗（まとまりなら全体が戻る＝何も適用しない）・適用した文を順に記録 */
function fakeExec(opts: { failIf?: (sql: string) => boolean; tick?: () => void } = {}) {
  const applied: string[] = [];
  const calls: string[] = [];
  const exec = async (sql: string) => {
    calls.push(sql);
    opts.tick?.();
    if ((opts.failIf ?? ((s: string) => s.includes("BAD")))(sql)) return { error: "boom" };
    for (const part of sql.split("\n")) if (/^(S\d+|ATOM)/.test(part)) applied.push(part.replace(/;$/, ""));
    return { error: null };
  };
  return { exec, applied, calls };
}

(async () => {
  console.log("migrate-runner");
  const stmts = Array.from({ length: 120 }, (_, i) => `S${i};`);

  await it("全部成功なら 50 ずつ3回の呼び出し・順番どおり", async () => {
    const f = fakeExec();
    const r = await runStatementsBatched(stmts, f.exec, { batchSize: 50 });
    eq(r.calls, 3); eq(r.batches, 3); eq(r.batchFailures, 0); eq(r.errors.length, 0); eq(r.completed, true);
    eq(f.applied, stmts.map((s) => s.replace(";", "")));
    ok(f.calls[0].startsWith("SET LOCAL lock_timeout = '3s';"), "lock_timeout");
  });

  await it("まとまりが失敗したらそのまとまりだけ1文ずつ流し直す（失敗した1文だけが errors・他は適用）", async () => {
    const s = [...stmts]; s[60] = "BAD60;";
    const f = fakeExec();
    const r = await runStatementsBatched(s, f.exec, { batchSize: 50 });
    eq(r.batchFailures, 1);
    eq(r.errors.map((e) => e.index), [60]);
    eq(r.calls, 3 + 50); // 3まとまり＋2つ目の50文
    eq(f.applied.length, 119);
    eq(f.applied.indexOf("S59") < f.applied.indexOf("S61"), true);
  });

  await it("コメントだけの塊は流さない・数にも入れない", async () => {
    const f = fakeExec();
    const r = await runStatementsBatched(["S1;", "-- 説明 UPDATE x SET a=1;", "S2;"], f.exec, { batchSize: 50 });
    eq(r.total, 2); eq(r.calls, 1);
    eq(isCommentOnly("-- a;\n-- b;"), true); eq(isCommentOnly("-- a\nS1;"), false);
  });

  await it("末尾のコメント行は落として ; で終わる（つないだ次の文がコメントに飲まれない）", async () => {
    eq(terminate("S1;\n-- 後ろの説明"), "S1;");
    eq(terminate("CREATE X"), "CREATE X;");
    eq(buildBatchSql(["S1;\n-- c", "S2"], null), "S1;\nS2;");
  });

  await it("@atomic の塊（1要素）は流し直しでも分けない", async () => {
    const sql = ["S0;", "-- @atomic-begin", "DROP FUNCTION IF EXISTS f(int);", "CREATE FUNCTION f(int) RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;", "-- @atomic-end", "BAD;"].join("\n");
    const parts = splitSql(sql);
    eq(parts.length, 3);
    const f = fakeExec();
    await runStatementsBatched(parts, f.exec, { batchSize: 50 });
    // 1回目（まとまり）＋流し直し3回。atomic は1回の呼び出しに DROP と CREATE が両方ある
    eq(f.calls.length, 4);
    ok(f.calls.some((c) => c.includes("DROP FUNCTION") && c.includes("CREATE FUNCTION") && !c.startsWith("SET LOCAL")), "atomic in one call");
  });

  await it("締め切りを過ぎたら新しい呼び出しをしない・止めた所を残す", async () => {
    let t = 0;
    const f = fakeExec({ tick: () => { t += 100; } });
    const r = await runStatementsBatched(stmts, f.exec, { batchSize: 50, deadlineAt: 150, now: () => t });
    eq(r.completed, false); eq(r.stoppedAt, 100); eq(r.calls, 2);
  });

  await it("batchSize=1（MIGRATE_BATCH=off）は旧と同じ1文ずつ・SET LOCAL なし", async () => {
    const f = fakeExec();
    const r = await runStatementsBatched(["S1;", "BAD;", "S2;"], f.exec, { batchSize: 1 });
    eq(r.calls, 3); eq(r.errors.length, 1); eq(f.calls, ["S1;", "BAD;", "S2;"]);
  });

  await it("exec が投げても止まらず errors に残す", async () => {
    const r = await runStatementsBatched(["S1;", "S2;"], async () => { throw new Error("net"); }, { batchSize: 50 });
    eq(r.errors.length, 2); eq(r.completed, true);
  });

  await it("指紋が同じ・最後まで流した・3日以内なら流さない", () => {
    const now = Date.parse("2026-10-18T15:10:00Z");
    eq(shouldSkipUnchanged({ fingerprint: "a", completed: true, started_at: "2026-10-17T15:10:00Z" }, "a", now, 3), true);
    eq(shouldSkipUnchanged({ fingerprint: "a", completed: true, started_at: "2026-10-14T15:10:00Z" }, "a", now, 3), false);
    eq(shouldSkipUnchanged({ fingerprint: "b", completed: true, started_at: "2026-10-17T15:10:00Z" }, "a", now, 3), false);
    eq(shouldSkipUnchanged({ fingerprint: "a", completed: false, started_at: "2026-10-17T15:10:00Z" }, "a", now, 3), false);
    eq(shouldSkipUnchanged(null, "a", now, 3), false);
    eq(sqlFingerprint("x") === sqlFingerprint("x") && sqlFingerprint("x") !== sqlFingerprint("y"), true);
  });

  await it("本物の migrate-schema: 関数の SET を付け直す DO ブロックは全ての match_* 定義より後ろ（94cc340a）・コメントだけの塊を除いても順は同じ", () => {
    const src = readFileSync(join(__dirname, "..", "..", "api", "migrate-schema", "route.ts"), "utf8");
    const a = src.indexOf("const SQL = `"), b = src.indexOf("`.trim();", a);
    const parts = splitSql((new Function("return `" + src.slice(a + "const SQL = `".length, b) + "`")() as string).trim()).filter((s) => !isCommentOnly(s));
    const doIdx = parts.findIndex((s) => s.includes("ALTER FUNCTION match_reply_knowledge(vector, integer, integer, text) SET ivfflat.probes"));
    ok(doIdx > 0, "DO block found");
    ok(parts[doIdx].includes("PERFORM '[1,0]'::vector"), "vector load in same call");
    for (const name of ["match_reply_knowledge", "match_reply_examples", "match_aix_reply_examples", "match_winning_patterns", "match_design_thinking", "match_conversation_checkpoints"]) {
      const last = parts.map((s, i) => (new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\s*\\(`).test(s) ? i : -1)).reduce((x, y) => Math.max(x, y), -1);
      ok(last >= 0 && last < doIdx, `${name} defined before DO (${last} < ${doIdx})`);
    }
    // 毎晩失敗していた文を外した
    ok(!parts.some((s) => /CREATE INDEX IF NOT EXISTS idx_system_design_thinking_embedding/.test(s.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n"))), "ivfflat index removed");
    ok(!parts.some((s) => /^\s*CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_sys_key_full_created/m.test(s)), "sys_key_full btree removed");
    ok(!parts.some((s) => /^ALTER PUBLICATION supabase_realtime ADD TABLE line_tasks;/m.test(s.trim())), "line_tasks publication guarded");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
