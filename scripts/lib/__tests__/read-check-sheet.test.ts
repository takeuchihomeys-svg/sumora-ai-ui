// scripts/lib/__tests__/read-check-sheet.test.ts — 2026-11-22 作業員K2（#441・読みの細かさの点検の印の数え）
//   実行: npx tsx scripts/lib/__tests__/read-check-sheet.test.ts
import { tallyMarks } from "../../read-check-sheet";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
const r = tallyMarks([
  { turnId: 1, conv8: "a", marks: [{ kind: "coarse", field: "current property" }, { kind: "unused", field: "our_items.promise" }] },
  { turnId: 2, conv8: "b", marks: [{ kind: "coarse", field: "current property" }, { kind: "bogus" as never, field: "x" }] },
]);
t("同じ種類×欄は1つの鍵にまとめて数える（空白は _）", r[0].key === "read-check:coarse:current_property" && r[0].n === 2 && r[0].turns.join(",") === "1,2", r);
t("知らない種類は数えない", !r.some((x) => x.field === "x"), r);
t("2つの鍵", r.length === 2, r);
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
