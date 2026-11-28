// npx tsx scripts/lib/__tests__/karte-morning.test.ts
import assert from "node:assert/strict";
import { karteMorningLine } from "../karte-morning";
import { nightZeroCostSteps } from "../exam-night-jobs";
const d = "2026-11-28";
const rows = [{ day: d, metric: "karte:has_block", value: 100, n: 29 }, { day: d, metric: "karte:avg_len", value: 125 }, { day: d, metric: "karte:dropped", value: 0 }, { day: d, metric: "karte:field:priorities", value: 82.8 }, { day: d, metric: "karte:field:decider", value: 3.4 }];
assert.equal(karteMorningLine(rows), "- お客様のカルテ（#806・2026-11-28・前の7日・29会話）: 出る 100%・平均 125字・優先 82.8%・決める人 3.4%（CUSTOMER_KARTE は既定 off）");
assert.equal(karteMorningLine([]), null);
assert.equal(karteMorningLine([{ day: d, metric: "karte:avg_len", value: 1 }]), null, "出る割合が無ければ出さない");
assert.ok(nightZeroCostSteps("x.json").some((s) => s.args[0] === "scripts/audit-customer-karte.ts" && s.args.includes("--write")), "晩の費用0の仕事");
// 2026-11-28 #664: 約束の一生は元の3本の後に lifecycle が同じ晩の json を読んで書く
{ const st = nightZeroCostSteps("m/x.json"); const i = (f: string) => st.findIndex((s) => s.args[0] === f); const life = st[i("scripts/audit-promise-lifecycle.ts")];
  assert.ok(i("scripts/audit-promise-kinds.ts") < i("scripts/audit-promise-lifecycle.ts") && i("scripts/audit-promise-kept.ts") < i("scripts/audit-promise-lifecycle.ts") && i("scripts/list-done-at-backfill.ts") < i("scripts/audit-promise-lifecycle.ts"));
  assert.deepEqual(life.args.slice(1), ["--kinds=m/x.json.promise-kinds.json", "--b1=m/x.json.promise-b1.json", "--done=m/x.json.promise-done.json", "--write"]); }
// 2026-11-28 #803 ①: 試験の効率の物差しは前の晩を --night で渡す（晩の初めに流すので既定だと今夜で空）
{ const st = nightZeroCostSteps("x.json").find((s) => s.args[0] === "scripts/audit-night-cost.ts"); assert.ok(st && st.args.includes("--write") && !st.args.includes("--write-items")); const n = st!.args.find((x) => x.startsWith("--night="))!.slice(8); assert.match(n, /^\d{4}-\d{2}-\d{2}$/); const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10); assert.ok(n < today, "前の晩（今日より前の日付）"); }
console.log("karte-morning ok 7");
