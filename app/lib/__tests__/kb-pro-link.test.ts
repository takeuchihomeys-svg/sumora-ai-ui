/**
 * 実行: npx tsx app/lib/__tests__/kb-pro-link.test.ts
 */
import { buildKbProLink } from "../kb-pro-link";
import { ensureGaplessLearnTasks } from "../ensure-gapless-learn";

function ok(name: string, cond: boolean) {
  if (!cond) throw new Error("FAIL " + name);
  console.log("  ok", name);
}

console.log("kb-pro-link");
{
  const thin = buildKbProLink({
    brainPull: { query: "q", kb_hits: [], log_memory: [], line: "0", ok: false, why: "empty" },
    foundationGaps: [],
    hasCauseRelearn: false,
    hasImproveConstruct: false,
    hasProThink: false,
  });
  ok("引き無しは未完", thin.ok === false);
  ok("pull穴", thin.gaps.some((g) => g.id === "kb_pull"));
}

{
  const good = buildKbProLink({
    brainPull: {
      query: "q",
      ok: true,
      why: null,
      line: "6件",
      kb_hits: [{
        id8: "aaaaaaaa",
        title: "【決定】画面位置 solid 消失を防ぐ",
        insight: "履歴から solid を継ぎ消す書き込みを拒否する。完了線は solid≥30。",
        priority: 1,
        score: 1,
        tags: ["統括Pro", "Chrome拡張"],
      }],
      log_memory: [{ at: "2026-11-18", today: "把握: ok", next: "自動1回" }],
    },
    foundationGaps: ["F1: solid"],
    buildNext: "復元→自動",
    pathTo100: "一連",
    today: ["把握: 知見を見た"],
    evidenceLabels: [
      "統括Pro把握",
      "足りない土台（統括Pro判断）",
      "原因→改善の再学習",
      "改善する仕組みの構築",
      "統括Pro思考骨格（足りない→強化→改善）",
    ],
    learningTaskKinds: ["photo_learn", "need_auto_run", "reflect_auto"],
    hasCauseRelearn: true,
    hasImproveConstruct: true,
    hasProThink: true,
  });
  ok("揃えば連携OK", good.ok === true);
  ok("KBからsolidヒント", good.from_kb_gaps.some((g) => /solid|画面位置/.test(g)));
}

console.log("ensure-gapless-learn");
{
  const sealed = ensureGaplessLearnTasks({
    tasks: [],
    unreadNormal: 28,
    screenSolid: 0,
    readCount: 2,
    autoAfter: false,
    reflectOk: 0,
  });
  ok("solid低でreflect", sealed.some((t) => t.kind === "reflect_auto"));
  ok("未学習でphoto_learn", sealed.some((t) => t.kind === "photo_learn"));
  ok("autoAfter falseでneed_auto", sealed.some((t) => t.kind === "need_auto_run"));

  const solid96 = ensureGaplessLearnTasks({
    tasks: [{ kind: "photo_learn", what: "x", why: "y", cost: "無料" }],
    screenSolid: 96,
    readCount: 1,
    autoAfter: null,
    reflectOk: 0,
  });
  ok("solid≥30 read≥1 auto未確認でneed_auto", solid96.some((t) => t.kind === "need_auto_run"));
  ok("whyに新束後自動=0", /新束後自動=0|F38/.test(String(solid96.find((t) => t.kind === "need_auto_run")?.why || "")));

  const flash0 = ensureGaplessLearnTasks({
    tasks: [],
    unreadNormal: 0,
    photoReach: 6000,
    learnedOk: 0,
    screenSolid: 50,
    readCount: 1,
    autoAfter: true,
    reflectOk: 1,
  });
  ok("写真あり学べ0でもphoto_learn", flash0.some((t) => t.kind === "photo_learn"));
  ok("whyにflash", /flash|学べ0/.test(String(flash0.find((t) => t.kind === "photo_learn")?.why || "")));
}

console.log("all ok");
