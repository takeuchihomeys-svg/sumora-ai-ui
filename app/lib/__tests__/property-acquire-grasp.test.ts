/**
 * 実行: npx tsx app/lib/__tests__/property-acquire-grasp.test.ts
 */
import { buildAcquireGraspReport } from "../property-acquire-grasp";

function ok(name: string, cond: boolean) {
  if (!cond) throw new Error("FAIL " + name);
  console.log("  ok", name);
}

console.log("property-acquire-grasp");

{
  const honoka = buildAcquireGraspReport({
    auditStatus: "started",
    searchArmed: false,
    fillDone: false,
    acquireStarted: false,
  });
  ok("HONOKAは開始前停止", honoka.stuck_before_acquire === true);
  ok("送付済み詰まりではない", honoka.stuck_on_sent === false);
  ok("原子に before_acquire", honoka.atoms.some((a) => a.id === "before_acquire"));
}

{
  const sentStuck = buildAcquireGraspReport({
    auditStatus: "finished",
    searchArmed: true,
    fillDone: true,
    acquireStarted: true,
    sentSkipped: 12,
    allowedN: 0,
    pressedSent: 0,
    stepText: "送付済みで飛ばした all-filtered 詰まった",
    timingKeys: ["auto_pdf_start"],
  });
  ok("送付済み詰まり疑い", sentStuck.stuck_on_sent === true);
}

{
  const okAllSent = buildAcquireGraspReport({
    auditStatus: "finished",
    searchArmed: true,
    fillDone: true,
    acquireStarted: true,
    sentSkipped: 8,
    sentMarked: 8,
    allowedN: 0,
    pressedSent: 0,
    stepText: "送付済み把握 all_sent → 次へ",
    timingKeys: ["acq_all_sent", "acq_page_done", "auto_next_page"],
  });
  ok("全部送付済でも把握できていれば詰まりではない", okAllSent.stuck_on_sent === false);
  ok("sent_grasped", okAllSent.sent_grasped === true);
}

console.log("all ok");
