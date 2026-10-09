// RAG の検索の厳密さ（ivfflat.probes）の見張り — 2026-10-09（rag-probes-check.ts）
// 実行: npx tsx app/lib/__tests__/rag-probes-check.test.ts
import { buildRagProbesCheckSql, parseRagProbesCheck, ragProbesWarningLine, checkRagProbes, RAG_PROBES_FUNCS } from "../rag-probes-check";

let passed = 0, failed = 0;
const it = async (name: string, fn: () => void | Promise<void>) => { try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } };
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };

(async () => {
  await it("SQL は6本の名前と probes>=100 を含む・書き込みの語が無い", () => {
    const s = buildRagProbesCheckSql();
    for (const f of RAG_PROBES_FUNCS) if (!s.includes(`'${f}'`)) throw new Error(f);
    if (!s.includes(">= 100")) throw new Error("min");
    if (/\b(ALTER|UPDATE|INSERT|DELETE|CREATE|DROP)\b/i.test(s)) throw new Error("書き込みの語がある");
  });
  await it("名前に変な文字は入らない", () => { if (buildRagProbesCheckSql(["match_x'; DROP"]).includes("DROP")) throw new Error("injection"); });
  await it("エラー無し＝ok", () => eq(parseRagProbesCheck(null), { status: "ok" }));
  // 実物（2026-10-09 MCP で確かめた文）
  await it("足りない関数の名前を読む", () => eq(parseRagProbesCheck("ERROR:  P0001: RAG_PROBES_MISSING:match_reply_examples,match_templates\nCONTEXT:  PL/pgSQL function inline_code_block line 5 at RAISE"), { status: "missing", funcs: ["match_reply_examples", "match_templates"] }));
  await it("他のエラーは unknown（誤警告しない）", () => { const r = parseRagProbesCheck("permission denied for function exec_sql"); eq(r.status, "unknown"); eq(ragProbesWarningLine(r), ""); });
  await it("警告の1行", () => { if (!ragProbesWarningLine({ status: "missing", funcs: ["match_reply_examples"] }).includes("match_reply_examples")) throw new Error("line"); });
  await it("rpc が投げても投げない", async () => { const r = await checkRagProbes({ rpc: () => { throw new Error("down"); } }); eq(r.status, "unknown"); });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
