/**
 * 実行: npx tsx app/lib/__tests__/pro-cause-relearn.test.ts
 */
import { buildCauseRelearn } from "../pro-cause-relearn";

function ok(name: string, cond: boolean) {
  if (!cond) throw new Error("FAIL " + name);
  console.log("  ok", name);
}

console.log("pro-cause-relearn");

{
  const r = buildCauseRelearn({
    auditStatus: "started",
    filledNull: true,
    layoutOps: 0,
    searchOps: 1,
    auditExt: "2.8.90",
    diagnoseIds: ["property_path_break"],
    photoTodo: 28,
    hasPhotoLearnTask: false,
    foundationFails: [
      { id: "F1_screen_pos", line: "solid=0", next: "reflect復元" },
      { id: "F6_auto_after_bundle", line: "自動0件", next: "自動1回" },
      { id: "F32_link_pipeline", line: "止:画面位置", next: "画面位置を埋める" },
    ],
    foundationMissingN: 27,
    readCount: 2,
    autoAfter: false,
    reflectOk: 0,
    linkPipelineOk: false,
    stuckBeforeAcquire: true,
    acquireArmed: false,
    thinkMissingN: 4,
  });
  ok("開始前原因", r.atoms.some((a) => a.id === "c_before_acquire"));
  ok("学習課題抜け", r.atoms.some((a) => a.id === "c_photo_task_gap"));
  ok("土台Fが入る", r.atoms.some((a) => a.id.startsWith("c_f_")));
  ok("foundation_gapsあり", r.foundation_gaps.length >= 3);
  ok("人間思考7段", r.think_like_human.length === 7);
  ok("再学習行", /再学習/.test(r.relearn_line));
}

console.log("all ok");
