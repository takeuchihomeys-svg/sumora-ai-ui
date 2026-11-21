// 当たる問題だけ積む（scripts/lib/exam-filled.ts）
// 実行: npx tsx scripts/lib/__tests__/exam-filled.test.ts（全 PASS で exit 0）
import { filledRowsOf, problemsHitBySwitches, rowsOfSwitch } from "../exam-filled";
import type { LinkageRow } from "../../../app/lib/linkage-map";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };
const row = (id: string, path: string | null, switches: string[], readerSwitches: string[] = []): LinkageRow => ({ id, stage: "read", name: id, producer: "", key: "", readers: [], switches, readerSwitches, fill: path ? { src: "meta", path } : { src: "none", why: "" }, owner: "", layer: "連携", next: "" } as LinkageRow);
const rows = [row("a", "situation_now.asks", ["SW_A"]), row("b", "focus", ["SW_B"], ["SW_P"]), row("c", null, ["SW_C"])];

ok("meta で埋まった行だけ", JSON.stringify(filledRowsOf({ situation_now: { asks: ["x"] }, focus: "" }, rows)) === JSON.stringify(["a"]));
ok("meta が無ければ空", filledRowsOf(null, rows).length === 0);
ok("スイッチ→行（作る側・読む側の親）", JSON.stringify(rowsOfSwitch("SW_P", rows)) === JSON.stringify(["b"]) && JSON.stringify(rowsOfSwitch("SW_A", rows)) === JSON.stringify(["a"]));
const r = problemsHitBySwitches(["SW_A"], { q1: ["a"], q2: ["b"], q3: undefined }, ["q1", "q2", "q3"], rows);
ok("当たる・当たらない・記録なしは残す", r.hit.join() === "q1" && r.skip.join() === "q2" && r.unknown.join() === "q3", r);
const u = problemsHitBySwitches(["SW_A", "SW_Z"], { q1: ["a"], q2: ["b"] }, ["q1", "q2"], rows);
ok("地図に無いスイッチがあれば落とさない（安全側）", u.unmapped.join() === "SW_Z" && u.skip.length === 0 && u.unknown.length === 2, u);
console.log(`exam-filled: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
