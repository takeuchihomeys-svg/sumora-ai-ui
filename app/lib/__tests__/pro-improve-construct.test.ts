/**
 * 実行: npx tsx app/lib/__tests__/pro-improve-construct.test.ts
 */
import { buildImproveConstruct } from "../pro-improve-construct";

function ok(name: string, cond: boolean) {
  if (!cond) throw new Error("FAIL " + name);
  console.log("  ok", name);
}

console.log("pro-improve-construct");

{
  const r = buildImproveConstruct({
    learnedOk: 100,
    photoTodo: 28,
    hasPhotoLearnTask: false,
    stuckBeforeAcquire: true,
    acquireArmed: false,
    acquireSentGrasped: false,
    autoAfter: false,
    mechanismApplied: false,
  });
  ok("志向が7本", r.orientations.length === 7);
  ok("学習課題欠", r.gaps.some((g) => g.id === "g_learn_task"));
  ok("armed仕組み欠", r.gaps.some((g) => g.id === "g_armed_mech"));
  ok("自動1回欠", r.gaps.some((g) => g.id === "g_auto_after"));
  ok("次構築がある", r.next_construct.length > 10);
  ok("pathに自動", /自動/.test(r.path_line));
}

{
  const r = buildImproveConstruct({
    learnedOk: 50,
    photoTodo: 0,
    hasPhotoLearnTask: true,
    readCount: 2,
    autoAfter: true,
    reflectOk: 1,
    thinkMissingN: 0,
    acquireArmed: true,
    acquireSentGrasped: true,
    stuckBeforeAcquire: false,
    mechanismApplied: true,
  });
  ok("揃えば欠は少ない", r.gaps.length <= 1);
}

console.log("all ok");
