// scripts/__tests__/desk-shadow.test.ts — 統括・相談（shadow）とスタッフの一致の数え方
//   実行: npx tsx scripts/__tests__/desk-shadow.test.ts
import { tallyDeskAgreement, type DeskRow } from "../lib/desk-shadow-core";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const R = (o: Partial<DeskRow>): DeskRow => ({ conversation_id: "c", created_at: "x", suggested_action: null, actual_aix_type: null, actual_at: "y", ...o });
const t1 = tallyDeskAgreement([
  R({ ad: { brain: "estimate_sheet/single", pick: null, sb: "promise" }, actual_aix_type: null }),
  R({ ad: { brain: "estimate_sheet/single", pick: null, sb: "promise" }, actual_aix_type: "estimate_sheet" }),
  R({ ad: { brain: "estimate_sheet/single", pick: "estimate_sheet/single", sb: null }, actual_aix_type: "estimate_sheet" }),
  R({ ad: { brain: "estimate_sheet/single", pick: "property_check_result/available", sb: null }, actual_aix_type: "property_check_result" }),
  R({ ad: { brain: "x", pick: null, sb: null, skip: "候補1つ" } }),
  R({ ad: { brain: "estimate_sheet/single", pick: null, sb: null }, actual_at: null }),
  R({ ac: { answer: "keep" }, actual_aix_type: null }),
]);
const get = (k: string) => t1.commander.find((x) => x.k === k);
t("promise: 押さなかった番は合う・押した番は合わない", get("差し戻し promise")?.known === 2 && get("差し戻し promise")?.agree === 1);
t("同じ: ブレインと同じボタンを押せば合う・答えが分からない番は数だけ", get("同じ")?.n === 2 && get("同じ")?.known === 1 && get("同じ")?.agree === 1);
t("違う札: その札のボタンを押せば合う", get("違う札")?.agree === 1);
t("skip は数えない", t1.commander.reduce((a, x) => a + x.n, 0) === 5);
t("相談 keep: 押さなければ合う", t1.consult[0]?.k.startsWith("keep") && t1.consult[0].agree === 1);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
