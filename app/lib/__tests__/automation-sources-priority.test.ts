// app/lib/__tests__/automation-sources-priority.test.ts
// 2026-11-10 竹内さん「自動モード本来のように AIX 優先度順に動いていく形で」
//   pickClaimable が AIX の指示を先に渡すこと・今まで通り自動便は後ろに回すことを固定する。
import { pickClaimable, AIX_PRIORITY_SOURCE } from "../automation-sources";

let passed = 0;
let failed = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + "\n      actual:   " + a + "\n      expected: " + b); }
}

const NOW = Date.parse("2026-11-10T10:00:00+09:00");
const cmd = (id: string, source: string | null, extra?: Record<string, unknown>) => ({
  id,
  payload: { source, ...(extra ?? {}) },
});

console.log("■ AIX の指示を先に渡す");
eq("AIX が自動便より後ろにあっても AIX を先に", pickClaimable([cmd("a", "auto_schedule"), cmd("b", "aix")], NOW)?.id, "b");
eq("AIX が広げての続き（web_brain）より先", pickClaimable([cmd("w", "web_brain"), cmd("b", "aix")], NOW)?.id, "b");
eq("AIX どうしは積まれた順（古い順）", pickClaimable([cmd("x1", "aix"), cmd("x2", "aix")], NOW)?.id, "x1");
eq("AIX が1件も無ければ今まで通り自動便でない物が先", pickClaimable([cmd("a", "auto_schedule"), cmd("w", "web_brain")], NOW)?.id, "w");
eq("AIX しか無ければ AIX", pickClaimable([cmd("b", "aix")], NOW)?.id, "b");
eq("not_before が未来の AIX は渡さない（次の物へ）", pickClaimable([
  cmd("soon", "aix", { not_before: new Date(NOW + 60 * 60 * 1000).toISOString() }),
  cmd("later", "web_brain"),
], NOW)?.id, "later");
eq("空なら null", pickClaimable([], NOW), null);
eq("AIX の出どころの名前", AIX_PRIORITY_SOURCE, "aix");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
