// 実行: npx tsx app/lib/__tests__/exam-handoff.test.ts
import { scoreHandoffRow, summarize } from "../../../scripts/exam-handoff";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }

it("落ち無し", () => {
  const r = scoreHandoffRow({ id: "q1", brain: { action: "estimate", reply_mode: "aix", aix_desk: { pick: "estimate" }, main_point: "見積書" }, compose: "compose: 趣旨=inform 設計図から外れ=なし メイン=見積書をお送り", draft: "見積書をお送り致します" });
  ok(r.drops.length === 0 && r.digest === "ax:ok|it:ok|bp:ok|rc:0|ck:-", r.digest);
});
it("AIX の答えの無視・意図の落ち・設計図から外れ", () => {
  const r = scoreHandoffRow({ id: "q2", brain: { action: null, aix_recheck: { kind: "aix", key: "property_check_result" }, main_point: "空室確認結果の報告" }, compose: "compose: 設計図から外れ=頼んでいない誘い", draft: "ご連絡ありがとうございます" });
  ok(r.drops.includes("aix_ignored") && r.drops.includes("intent_lost") && r.drops.includes("blueprint_drift"), r.drops.join(","));
});
it("読み直しを通った時は無視にしない・2回で回り", () => {
  const r = scoreHandoffRow({ id: "q3", brain: { action: null, aix_recheck: { kind: "aix", key: "estimate" }, recheck_digest: "2/3:aix_desk.aix" } });
  ok(r.digest.startsWith("ax:rc") && r.drops.includes("recheck_loop") && !r.drops.includes("aix_ignored"), r.digest);
});
it("欄が無ければ落ちにしない・集計", () => {
  const r = scoreHandoffRow({ id: "q4" });
  ok(r.drops.length === 0 && r.digest === "ax:-|it:-|bp:-|rc:0|ck:-", r.digest);
  const s = summarize([r, scoreHandoffRow({ id: "q5", brain: { action: "estimate", reply_mode: "aix", aix_desk: { pick: "viewing_invite" } } })]);
  ok(s.n === 2 && s.anyDrop === 1 && s.byDrop.aix_ignored === 1);
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
