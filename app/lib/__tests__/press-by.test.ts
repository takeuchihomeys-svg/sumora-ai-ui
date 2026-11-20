// npx tsx app/lib/__tests__/press-by.test.ts
// 2.8.152（2026-11-20 竹内さん「自動か手動かもちゃんと判断するようにする」）
import { isAutoMode, pointBy, opBy, pointFieldsBy, rowHasPointBy } from "../press-by";
import { auditHumanLike } from "../human-like-audit";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log("✓", name); }
  else { fail++; console.log("✗", name, detail !== undefined ? JSON.stringify(detail) : ""); }
};

console.log("■ モード");
ok("aix / ai / auto / brain_aix は自動", ["aix", "ai", "auto", "brain_aix", "BRAIN_X"].every(isAutoMode));
ok("normal・空・null は自動でない", ![("normal"), "", null, undefined].some(isAutoMode));

console.log("■ 押し1回");
ok("by:auto は自動", pointBy({ x: 0.1, y: 0.2, by: "auto" }) === "auto");
ok("syn:true（合成クリック）は自動", pointBy({ x: 0.1, syn: true }) === "auto");
ok("by が無い旧記録は人（isTrusted だけの rec から来た物）", pointBy({ x: 0.1, y: 0.2 }) === "human");
ok("by:human は人", pointBy({ by: "human" }) === "human");
ok("操作の by が無ければ分からない（null）", opBy({ k: "click" }) === null && opBy({ by: "auto" }) === "auto" && opBy({ by: "human" }) === "human");

const pf = { a: { n: 1, x: 0.1, y: 0.1 }, b: { n: 1, x: 0.5, y: 0.5, by: "auto" }, c: { n: 1, by: "human" } };
ok("人の欄だけ", Object.keys(pointFieldsBy(pf, "human")).join(",") === "a,c");
ok("自動の欄だけ", Object.keys(pointFieldsBy(pf, "auto")).join(",") === "b");
ok("自動の欄が無い行", rowHasPointBy({ a: { x: 0.1 } }, "auto") === false && rowHasPointBy(null, "auto") === false);

console.log("■ 自動モードの点検（押した位置は拡張の押しだけ数える）");
const rows = [
  { point_fields: { a: { n: 1, x: 0.1, y: 0.1 } }, shot_ops: [{ t: 1, k: "click", f: "a", by: "human", cs: "pointer" }] },
  { point_fields: { b: { n: 1, x: 0.5, y: 0.5, by: "auto" } }, shot_ops: [{ t: 2, k: "click", f: "b", by: "auto", cs: "pointer" }] },
  { point_fields: {}, shot_ops: [{ t: 3, k: "click", f: "c", by: "auto" }] },
];
const all = auditHumanLike(rows);
const auto = auditHumanLike(rows, { pressBy: "auto" });
ok("今まで通り（指定なし）は位置のある行を全部数える", all.withPoint === 2, all.withPoint);
ok("自動だけ: 人が押した位置の行は数えない", auto.withPoint === 1, auto.withPoint);
ok("自動だけ: 手の形も人の押しは数えない", auto.handCursorClicks === 1 && all.handCursorClicks === 2, { a: auto.handCursorClicks, b: all.handCursorClicks });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
