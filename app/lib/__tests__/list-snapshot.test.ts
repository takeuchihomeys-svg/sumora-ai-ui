// 一覧の端末の控え（2026-10-28）のテスト
// 実行: npx tsx app/lib/__tests__/list-snapshot.test.ts
import { saveListSnapshot, loadListSnapshot, listSnapshotOn, LIST_SNAPSHOT_KEY, LIST_SNAPSHOT_ROWS } from "../list-snapshot";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, d?: unknown) => { if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${JSON.stringify(d)}`); } };
const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m }; };
const s = mem();
const rows = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, customer_name: "x" }));
t("保存できる・上限40件", saveListSnapshot(s, rows, 1000) && (loadListSnapshot<{ id: string }>(s, 2000) ?? []).length === LIST_SNAPSHOT_ROWS);
t("24時間を超えたら捨てて null", loadListSnapshot(s, 1000 + 24 * 3600_000 + 1) === null && !s.m.has(LIST_SNAPSHOT_KEY));
const s2 = mem(); s2.setItem(LIST_SNAPSHOT_KEY, "{壊れた");
t("壊れていたら null", loadListSnapshot(s2, 0) === null);
t("保存先が無い・行が無い時は何もしない", !saveListSnapshot(null, rows) && !saveListSnapshot(mem(), []));
const s3 = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
t("保存に失敗しても投げない", saveListSnapshot(s3, rows) === false);
t("スイッチは既定 off", !listSnapshotOn(undefined) && listSnapshotOn("on"));
console.log(`\n${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);
