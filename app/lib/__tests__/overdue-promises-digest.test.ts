// npx tsx app/lib/__tests__/overdue-promises-digest.test.ts
// 2026-11-23 作業員L（台帳 #659）: 統括の材料に渡した期日超えの約束の記録（digest の op）・その番の一手が果たす一手か・次の番のブレインは読まない
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { overduePromisesRecOf, overduePromisesDigest, parseOverduePromisesDigest, fulfilsOverduePromise, overduePromisesDigestOn } from "../conductor-overdue-promises";
import { brainDecisionDigestExtra } from "../brain-decision-ledger";

assert.equal(overduePromisesDigestOn({}), true);
assert.equal(overduePromisesDigestOn({ OVERDUE_PROMISES_DIGEST: "off" }), false);
// 果たす一手: ピックアップ←物件の AIX・確認←物件確認した・見積←見積書
const list = [{ kind: "pickup" }, { kind: "check" }];
assert.equal(fulfilsOverduePromise(list, "property_send"), true);
assert.equal(fulfilsOverduePromise(list, "property_check_result"), true);
assert.equal(fulfilsOverduePromise(list, "estimate_sheet"), false);
assert.equal(fulfilsOverduePromise(list, null), false); // 返信の番
assert.equal(fulfilsOverduePromise([{ kind: "estimate" }], "estimate_sheet"), true);
// meta の形・digest の op
const rec = overduePromisesRecOf(list, "property_send")!;
assert.deepEqual(rec, { n: 2, kinds: ["check", "pickup"], fulfil: true });
assert.equal(overduePromisesDigest(rec), "2|check+pickup|1");
assert.equal(overduePromisesRecOf([], "property_send"), null);
assert.equal(overduePromisesDigest({ n: 0, kinds: [] }), null);
assert.deepEqual(parseOverduePromisesDigest("2|check+pickup|1"), rec);
assert.equal(parseOverduePromisesDigest("bad"), null);
// 判断の記録の digest に op が入る（止めると入らない）
assert.equal((brainDecisionDigestExtra({ overdue_promises: { n: 1, kinds: ["pickup"], fulfil: false } }, {}) as Record<string, unknown>).odp, "1|pickup|0");
assert.equal((brainDecisionDigestExtra({ overdue_promises: { n: 1, kinds: ["pickup"], fulfil: false } }, { OVERDUE_PROMISES_DIGEST: "off" }) as Record<string, unknown>).odp, undefined);
assert.equal((brainDecisionDigestExtra({}, {}) as Record<string, unknown>).odp, undefined);
// 次の番のブレインは読まない: brain-core が前の番の meta（prevMeta）・digest から overdue_promises・op を読む所が無い
const core = readFileSync(join(__dirname, "../brain-core.ts"), "utf8");
assert.equal(/prevMeta[^\n]{0,80}overdue_promises|digest[^\n]{0,40}\.op\b|\bop:\s*parseOverduePromisesDigest/.test(core), false);
assert.equal((core.match(/overdue_promises/g) ?? []).length <= 3, true); // 型の宣言・meta に書く所・その説明だけ
console.log("overdue-promises-digest: ok");
// 物差し（use_rate）
import { overdueUseSummary } from "../conductor-overdue-promises";
{
  const s = overdueUseSummary(["2|check+pickup|1", "1|pickup|0", "bad", null]);
  assert.deepEqual([s.given, s.fulfil, s.useRate], [2, 1, 50]);
  assert.deepEqual(s.byKind.pickup, { given: 2, fulfil: 1 });
  assert.deepEqual(s.byKind.check, { given: 1, fulfil: 1 });
  assert.equal(overdueUseSummary([]).useRate, null);
}
console.log("overdue-use-summary: ok");
// 2026-11-25 作業員L: 返信の書き出し（op）を上書きしない
{ const d = brainDecisionDigestExtra({ overdue_promises: { n: 1, kinds: ["pickup"], fulfil: false } }, {}) as Record<string, unknown>; assert.equal(d.op, undefined, "op は返信の書き出しの鍵"); }
console.log("overdue odp: ok");
