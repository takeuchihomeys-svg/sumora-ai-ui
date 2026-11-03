// app/lib/__tests__/rollout-watch.test.ts — 段階のスイッチの夜の見張りの判断
//   実行: npx tsx app/lib/__tests__/rollout-watch.test.ts
import { decideRollout, watchedSwitches, isMatchVerdict, isJudgedVerdict, rolloutWatchMode } from "../rollout-watch";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const pct10 = { kind: "pct", pct: 10 } as const, all = { kind: "all" } as const;
t("6pt 下がれば pct:10 → yuma", (() => { const d = decideRollout({ name: "X", stage: pct10, on: { n: 50, match: 30 }, off: { n: 50, match: 33 }, mode: "pct" }); return d.action === "down" && d.to === "yuma" && d.dropPt === 6; })());
t("4pt なら残す", decideRollout({ name: "X", stage: pct10, on: { n: 50, match: 31 }, off: { n: 50, match: 33 }, mode: "pct" }).action === "keep");
t("数が足りなければ戻さない", decideRollout({ name: "X", stage: pct10, on: { n: 19, match: 0 }, off: { n: 50, match: 40 }, mode: "pct" }).action === "thin");
t("all の前後比べは線 8pt（6pt は残す）", decideRollout({ name: "X", stage: all, on: { n: 50, match: 30 }, off: { n: 50, match: 33 }, mode: "all_change" }).action === "keep");
t("all の前後比べで 10pt 下がれば pct:50", decideRollout({ name: "X", stage: all, on: { n: 50, match: 28 }, off: { n: 50, match: 33 }, mode: "all_change" }).to === "pct:50");
t("良くなった時は残す", decideRollout({ name: "X", stage: pct10, on: { n: 50, match: 45 }, off: { n: 50, match: 30 }, mode: "pct" }).action === "keep");
t("見張る名前は pct・all の _STAGE だけ", watchedSwitches({ A_STAGE: "pct:10", B_STAGE: "yuma", C_STAGE: "all", D: "on", E_STAGE: "off" }).join(",") === "A,C");
t("一致は same・same_meaning", isMatchVerdict("same") && isMatchVerdict("same_meaning") && !isMatchVerdict("partial"));
t("na・未判定は数えない", !isJudgedVerdict("na") && !isJudgedVerdict(null) && isJudgedVerdict("different"));
t("既定 off", rolloutWatchMode({}) === "off" && rolloutWatchMode({ ROLLOUT_WATCH: "dry" }) === "dry");
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
