// 2026-10-18 竹内さん 10/18 OK「毎晩の自己点検を朝の報告に載せる」: 表に書く行の作り方のテスト（DB に触れない）
// 実行: npx tsx scripts/lib/__tests__/brain-self-review-db.test.ts
import { bundleKeyOf, runRowOf, proposalRowOf, selfReviewDbEnabled } from "../brain-self-review-db";
import type { Bundle, CaseResult } from "../brain-self-review";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const b = (o: Partial<Bundle>): Bundle => ({ kind: "材料をつなぐ", where: "材料に無かった", causeKeys: ["会社の事実の欠落"], plans: ["事実を足す"], targets: ["company-facts"], ids: ["q101"], cases: ["exam:q101"], kb: [{ id: "94cc340a-0000-4000-8000-000000000000", title: "t", n: 1 }], needsTakeuchi: false, questions: [], n: 2, ...o });

it("束の鍵は 種類|場所|原因の芯（語尾の型は外す）", () => {
  ok(bundleKeyOf(b({})) === "材料をつなぐ|材料に無かった|会社の事実", bundleKeyOf(b({})));
  ok(bundleKeyOf(b({ causeKeys: ["会社の事実の不足"] })) === bundleKeyOf(b({})), "語尾違いで別の鍵");
});
it("1日1行: 朝の1行・案の数・聞く事（重ねない・5まで）", () => {
  const results = [{ caseId: "exam:q101" }, { caseId: "exam:q102" }] as unknown as CaseResult[];
  const bundles = [b({}), b({ kind: "竹内さんに聞く", needsTakeuchi: true, questions: ["鍵は前倒しで渡せる？", "鍵は前倒しで渡せる？"] })];
  const r = runRowOf({ day: "2026-10-19", line: "🧠 自己点検 2026-10-19: 説明 2件", results, bundles, usd: 0.04321 });
  ok(r.explained === 2 && r.proposals === 2 && r.ask_count === 1, JSON.stringify(r));
  ok(r.questions.length === 1 && r.top_cause!.startsWith("会社の事実の欠落→材料をつなぐ"), JSON.stringify(r));
  ok(r.usd === 0.0432, String(r.usd));
});
it("案の行: 前の行と足す・同じ日を流し直しても二重に数えない・決定は書かない", () => {
  const first = proposalRowOf(b({ n: 2 }), "2026-10-19", null);
  ok(first.n === 2 && first.first_seen === "2026-10-19", JSON.stringify(first));
  const again = proposalRowOf(b({ n: 3 }), "2026-10-19", first);
  ok(again.n === 3, `同じ日は上書き ${again.n}`);
  const next = proposalRowOf(b({ n: 1, ids: ["q150"] }), "2026-10-20", again);
  ok(next.n === 4 && next.first_seen === "2026-10-19" && next.last_seen === "2026-10-20", JSON.stringify(next));
  ok(next.problem_ids.includes("q101") && next.problem_ids.includes("q150"), "問題の和");
  ok(!("status" in next) && !("decision" in next), "決定を書いている");
  ok(proposalRowOf(b({ kb: [{ id: "abc", title: "", n: 1 }] }), "2026-10-19", null).kb_ids.length === 0, "uuid でない id を入れた");
});
it("止める BRAIN_SELF_REVIEW_DB=off", () => {
  ok(!selfReviewDbEnabled({ BRAIN_SELF_REVIEW_DB: "off" }) && selfReviewDbEnabled({}), "スイッチ");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
