// 本番に要る関数・トリガーの見張り＋migrate-schema の DROP→CREATE の分かれ — 2026-10-17（schema-objects-check.ts・sql-split.ts）
// 実行: npx tsx app/lib/__tests__/schema-objects-check.test.ts
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { buildSchemaObjectsCheckSql, parseSchemaObjectsCheck, schemaObjectsWarningLine, checkSchemaObjects, REQUIRED_FUNCS, REQUIRED_TRIGGERS } from "../schema-objects-check";
import { splitSql, findSplitDropCreate } from "../sql-split";

let passed = 0, failed = 0;
const it = async (name: string, fn: () => void | Promise<void>) => { try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } };
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };

const ROOT = join(__dirname, "..", "..", "..");
const migrateSql = (() => {
  const src = readFileSync(join(ROOT, "app", "api", "migrate-schema", "route.ts"), "utf8");
  const a = src.indexOf("const SQL = `"), b = src.indexOf("`.trim();", a);
  return src.slice(a + "const SQL = `".length, b);
})();
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n.startsWith(".") || n === "__tests__") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}

(async () => {
  await it("SQL は要る名前を含む・書き込みの語が無い", () => {
    const s = buildSchemaObjectsCheckSql();
    for (const f of REQUIRED_FUNCS) if (!s.includes(`'${f}'`)) throw new Error(f);
    for (const t of REQUIRED_TRIGGERS) if (!s.includes(`'${t.name}'`)) throw new Error(t.name);
    if (/\b(ALTER|UPDATE|INSERT|DELETE|CREATE|DROP)\b/i.test(s)) throw new Error("書き込みの語がある");
  });
  await it("名前に変な文字は入らない", () => { if (buildSchemaObjectsCheckSql(["x'; DROP"], []).includes("DROP")) throw new Error("injection"); });
  await it("エラー無し＝ok", () => eq(parseSchemaObjectsCheck(null), { status: "ok" }));
  // 実物（2026-10-17 本番で偽の名前を混ぜて確かめた文）
  await it("足りない物の名前を読む", () => eq(parseSchemaObjectsCheck("SCHEMA_OBJECTS_MISSING:fn:no_such_fn_x,trg:no_such_trg"), { status: "missing", funcs: ["no_such_fn_x"], triggers: ["no_such_trg"] }));
  await it("他のエラーは unknown（誤警告しない）", () => { const r = parseSchemaObjectsCheck("permission denied for function exec_sql"); eq(r.status, "unknown"); eq(schemaObjectsWarningLine(r), ""); });
  await it("警告の1行", () => { if (!schemaObjectsWarningLine({ status: "missing", funcs: ["match_design_thinking_exact"], triggers: [] }).includes("match_design_thinking_exact")) throw new Error("line"); });
  await it("rpc が投げても投げない", async () => { const r = await checkSchemaObjects({ rpc: () => { throw new Error("down"); } }); eq(r.status, "unknown"); });

  await it("コードの .rpc(\"…\") は全部 REQUIRED_FUNCS にある（足したら一覧にも足す）", () => {
    const names = new Set<string>();
    for (const f of walk(join(ROOT, "app"))) for (const m of readFileSync(f, "utf8").matchAll(/\.rpc\(\s*["'`]([a-zA-Z_]+)["'`]/g)) names.add(m[1]);
    names.delete("exec_sql");
    const missing = [...names].filter((n) => !(REQUIRED_FUNCS as readonly string[]).includes(n));
    eq(missing, []);
  });
  await it("トリガーの一覧は migrate-schema が作る物と同じ", () => {
    const made = new Set<string>();
    for (const m of migrateSql.matchAll(/CREATE\s+OR\s+REPLACE\s+TRIGGER\s+([a-z0-9_]+)/gi)) made.add(m[1]);
    for (const m of migrateSql.matchAll(/DROP\s+TRIGGER\s+IF\s+EXISTS\s+([a-z0-9_]+)/gi)) made.delete(m[1]);
    eq([...made].sort(), REQUIRED_TRIGGERS.map((t) => t.name).sort());
  });

  // migrate-schema の分け方
  await it("ドル引用符の中のセミコロンでは分けない", () => eq(splitSql("CREATE FUNCTION f() RETURNS int AS $$\nSELECT 1;\n$$;\nSELECT 2;").length, 2));
  await it("@atomic-begin〜end は1回の呼び出し", () => {
    const s = splitSql("SELECT 0;\n-- @atomic-begin\nDROP FUNCTION IF EXISTS f(int);\nCREATE FUNCTION f(a int) RETURNS int AS $$\nSELECT 1;\n$$;\n-- @atomic-end\nSELECT 2;");
    eq(s.length, 3);
    if (!/DROP[\s\S]*CREATE/.test(s[1])) throw new Error(s[1]);
  });
  await it("別々の呼び出しの DROP→CREATE を見つける・引数の数が違う overload は見逃す", () => {
    eq(findSplitDropCreate(splitSql("DROP FUNCTION IF EXISTS f(vector, integer);\nCREATE FUNCTION f(q vector(1536), n INT DEFAULT 4) RETURNS int AS $$\nSELECT 1;\n$$;")), ["f/2"]);
    eq(findSplitDropCreate(splitSql("DROP FUNCTION IF EXISTS f(vector, integer, integer);\nCREATE OR REPLACE FUNCTION f(q vector, a int, b int, c text) RETURNS int AS $$\nSELECT 1;\n$$;")), []);
    eq(findSplitDropCreate(splitSql("-- @atomic-begin\nDROP FUNCTION IF EXISTS f(int);\nCREATE FUNCTION f(a int) RETURNS int AS $$\nSELECT 1;\n$$;\n-- @atomic-end")), []);
  });
  await it("migrate-schema に「DROP だけの呼び出し→後で同じ関数を作る」組が無い（10/17 match_design_thinking_exact が消えた形）", () => eq(findSplitDropCreate(splitSql(migrateSql)), []));
  await it("migrate-schema で同じ関数を2回作っていない（古い版に戻す→正本に戻すの往復をしない）", () => {
    const seen = new Map<string, number>(), dup: string[] = [];
    for (const m of migrateSql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z0-9_]+)\s*\(/gi)) {
      const n = m[1].toLowerCase(); seen.set(n, (seen.get(n) ?? 0) + 1);
    }
    for (const [n, c] of seen) if (c > 1) dup.push(n);
    // 既にある二重定義（中身が同じ・作り直しても消えない CREATE OR REPLACE だけ）。新しく足さない
    const known = ["decay_knowledge_importance", "update_knowledge_feedback_by_ids"];
    eq(dup.filter((n) => !known.includes(n)).sort(), []);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
