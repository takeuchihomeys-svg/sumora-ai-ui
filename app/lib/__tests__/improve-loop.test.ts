/**
 * 改善までの一連（2026-11-15）
 * 実行: npx tsx --env-file=.env.local app/lib/__tests__/improve-loop.test.ts
 */
import { buildImproveLoop, ensureStrengthenAfterLearn, improveLoopTasks } from "../improve-loop";
import { superviseLearn } from "../learn-supervisor";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra).slice(0, 350))); }
};

const hint = (read: number, auto: boolean) => ({
  read_count: read, read_at: read ? "2026-11-15T14:00:00Z" : null, auto_after: auto, bundle_at: "2026-11-15T13:50:00Z",
});

console.log("■ ① 段階4で止まる（拡張未読）");
{
  const loop = buildImproveLoop({
    photoInStorage: 5000, withOps: 3000, screenSolid: 52, screenAll: 74,
    hint: hint(0, false),
    challengeFields: ["transportation_id", "required_time"],
  });
  ok("bottleneck は 4", loop.bottleneck_n === 4, loop.bottleneck);
  ok("next_kind は need_ext_reload", loop.next_kind === "need_ext_reload", loop.next_kind);
  ok("improve_line に効果確認", /6\.効果確認/.test(loop.improve_line), loop.improve_line);
  const tasks = improveLoopTasks({ loop, unreadNormal: 100, challengeFields: ["transportation_id"] });
  ok("先頭は need_ext_reload", tasks[0]?.kind === "need_ext_reload", tasks.map((t) => t.kind));
  ok("  photo_learn は先頭にしない", tasks[0]?.kind !== "photo_learn");
  const tasksMiss = improveLoopTasks({
    loop, unreadNormal: 100, challengeFields: ["city_code[]"],
    missingInBundle: ["city_code[]"],
  });
  ok("課題が束に無い時は photo_learn が先", tasksMiss[0]?.kind === "photo_learn", tasksMiss.map((t) => t.kind));
  ok("  そのあと need_ext_reload", tasksMiss.some((t) => t.kind === "need_ext_reload"));
}

console.log("\n■ ② 段階5（読めたが自動未走行）");
{
  const loop = buildImproveLoop({
    photoInStorage: 5000, withOps: 3000, screenSolid: 52, screenAll: 74,
    hint: hint(2, false),
    challengeFields: ["transportation_id"],
  });
  ok("bottleneck は 5", loop.bottleneck_n === 5, loop.bottleneck);
  ok("next は need_auto_run", loop.next_kind === "need_auto_run", loop.next_kind);
  const tasks5 = improveLoopTasks({
    loop,
    unreadNormal: 100,
    challengeFields: ["transportation_id", "route_id[]"],
  });
  ok("段階5でも自動1回が先頭", tasks5[0]?.kind === "need_auto_run", tasks5.map((t) => t.kind));
  ok("段階5でも弱い欄の再学習がある", tasks5.some((t) => t.kind === "photo_learn" && /再強化|再学習/.test(t.what)), tasks5.map((t) => t.what));
  ok("再学習のあと reflect がある", tasks5.some((t) => t.kind === "reflect_auto"));
}

console.log("\n■ ③ 段階6（まだ課題あり）");
{
  const loop = buildImproveLoop({
    photoInStorage: 5000, withOps: 3000, screenSolid: 52, screenAll: 74,
    hint: hint(2, true),
    challengeFields: ["required_time"],
    canMeasure: true,
  });
  ok("bottleneck は 6", loop.bottleneck_n === 6, loop.bottleneck);
}

console.log("\n■ ④ 完了");
{
  const loop = buildImproveLoop({
    photoInStorage: 5000, withOps: 3000, screenSolid: 52, screenAll: 74,
    hint: hint(2, true),
    challengeFields: [],
    canMeasure: true,
  });
  ok("bottleneck なし", loop.bottleneck_n === null, loop.bottleneck);
  ok("改善まで完了", /改善まで完了/.test(loop.improve_line), loop.improve_line);
}

console.log("\n■ ⑤ 統括が段階4を先頭課題にする");
{
  const r = superviseLearn({
    rows: 200, next: 40, points: 80, opens: 20, screens: 4, sequence: 6, gap_ms: 900,
    weak: [{ kind: "x", name: "required_time" }],
    mode_counts: { normal: 100, aix: 50 }, site_counts: { realpro: 150 },
    with_ops: 150, site: "all", shot_rows: 180,
    shot_gaps_normal: { total: 100, unlearnedBig: 20, unlearnedSmall: 10, learnedButEmpty: 0, learnedOk: 70, todo: 20 },
    bundle_reflect: {
      screen_solid: 52, screen_all: 74, read_count: 0, read_at: null, auto_after: false,
      line: "…", bottleneck: "4.拡張が束を読む: read_count=0", bottleneck_n: 4, photo_in_storage: 5000,
    },
    improve_loop: {
      improve_line: "1.✓ → 2.✓ → 3.✓ → 4.拡張が束を読む✗ → 5.✗ → 6.効果確認✗ ／止: 4",
      bottleneck_n: 4,
      bottleneck: "4.拡張が束を読む: read_count=0",
      next_n: 4,
      next_kind: "need_ext_reload",
      steps: [],
    },
    latest_auto_challenge: {
      runs: 2, fields: ["transportation_id", "required_time"],
      line: "最新自動 …",
    },
    improve_from_normal: {
      fields: ["transportation_id", "required_time"],
      what: "自動の最新課題を通常から改善",
      why: "課題欄…", how: "newest", preferNewest: true,
    },
  });
  const tasks = r.meeting.learning_tasks || [];
  ok("先頭は need_ext_reload", tasks[0]?.kind === "need_ext_reload", tasks.map((t) => t.kind));
  ok("根拠に改善までの一連", r.meeting.evidence.some((e) => e.label === "改善までの一連"));
  ok("次にやる事の先頭が拡張再読込", (r.actions[0]?.what || "").includes("拡張を再読み込み"), r.actions[0]);
  ok("自己点検: 先頭が photo_learn なら矛盾", !r.self_check.issues.some((x) => x.includes("先頭課題が photo_learn")) || tasks[0]?.kind !== "photo_learn", r.self_check.issues);
  ok("根拠に学んだら強化（仕組み）", r.meeting.evidence.some((e) => e.label === "学んだら強化（仕組み）"));
}

console.log("\n■ ⑥ 学んだら強化: photo_learn だけの課題に強化の続きが付く");
{
  const chained = ensureStrengthenAfterLearn([
    { kind: "photo_learn", what: "読む", why: "未学習", cost: "費用", limit: 20 },
  ], { bottleneck_n: 3 });
  ok("reflect_auto が付く", chained.some((t) => t.kind === "reflect_auto"));
  ok("need_ext_reload が付く", chained.some((t) => t.kind === "need_ext_reload"));
  ok("need_auto_run が付く", chained.some((t) => t.kind === "need_auto_run"));
  ok("verify_improve が付く", chained.some((t) => t.kind === "verify_improve"));
  ok("photo_learn だけで終わらない", chained.length >= 5);
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
