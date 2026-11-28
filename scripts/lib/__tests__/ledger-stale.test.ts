// npx tsx scripts/lib/__tests__/ledger-stale.test.ts
import assert from "node:assert/strict";
import { switchesOf, filesOf, hashesOf, refsOf, staleRowOf, type GitCommit } from "../ledger-stale";

const it = { id: 747, title: "読み手の材料に優先順位を付ける（MATERIAL_PRIORITY・既定 off）", next_step: "①目録 scripts/audit-material-priority-hit.ts ②表 61641d727 と app/lib/material-priority.ts", switch_name: "MATERIAL_PRIORITY", owner: "作業員L", stage: "todo", commits: [] };
assert.deepEqual(switchesOf(it), ["MATERIAL_PRIORITY"]);
assert.deepEqual(filesOf(it), ["scripts/audit-material-priority-hit.ts", "app/lib/material-priority.ts"]);
assert.deepEqual(hashesOf(it), ["61641d727"]);
const commits: GitCommit[] = [
  { hash: "61641d727", date: "2026-11-26", subject: "#747 MATERIAL_PRIORITY（既定 off）" },
  { hash: "aaaaaaa11", date: "2026-11-26", subject: "#7470 別の件" },
  { hash: "bbbbbbb22", date: "2026-11-25", subject: "#749 入口" },
];
assert.deepEqual(refsOf(747, commits).map((c) => c.hash), ["61641d727"], "#7470 は #747 に数えない");
const base = { commits, codeNames: new Set(["MATERIAL_PRIORITY", "PROMISE_CALL_VIEW_FULFIL"]), defaults: { MATERIAL_PRIORITY: "off", CONDUCTOR_INTAKE_MAX_TOKENS_WIDE: "on" }, fileExists: (p: string) => p.endsWith("material-priority.ts"), knownHash: (h: string) => h.startsWith("61641d7") };
// 既定 off のスイッチとコミット＝built_off の候補
assert.equal(staleRowOf(it, base).verdict, "built_off_candidate");
// 既定 on のスイッチとコミット＝done の候補
assert.equal(staleRowOf({ ...it, id: 749, title: "入口（CONDUCTOR_INTAKE_MAX_TOKENS_WIDE）", switch_name: null, next_step: "" }, { ...base, codeNames: new Set(["CONDUCTOR_INTAKE_MAX_TOKENS_WIDE"]) }).verdict, "done_candidate");
// スイッチの名前が無くコミットだけ＝done の候補（台本・記録の件）
assert.equal(staleRowOf({ ...it, id: 749, title: "入口の数え", switch_name: null, next_step: "" }, base).verdict, "done_candidate");
// コミットは無いがコードにスイッチがある＝一部ありそう
assert.equal(staleRowOf({ ...it, id: 9999 }, base).verdict, "partly");
// 何も無い＝作っていなさそう
assert.equal(staleRowOf({ id: 9998, title: "新しい土台", next_step: "これから", switch_name: null, owner: "作業員A", stage: "todo" }, base).verdict, "not_built");
// 環境の名前はスイッチに数えない
assert.deepEqual(switchesOf({ title: "LLM_TEST_MODE=deepseek-all で", next_step: null, switch_name: null }), []);
console.log("ledger-stale ok 10");
