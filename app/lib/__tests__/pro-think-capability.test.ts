/**
 * 統括Pro思考能力
 * 実行: npx tsx app/lib/__tests__/pro-think-capability.test.ts
 */
import { buildProThinkCapability } from "../pro-think-capability";

function ok(name: string, cond: boolean) {
  if (!cond) throw new Error("FAIL " + name);
  console.log("  ok", name);
}

console.log("pro-think-capability");

{
  const thin = buildProThinkCapability({
    photoInStorage: 0,
    learnedOk: 0,
    todo: 0,
    visionBottleneckN: 1,
    visionLine: "写真が無い",
  });
  ok("材料薄い時も骨格がある", thin.think_order.length >= 5);
  ok("画像学習 done=null か false", thin.image_learn.done !== true);
}

{
  const mid = buildProThinkCapability({
    photoInStorage: 9000,
    learnedOk: 400,
    todo: 80,
    photoKindsN: 0,
    hasPhotoLearnTask: false,
    kindConflictN: 4,
    kindConflictFields: ["rental_cost1", "update_date", "×とじる", "確定してリストへ"],
    photoVsRecordN: 3,
    photoVsRecordFields: ["rental_cost1", "rental_cost2", "square_meter_l"],
    centerOnlyPosN: 20,
    solidPosN: 0,
    readCount: 0,
    autoAfter: false,
  });
  ok("画像学習は途中", mid.image_learn.done === false);
  ok("未読なのに課題無しを欠に出す", mid.missing.some((m) => m.id === "photo_learn_task"));
  ok("種類未到達を欠に出す", mid.missing.some((m) => m.id === "kinds_reach"));
  ok("位置細部を欠に出す", mid.missing.some((m) => m.id === "pos_detail"));
  ok("既知selectは position facet", mid.fine_atoms.some((a) => a.field === "rental_cost1" && a.facet === "position"));
  ok("強化と改善の両方がある", mid.strengthen.length >= 1 && mid.improve.length >= 1);
  ok("scaffold に足りない", /足りない/.test(mid.scaffold));
}

{
  const good = buildProThinkCapability({
    photoInStorage: 100,
    learnedOk: 100,
    todo: 0,
    photoKindsN: 50,
    withScreenPos: 40,
    matched: 20,
    hasPhotoLearnTask: true,
    kindConflictN: 0,
    photoVsRecordN: 0,
    centerOnlyPosN: 0,
    solidPosN: 30,
    readCount: 3,
    autoAfter: true,
    foundationMissingN: 0,
  });
  ok("揃えば画像学習✓", good.image_learn.done === true);
  ok("大きな欠が少ない", good.missing.length === 0);
}

console.log("all ok");
