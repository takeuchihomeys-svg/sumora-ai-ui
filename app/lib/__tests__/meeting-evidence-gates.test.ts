/**
 * ensureMeetingEvidenceGates の関所テスト（薄い meeting でも必須ラベルを載せる）
 * 実行: npx tsx app/lib/__tests__/meeting-evidence-gates.test.ts
 */
import type { SupervisorAdvice } from "../learn-supervisor";
import { ensureMeetingEvidenceGates } from "../meeting-evidence-gates";
import { buildSupervisorProPayload } from "../learn-supervisor-pro";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, detail ?? "");
  }
}

/** 結論・記録だけの薄い evidence（learning_tasks 空） */
const thinAdv = (
  evidence?: Array<{ label: string; value: string; guessed?: boolean }>,
): SupervisorAdvice => ({
  verdict: "not_yet",
  headline: "まだ",
  actions: [],
  score: { coverage: 12, weak: 0, delta: null },
  block: null,
  lines: [],
  meeting: {
    today: ["薄い統括"],
    agenda: [],
    questions: [],
    evidence: evidence ?? [
      { label: "結論", value: "まだ（材料 12/100）" },
      { label: "記録", value: "3件" },
    ],
    learning_tasks: [],
  },
  self_check: { ok: true, issues: [], capped_by: null },
});

function countLabel(ev: Array<{ label?: string }>, re: RegExp): number {
  return ev.filter((e) => re.test(String(e.label || ""))).length;
}

const GATE_LABELS = {
  foundation: /学習土台点検/,
  complete: /学習完成（期間/,
  recChallenge: /録画→課題/,
  method: /学習方法の強化/,
  linkage: /学習→自動の連携/,
} as const;

// ── 1. 基本統計だけでも関所ラベルが載る（ctx なし） ──
console.log("■ 1. evidence が基本統計だけ（ctx なし）");
{
  const out = ensureMeetingEvidenceGates(thinAdv(), null);
  const ev = out.meeting?.evidence || [];
  ok("学習土台点検", ev.some((e) => GATE_LABELS.foundation.test(e.label)));
  ok("学習完成", ev.some((e) => GATE_LABELS.complete.test(e.label)));
  ok("録画→課題", ev.some((e) => GATE_LABELS.recChallenge.test(e.label)));
  ok("学習方法の強化", ev.some((e) => GATE_LABELS.method.test(e.label)));
  ok("学習→自動の連携", ev.some((e) => GATE_LABELS.linkage.test(e.label)));
}

// ── 1b. 薄い realpro 相当（材料あり・Pro axes） ──
console.log("\n■ 1b. 薄い realpro（材料あり）");
{
  const out = ensureMeetingEvidenceGates(thinAdv(), {
    site: "realpro",
    foundationAudit: {
      summary: "✓18／欠12",
      ok_n: 18,
      missing_n: 12,
      total: 30,
      screen_solid: 0,
      missing: [{ id: "F1_screen_grasp", line: "solid=0", next: "履歴復元" }],
    },
    bundleReflect: {
      line: "段階4: 拡張が束を読めていない",
      bottleneck: "read_count=0",
      read_count: 0,
      auto_after: false,
      screen_solid: 0,
    },
    humanLike: { ops: 5, withPoint: 1, withCursor: 2, rows: 5, changedWithoutClick: 0 },
    shotGapsNormal: { todo: 0 },
  });
  const ev = out.meeting?.evidence || [];
  ok("土台点検がある", ev.some((e) => GATE_LABELS.foundation.test(e.label)));
  ok("学習完成がある", ev.some((e) => GATE_LABELS.complete.test(e.label)));
  ok("録画→課題がある", ev.some((e) => GATE_LABELS.recChallenge.test(e.label)));
  ok("学習方法強化がある", ev.some((e) => GATE_LABELS.method.test(e.label)));
  ok("連携がある", ev.some((e) => GATE_LABELS.linkage.test(e.label)));
  ok("learning_tasks が空でない（solid=0）", (out.meeting?.learning_tasks || []).length > 0);

  const p = buildSupervisorProPayload(out);
  const axes = p.axes as Record<string, string | null>;
  ok("axes.foundation_audit", axes.foundation_audit != null);
  ok("axes.complete_chain", axes.complete_chain != null);
  ok("axes.rec_challenge", axes.rec_challenge != null);
  ok("axes.method_strengthen", axes.method_strengthen != null);
  ok("axes.linkage", axes.linkage != null);
}

// ── 2. learning_tasks 空 → ensure-gapless（solid 低） ──
console.log("\n■ 2a. learning_tasks 空・screen_solid 低");
{
  const out = ensureMeetingEvidenceGates(thinAdv(), {
    foundationAudit: { screen_solid: 5, ok_n: 10, missing_n: 2, total: 12 },
    bundleReflect: { screen_solid: 5, read_count: 0, auto_after: false },
    shotGapsNormal: { todo: 0 },
  });
  const tasks = out.meeting?.learning_tasks || [];
  ok("課題が1件以上", tasks.length > 0);
  ok("reflect_auto が入る（solid<30）", tasks.some((t) => t.kind === "reflect_auto"));
}

// ── 2b. unread > 0 で photo_learn ──
console.log("\n■ 2b. learning_tasks 空・未学習>0");
{
  const out = ensureMeetingEvidenceGates(thinAdv(), {
    foundationAudit: { screen_solid: 80, ok_n: 20, missing_n: 0, total: 20 },
    bundleReflect: { screen_solid: 80, read_count: 2, auto_after: true },
    shotGapsNormal: { todo: 7 },
  });
  const tasks = out.meeting?.learning_tasks || [];
  ok("課題が1件以上", tasks.length > 0);
  ok("photo_learn が入る（unread>0）", tasks.some((t) => t.kind === "photo_learn"));
  ok("agenda に次に学ぶ事", (out.meeting?.agenda || []).some((a) => /次に学ぶ事/.test(String(a.topic || ""))));
}

// ── 3. 既存ラベルがあるとき二重追加しない ──
console.log("\n■ 3. 既存ラベルは二重にしない");
{
  const pre = [
    { label: "結論", value: "x" },
    { label: "学習土台点検（F番号）", value: "既存・土台" },
    { label: "学習→自動の連携", value: "既存・連携" },
    { label: "録画→課題→学習→仕組み補強", value: "既存・録画" },
    { label: "学習方法の強化（効果で直して周回）", value: "既存・方法" },
    { label: "学習完成（期間・土台・つながり・一連）", value: "既存・完成" },
  ];
  const out = ensureMeetingEvidenceGates(thinAdv(pre), {
    foundationAudit: { summary: "✓1", ok_n: 1, missing_n: 0, total: 1 },
    bundleReflect: { line: "l", read_count: 1, auto_after: true, screen_solid: 50 },
    humanLike: { ops: 3, withPoint: 3, withCursor: 3, rows: 3 },
  });
  const ev = out.meeting?.evidence || [];
  ok("学習土台点検は1件", countLabel(ev, /学習土台点検（F番号）/) === 1);
  ok("連携は1件", countLabel(ev, /^学習→自動の連携$/) === 1);
  ok("録画→課題は1件", countLabel(ev, /録画→課題→学習→仕組み補強/) === 1);
  ok("学習方法の強化は1件", countLabel(ev, /学習方法の強化（効果で直して周回）/) === 1);
  ok("学習完成（4本柱頭）は1件", countLabel(ev, /^学習完成（期間・土台・つながり・一連）$/) === 1);
  ok("既存 value が残る", ev.some((e) => e.value === "既存・土台"));
}

// ── 4. 設計知見候補は upgrades がある時だけ（自動 INSERT しない） ──
console.log("\n■ 4a. upgrades あり → 手動 KB 候補行のみ");
{
  const out = ensureMeetingEvidenceGates(thinAdv(), {
    bundleReflect: { read_count: 0, auto_after: false, screen_solid: 0 },
    humanLike: { ops: 10, withPoint: 1, withCursor: 2, rows: 10, changedWithoutClick: 3 },
    foundationAudit: { screen_solid: 0, ok_n: 5, missing_n: 5, total: 10 },
  });
  const ev = out.meeting?.evidence || [];
  const kb = ev.find((e) => /設計知見候補（学び方強化）/.test(e.label));
  ok("設計知見候補がある", kb != null);
  ok("kb-insert 手動である", String(kb?.value || "").includes("kb-insert手動候補"));
  ok("自動 INSERT の文言を含まない", !/自動\s*INSERT|INSERT\s*する/.test(String(kb?.value || "")));
}

console.log("\n■ 4b. upgrades なし（method.upgrades 空）→ 設計知見候補行なし");
{
  // humanLike 未渡し相当（ops=0）で学び方 upgrades が付かない材料
  const out = ensureMeetingEvidenceGates(thinAdv(), {
    bundleReflect: { line: "材料薄", read_count: 0, auto_after: false, screen_solid: 0 },
    humanLike: { ops: 0, withPoint: 0, withCursor: 0, rows: 0 },
    foundationAudit: { screen_solid: 0, ok_n: 1, missing_n: 0, total: 1 },
  });
  const ev = out.meeting?.evidence || [];
  ok("設計知見候補が無い", !ev.some((e) => /設計知見候補（学び方強化）/.test(e.label)));
  ok("evidence に自動INSERTの約束が無い", !ev.some((e) => /自動\s*INSERT|INSERT\s*して保存/.test(String(e.value))));
}

// ── 5. 薄い meeting + shotBytes.in_storage>0 → 段1✓・vision_pro_link 非null ──
console.log("\n■ 5. 薄い meeting + shotBytes（段1・vision_pro_link）");
{
  const out = ensureMeetingEvidenceGates(thinAdv(), {
    site: "realpro",
    shotBytes: { in_storage: 11364, n: 4155 },
    shotGapsNormal: { learnedOk: 190, todo: 50, total: 240 },
    bundleReflect: { photo_in_storage: 11364, read_count: 0, auto_after: false, screen_solid: 0 },
    foundationAudit: { ok_n: 10, missing_n: 2, total: 12, screen_solid: 0 },
  });
  const vpl = (out.meeting as { vision_pro_link?: { steps?: Array<{ n: number; ok: boolean }>; counts?: { photo_in_storage?: number } } })?.vision_pro_link;
  const ev = out.meeting?.evidence || [];
  ok("vision_pro_link がある", vpl != null);
  ok("段1 写真保存✓", vpl?.steps?.[0]?.ok === true);
  ok("photo_in_storage > 0", (vpl?.counts?.photo_in_storage || 0) > 0);
  ok("画像学習→統括Pro連携がある", ev.some((e) => /画像学習→統括Pro連携/.test(e.label)));
  ok("写真→統括到達がある", ev.some((e) => /写真→統括到達/.test(e.label)));
  ok("段1誤報禁止の note", ev.some((e) => /段1を✗にしない/.test(String(e.value))));
}

// ── 6. 写真あり∧学べ0∧todo=0 → photo_learn強制・段5✓・止は段2 ──
console.log("\n■ 6. 写真あり学べ0 → photo_learn強制（段5誤報止め）");
{
  const out = ensureMeetingEvidenceGates(thinAdv(), {
    site: "realpro",
    shotBytes: { in_storage: 6000, n: 6000 },
    shotGapsNormal: { learnedOk: 0, todo: 0, total: 6000 },
    bundleReflect: { photo_in_storage: 6000, read_count: 0, auto_after: false, screen_solid: 0 },
    foundationAudit: { ok_n: 10, missing_n: 0, total: 10, screen_solid: 0 },
  });
  const tasks = out.meeting?.learning_tasks || [];
  const vpl = (out.meeting as { vision_pro_link?: { bottleneck_n?: number | null; steps?: Array<{ n: number; ok: boolean }> } })?.vision_pro_link;
  ok("photo_learn 課題あり", tasks.some((t) => t.kind === "photo_learn"));
  ok("段1✓", vpl?.steps?.[0]?.ok === true);
  ok("段5✓（課題あり）", vpl?.steps?.[4]?.ok === true);
  ok("止は段2 flash", vpl?.bottleneck_n === 2);
}

console.log(`\n■ 結果: ${pass} ok, ${fail} fail`);
if (fail) process.exit(1);