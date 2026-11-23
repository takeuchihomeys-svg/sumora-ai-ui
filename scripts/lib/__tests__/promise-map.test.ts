// npx tsx scripts/lib/__tests__/promise-map.test.ts
// 2026-11-23 作業員L: 「約束」の分野の地図（根 promise:kept_true）の純関数
import assert from "node:assert/strict";
import { promiseMapTurns, buildPromiseTree, promiseMissCause, promiseFoundationRows, PROMISE_MAP_ROOT, type PromiseMapRow } from "../promise-map";

const rows: PromiseMapRow[] = [
  { conv: "a", at: "t1", kind: "pickup", writer: "takeuchi", state: "in_time", scene: "conditions" },
  { conv: "b", at: "t2", kind: "pickup", writer: "takeuchi", state: "overdue", scene: "conditions" },
  { conv: "c", at: "t3", kind: "pickup", writer: "takeuchi", state: "late", scene: "conditions" },
  { conv: "d", at: "t4", kind: "check", writer: "takeuchi", state: "overdue", scene: "question" },
  { conv: "e", at: "t5", kind: "pickup", writer: "employee", state: "overdue", scene: "conditions" }, // 従業員は数えない
  { conv: "f", at: "t6", kind: "other", writer: "takeuchi", state: "n/a", scene: "other" }, // 判定なしは数えない
  { conv: "g", at: "t7", kind: "pickup", writer: "takeuchi", state: "pending", scene: "other" }, // 期限前は数えない
];
// 原因の4つ
assert.equal(promiseMissCause({ kind: "pickup" }, undefined), "material");
assert.equal(promiseMissCause({ kind: "pickup" }, { ledgerKind: null, ledgerClosed: false, calendarDone: null }), "material");
assert.equal(promiseMissCause({ kind: "pickup", state: "overdue" }, { ledgerKind: "pickup_declared", ledgerClosed: false, calendarDone: true }), "counting");
assert.equal(promiseMissCause({ kind: "pickup", state: "late" }, { ledgerKind: "pickup_declared", ledgerClosed: true, calendarDone: true }), "judgment");
assert.equal(promiseMissCause({ kind: "check" }, { ledgerKind: "pickup_declared", ledgerClosed: false, calendarDone: false }), "misread");
assert.equal(promiseMissCause({ kind: "pickup" }, { ledgerKind: "pickup_declared", ledgerClosed: false, calendarDone: false }), "judgment");
const ev = { b: { ledgerKind: "pickup_declared", ledgerClosed: false, calendarDone: false }, c: { ledgerKind: "pickup_declared", ledgerClosed: true, calendarDone: null } } as Record<string, { ledgerKind: string; ledgerClosed: boolean; calendarDone: boolean | null }>;
const turns = promiseMapTurns(rows, (r) => ev[r.conv]);
assert.deepEqual(turns.map((t) => `${t.id}:${t.miss}:${t.cause}`), ["a@t1:ok:null", "b@t2:overdue:judgment", "c@t3:late:judgment", "d@t4:overdue:material"]);
const nodes = buildPromiseTree(turns);
assert.equal(nodes[0].key, PROMISE_MAP_ROOT); assert.deepEqual([nodes[0].n, nodes[0].ok, nodes[0].value], [4, 1, 25]);
// 子を足すと親に戻る・一致の葉には原因の子が無い
const kids = nodes.filter((x) => x.parent === PROMISE_MAP_ROOT);
assert.equal(kids.reduce((a, x) => a + x.n, 0), 4);
assert.equal(nodes.some((x) => x.parent?.endsWith("miss=ok")), false);
assert.ok(nodes.some((x) => x.key === "promise:kept_true/kind=pickup/scene=conditions/miss=overdue/cause=judgment"));
// 土台の表: 判定のある種類は物差し ok・スイッチ on で材料 ok
const tab = promiseFoundationRows(nodes, { kbKinds: new Set(["pickup"]), examKinds: new Set(), overdueMaterialOn: true });
const pk = tab.find((t) => t.leaf.endsWith("kind=pickup/scene=conditions"))!;
assert.deepEqual([pk.rule, pk.material, pk.measure, pk.exam], ["ok", "ok", "ok", "gap"]);
assert.match(pk.deliveredToBrain, /届く/);
console.log("promise-map: ok");
