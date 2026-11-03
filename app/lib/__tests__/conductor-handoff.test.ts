// 実行: npx tsx app/lib/__tests__/conductor-handoff.test.ts
import { buildHandoff, handoffNote, handoffChecks, candidateRoles, rolesDigest, conductorHandoffOn, CONDUCTOR_PRIORITY_ORDER } from "../conductor-handoff";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }

it("既定 off・順は4つ", () => { ok(!conductorHandoffOn({})); ok(CONDUCTOR_PRIORITY_ORDER.length === 4); });
it("渡す形", () => {
  const h = buildHandoff({ to: "compose", meta: { action: null, checkpoint_stage: "proposing", main_point: "割引で15万に収まる物件", three_layer: { relief: "収まる理由" }, plan_ahead: { steps: ["見積書", "内覧調整"] } }, openPromises: ["募集状況の確認"] });
  ok(h.decided.action === "reply" && h.decided.nextStep === "見積書");
  const n = handoffNote(h);
  ok(n.includes("決まった事（決め直さない）: AIX か返信か: 返信") && n.includes("一番の要点: 割引で15万に収まる物件") && n.includes("あなたが決める事: 趣旨") && n.includes("【ぶつかった時の順】"), n);
});
it("確かめ: 落ち無し・AIX の無視・意図の落ち・読み直しの回り", () => {
  const g = handoffChecks({ deskAnswer: "estimate", finalAction: "estimate", mainPoint: "見積書", composeMain: "見積書をお送り致します" });
  ok(g.digest === "ax:ok|it:ok|bp:-|rc:0|ck:-", g.digest);
  const a = handoffChecks({ deskAnswer: "estimate", finalAction: "reply", mainPoint: "空室確認結果の報告", composeMain: "ご連絡ありがとうございます", recheckCount: 2, blueprintOk: false, checkFindings: 1 });
  ok(a.drops.join(",") === "aix_ignored,intent_lost,blueprint_drift,recheck_loop,check_ignored", a.drops.join(","));
  ok(handoffChecks({ deskAnswer: "estimate", finalAction: "reply", rechecked: true }).digest.startsWith("ax:rc"));
});
it("呼ぶ役の候補", () => {
  const r = candidateRoles({ ackOnly: true, finalAction: "reply" });
  ok(rolesDigest(r) === "wr" && r.skip.includes("compose"), rolesDigest(r));
  const r2 = candidateRoles({ finalAction: "estimate", confidence: "low", difficulty: "high", missing: ["sheet_detail"] });
  ok(rolesDigest(r2) === "ad,cp,wr,ck,fe,dp,s2", rolesDigest(r2));
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
