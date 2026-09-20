// app/lib/__tests__/reply-gen-gate.test.ts
// 実行: npx tsx app/lib/__tests__/reply-gen-gate.test.ts（自己完結ハーネス。全 PASS で exit 0）
//
// 2026-09-20 竹内
//   「ステータス申込以降は別の管理ツールで LINE しているので返信生成しなくて良い」
//   「審査落ちて物件提案中に戻るときあるからその時はまた生成するようにする」
//
// ＝ **ステータスだけで決まる**。戻れば次の生成から自動でまた作られる（復帰の仕組みは要らない）。
// 判定表は conversation-status.ts の DRAFT_SKIP_STATUSES 1か所で、
// AIX の判断（resolveReplyAixDecision）・差分学習（analyze-diffs）・返信生成（generate-reply）が同じ物を見る。
import { DRAFT_SKIP_STATUSES, BRAIN_SKIP_STATUSES } from "../conversation-status";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} got ${JSON.stringify(actual)}`); } };
}

console.log("\n── ★ 申込以降は返信生成しない（竹内 2026-09-20）──");

it("★ 申込・審査・契約・成約では下書きを作らない", () => {
  for (const s of ["applying", "application", "screening", "contract", "closed_won"]) {
    if (!DRAFT_SKIP_STATUSES.has(s)) throw new Error(`${s} が止まっていない`);
  }
});

it("★ 失注・承認済みでも作らない（既存の定義のまま）", () => {
  for (const s of ["closed_lost", "lost", "approved"]) {
    if (!DRAFT_SKIP_STATUSES.has(s)) throw new Error(`${s} が止まっていない`);
  }
});

console.log("\n── ★ 審査落ちで戻ったら、また作る（竹内「その時はまた生成する」）──");

it("★ 物件提案中・内覧・ヒアリングでは作る", () => {
  for (const s of ["proposing", "property_recommendation", "viewing", "hearing", "condition_hearing", "first_reply"]) {
    if (DRAFT_SKIP_STATUSES.has(s)) throw new Error(`${s} で止まってしまう`);
  }
});

it("★ 判定はステータスだけ — 「申込を経験したか」は見ない（戻ったら自動で再開する）", () => {
  // applying → 審査落ち → proposing に戻す、という実際の流れをなぞる
  const flow = ["hearing", "proposing", "applying", "screening", "proposing", "viewing"];
  const gen = flow.map((s) => (DRAFT_SKIP_STATUSES.has(s) ? "止" : "作"));
  expect(gen.join("")).toBe("作作止止作作");
});

console.log("\n── 表が1か所であること（四者同名）──");

it("★ ブレインの分析は申込・審査でも続ける（下書きだけ止める）", () => {
  // BRAIN_SKIP_STATUSES に applying/screening は入れない
  //   （コメント: 全成約が通過する申込フェーズのため brain 分析対象。平均42日・169件の学習例あり）
  for (const s of ["applying", "screening"]) {
    if (BRAIN_SKIP_STATUSES.includes(s)) throw new Error(`${s} でブレインまで止まっている`);
  }
});

it("成約・終了はブレインも下書きも止める", () => {
  for (const s of ["contract", "closed_won", "closed_lost", "lost", "approved"]) {
    if (!BRAIN_SKIP_STATUSES.includes(s)) throw new Error(`${s} がブレインで止まっていない`);
    if (!DRAFT_SKIP_STATUSES.has(s)) throw new Error(`${s} が下書きで止まっていない`);
  }
});

it("空・未知のステータスでは止めない（知らない値で黙って生成を止めない）", () => {
  for (const s of ["", "unknown", "新しい状態"]) {
    if (DRAFT_SKIP_STATUSES.has(s)) throw new Error(`${s} で止まってしまう`);
  }
});

console.log(`\n${failed === 0 ? "✅ 全 PASS" : "❌ 失敗あり"}  ${passed} passed / ${failed} failed`);
if (failed) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
