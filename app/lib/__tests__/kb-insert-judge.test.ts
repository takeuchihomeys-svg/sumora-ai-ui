// app/lib/__tests__/kb-insert-judge.test.ts — 設計知見を入れる時の統括（純関数）
import { parseKbJudge, canBeParent, kbJudgePrompt } from "../kb-insert-judge";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
t("読む", parseKbJudge('x {"rel":"child","why":"具体","resolve":null}')?.rel === "child");
t("知らない関係は読まない", parseKbJudge('{"rel":"maybe"}') === null);
t("ぶつかる時の解き方", parseKbJudge('{"rel":"conflict","why":"食い違い","resolve":"新しい決定が先"}')?.resolve === "新しい決定が先");
t("親の段の線", canBeParent({ id: "a", priority: 2 }, { id: "b", priority: 1 }) && !canBeParent({ id: "a", priority: 1 }, { id: "b", priority: 2 }) && !canBeParent({ id: "a", priority: 0 }, { id: "b", priority: 0 }) && !canBeParent({ id: "a", priority: 2 }, { id: "a", priority: 1 }));
t("指示に両方の行と近さ", /近さ 0\.80/.test(kbJudgePrompt({ id: "n", title: "新", insight: "x", priority: 2 }, { id: "o", title: "古", insight: "y", priority: 1 }, 0.8)));
console.log(`kb-insert-judge: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
