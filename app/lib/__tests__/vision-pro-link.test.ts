/**
 * 画像flash → 材料 → Pro の細分化連携
 * 実行: npx tsx app/lib/__tests__/vision-pro-link.test.ts
 */
import { buildVisionProLink, markVisionProUsed } from "../vision-pro-link";
import { buildSupervisorProPayload, mergeSupervisorPro } from "../learn-supervisor-pro";
import type { SupervisorAdvice } from "../learn-supervisor";
import { LEARN_MECHANISMS } from "../learn-supervisor";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, detail ?? ""); }
}

console.log("■ 細分化ステップ");
{
  const empty = buildVisionProLink({});
  ok("写真0は step1 ✗", empty.steps[0].ok === false);
  ok("ボトルネックは1", empty.bottleneck_n === 1);

  const inferred = buildVisionProLink({
    photoInStorage: 0,
    learnedOk: 1799,
    todo: 1746,
    photoKindsN: 0,
    imageFields: 0,
  });
  ok("学べ+未読があれば段1✓（推定）", inferred.steps[0].ok === true);
  ok("推定の詳細に学べ/未読", /学べ|未読|推定/.test(inferred.steps[0].detail));
  ok("材料なしなら段3が止", inferred.bottleneck_n === 3);

  const mid = buildVisionProLink({
    photoInStorage: 100,
    learnedOk: 40,
    todo: 20,
    photoKindsN: 50,
    imageFields: 30,
    withScreenPos: 10,
    matched: 5,
    hasPhotoLearnTask: true,
    usedPro: null,
  });
  ok("1〜5は✓（Pro未確定でもOK）", mid.steps.slice(0, 5).every((s) => s.ok) && mid.steps[5].ok);
  ok("bottleneckなし", mid.bottleneck_n == null);
  ok("line に flash と段階", /flashで読む✓/.test(mid.line) && /Proまとめ判断✓/.test(mid.line));

  const noTask = buildVisionProLink({
    photoInStorage: 10,
    learnedOk: 2,
    todo: 5,
    photoKindsN: 3,
    imageFields: 3,
    withScreenPos: 1,
    matched: 1,
    hasPhotoLearnTask: false,
  });
  ok("未読なのに課題無しは step5 ✗", noTask.bottleneck_n === 5);

  const noMaterial = buildVisionProLink({
    photoInStorage: 10,
    learnedOk: 2,
    todo: 0,
    photoKindsN: 0,
    imageFields: 0,
  });
  ok("材料なしは step3 ✗", noMaterial.bottleneck_n === 3);

  // ★ 2026-11-18: 写真あり∧学べ0∧todo=0∧課題なし → 段5✗（誤報「課題不要」を止める）
  const flashPending = buildVisionProLink({
    photoInStorage: 6000,
    learnedOk: 0,
    todo: 0,
    photoKindsN: 0,
    imageFields: 0,
    hasPhotoLearnTask: false,
  });
  ok("写真ある学べ0・課題なしは段5✗", flashPending.steps[4].ok === false);
  ok("止は段2（flash未実行が先）", flashPending.bottleneck_n === 2);

  const flashTasked = buildVisionProLink({
    photoInStorage: 6000,
    learnedOk: 0,
    todo: 0,
    photoKindsN: 0,
    imageFields: 0,
    hasPhotoLearnTask: true,
  });
  ok("課題ありなら段5✓・止は段2", flashTasked.steps[4].ok === true && flashTasked.bottleneck_n === 2);
}

console.log("\n■ Pro後の step6");
{
  const base = buildVisionProLink({
    photoInStorage: 10, learnedOk: 5, todo: 0,
    photoKindsN: 4, imageFields: 4, withScreenPos: 2, matched: 1,
    hasPhotoLearnTask: false, usedPro: null,
  });
  const okPro = markVisionProUsed(base, true, "deepseek-v4-pro");
  ok("Pro成功で used_pro=true", okPro.counts.used_pro === true);
  ok("Pro成功で step6✓", okPro.steps[5].ok === true && /Proまとめ済み/.test(okPro.steps[5].detail));
  const ngPro = markVisionProUsed(base, false, "deepseek-v4-pro");
  ok("Pro失敗で step6✗", ngPro.steps[5].ok === false && ngPro.bottleneck_n === 6);
}

console.log("\n■ 仕組み⑮と Pro payload");
{
  ok("仕組み⑮がある", LEARN_MECHANISMS.some((s) => /画像flash→材料→Pro/.test(s)));
  const adv: SupervisorAdvice = {
    verdict: "almost",
    headline: "もう少し",
    actions: [],
    score: { coverage: 50, weak: 1, delta: null },
    block: null,
    lines: [],
    meeting: {
      today: ["決定論"],
      agenda: [],
      questions: [],
      evidence: [
        { label: "画像学習→統括Pro連携", value: "1.写真✓ → 2.flash✓ → …" },
        { label: "写真から読んだ欄の種類", value: "プルダウン 10" },
        { label: "通常モードの画像×押した位置", value: "両方 5" },
      ],
      learning_tasks: [{ kind: "photo_learn", what: "読む", why: "弱い", cost: "費用", limit: 10 }],
      vision_pro_link: buildVisionProLink({
        photoInStorage: 10, learnedOk: 5, todo: 2,
        photoKindsN: 10, imageFields: 8, withScreenPos: 3, matched: 2,
        hasPhotoLearnTask: true,
      }),
    },
    self_check: { ok: true, issues: [], capped_by: null },
  };
  const p = buildSupervisorProPayload(adv);
  const axes = p.axes as Record<string, string | null>;
  ok("axes.vision_link がある", !!axes.vision_link);
  ok("axes.photo_kinds がある", !!axes.photo_kinds);
  ok("vision_link.steps がある", Array.isArray((p.vision_link as { steps?: unknown[] })?.steps)
    && ((p.vision_link as { steps: unknown[] }).steps.length === 6));

  const merged = mergeSupervisorPro(adv, {
    today: ["Pro結論"],
    link_gap: "画像連携の穴",
    next_line: "flashで読む",
    foundation_gaps: ["材料"],
    build_next: "photo_learn",
    quality_up: "連携細分化",
    weak_fixes: [{ field: "route_id[]", gap: "0%", next: "flashで位置", layer: "flash", why: "未学習", how: "読む", toward100: "0→70" }],
    bug_fixes: ["区の外しはカーソル経由"],
    why_not_100: "再現35%",
    path_to_100: "flash→拡張→自動",
  }, { model: "deepseek-v4-pro", usedPro: true });
  const linkEv = merged.meeting.evidence.find((e) => e.label === "画像学習→統括Pro連携");
  ok("merge後に連携行が Proまとめ済み", !!linkEv && /Proまとめ済み|Proまとめ判断✓/.test(String(linkEv.value)));
  ok("vision_pro_link.used_pro", merged.meeting.vision_pro_link?.counts.used_pro === true);
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exitCode = 1;
