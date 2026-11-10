// 試験の守りの問題の自動の足し（scripts/lib/exam-guards.ts）の単体テスト（LLM も DB も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-guards.test.ts（全 PASS で exit 0）
import { chooseGuards, fitGuardsToCap, guardLine } from "../exam-guards";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

const v = (x: number, y: number) => [x, y, 0];
const cards = [
  { id: "q1", stage: "brain" as const, embedding: v(1, 0) },          // 狙い
  { id: "q2", stage: "brain" as const, embedding: v(0.99, 0.1) },     // とても近い・前を作る
  { id: "q3", stage: "brain" as const, embedding: v(0.9, 0.4) },      // 近い・夜の基準あり
  { id: "q4", stage: "draft" as const, embedding: v(0.8, 0.6) },      // 少し近い・夜の基準あり・安定
  { id: "q5", stage: "brain" as const, embedding: v(0, 1) },          // 遠い
  { id: "q6", stage: "brain" as const, embedding: null },             // 札が無い
];
const g = chooseGuards({ targets: ["q1"], cards, nightlyIds: new Set(["q3", "q4"]), stableIds: new Set(["q4"]) });
ok("使い回せる問題を最優先（近さより先）・2問", g.map((x) => x.id).join(",") === "q4,q3" && g[0].reusable && g[0].stable, JSON.stringify(g));
ok("使い回せる問題が無い時だけ前を作る問題", chooseGuards({ targets: ["q1"], cards, nightlyIds: new Set(), stableIds: new Set() }).map((x) => x.id).join(",") === "q2,q3");
ok("遠い・札の無い・狙いの問題は入れない", !g.some((x) => ["q1", "q5", "q6"].includes(x.id)));
ok("下書きの段の依頼は下書きの札だけ", chooseGuards({ targets: ["q1"], cards, nightlyIds: new Set(), stableIds: new Set(), stage: "draft" }).map((x) => x.id).join(",") === "q4");
ok("狙いの札が無ければ足さない", chooseGuards({ targets: ["q6"], cards, nightlyIds: new Set(), stableIds: new Set() }).length === 0);
// 上限: 前を作る守りは2回分で数える。入らない時は後ろから外す
const two = chooseGuards({ targets: ["q1"], cards, nightlyIds: new Set(), stableIds: new Set() }); // 前を作る2問＝$0.12
ok("上限に入らない時は1問に減らす（依頼の上限は変えない）", fitGuardsToCap(two, { capUsd: 0.3, baseUsd: 0.2, unitUsd: 0.03 }).length === 1 && fitGuardsToCap(two, { capUsd: 0.3, baseUsd: 0.29, unitUsd: 0.03 }).length === 1 && fitGuardsToCap(two, { capUsd: null, baseUsd: 9, unitUsd: 0.03 }).length === 2);
ok("計画の1行", guardLine(g, 0.03).startsWith("守り +2問（q4 夜の基準あり・安定") && guardLine(g, 0.03).includes("見込み +$0.06") && guardLine([], 0.03) === "守り なし", guardLine(g, 0.03));

// 2026-11-10 作業員8b: 夜の基準に前がある守りは上限に数えない・1問は必ず残す（11/07 以降 守りが付いた依頼 0本）
{
  const mk = (id: string, reusable: boolean) => ({ id, sim: 0.5, reusable, stable: true, why: "" });
  const r = fitGuardsToCap([mk("a", true), mk("b", true)], { capUsd: 0.1, baseUsd: 0.1, unitUsd: 0.03 });
  ok("使い回せる守りは上限ちょうどでも2問とも残る", r.length === 2, JSON.stringify(r));
  const m = fitGuardsToCap([mk("x", false), mk("a", true)], { capUsd: 0.1, baseUsd: 0.1, unitUsd: 0.03 });
  ok("前を作る守りから外し、使い回せる守りを残す", m.map((g) => g.id).join(",") === "a", JSON.stringify(m));
  ok("依頼だけで上限を超えていても、使い回せる守りは2問とも残る（11/10 on2-bb-p1 の形）", fitGuardsToCap([mk("a", true), mk("b", true)], { capUsd: 0.4, baseUsd: 0.48, unitUsd: 0.03 }).length === 2);
  ok("前を作る守りだけでも1問は残す", fitGuardsToCap([mk("x", false), mk("y", false)], { capUsd: 0.1, baseUsd: 0.5, unitUsd: 0.03 }).length === 1);
}
console.log(`${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
