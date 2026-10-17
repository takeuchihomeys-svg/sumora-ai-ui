// trigger_action_rules を読む select が無い列を指していないか — 2026-10-18 弱い所A-2
// （8/14 から brain-core が rule_text を select して毎回 42703・1日 約1,200回の postgres ERROR・結果は握りつぶされ空だった）
// 実行: npx tsx app/lib/__tests__/trigger-action-rules-columns.test.ts
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

let passed = 0, failed = 0;
const it = (name: string, fn: () => void) => { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } };

const ROOT = join(__dirname, "..", "..", "..");
const migrate = readFileSync(join(ROOT, "app", "api", "migrate-schema", "route.ts"), "utf8");

function columnsOf(table: string): Set<string> {
  const cols = new Set<string>();
  const create = migrate.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`));
  if (create) for (const line of create[1].split("\n")) { const m = line.trim().match(/^([a-z_]+)\s+[A-Z]/); if (m && m[1] !== "unique") cols.add(m[1]); }
  for (const m of migrate.matchAll(new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ([a-z_]+)`, "g"))) cols.add(m[1]);
  return cols;
}
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n.startsWith(".") || n === "__tests__") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}

console.log("trigger_action_rules の列");
const cols = columnsOf("trigger_action_rules");
it("migrate-schema から列が読める", () => { for (const c of ["keyword", "action_type", "confidence", "category"]) if (!cols.has(c)) throw new Error(`no ${c}: ${[...cols]}`); });
it("app の select は在る列だけ（旧に戻すスイッチの中の1か所を除く）", () => {
  const bad: string[] = [];
  for (const f of walk(join(ROOT, "app"))) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/from\("trigger_action_rules"\)\s*\.select\("([^"]+)"\)/g)) {
      const before = src.slice(Math.max(0, (m.index ?? 0) - 400), m.index);
      if (before.includes("BRAIN_BOUNDARY_TRIGGER_RULES")) continue; // 旧に戻すスイッチ（既定で引かない）
      for (const c of m[1].split(",").map((x) => x.trim())) if (c !== "*" && !cols.has(c)) bad.push(`${f.slice(ROOT.length)}: ${c}`);
    }
  }
  if (bad.length) throw new Error(bad.join("\n"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
