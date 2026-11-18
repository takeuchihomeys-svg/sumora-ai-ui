/**
 * サイト共通の学習方法・移植関所
 * 実行: npx tsx app/lib/__tests__/site-learn-method.test.ts
 */
import {
  measureSiteMethodParity,
  siteLearnMethodEvidence,
  SITE_LEARN_METHOD_STEPS,
} from "../site-learn-method";
import { superviseLearn } from "../learn-supervisor";
import { ITANDI_BUTTONS } from "../itandi-buttons";
import { REALPRO_BUTTONS } from "../realpro-buttons";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, detail ?? ""); }
}

console.log("■ 方法の段");
ok("①〜⑥が6段（学び方強化含む）", SITE_LEARN_METHOD_STEPS.length === 6);
ok("⑥が学び方強化", /学習方法を直し|学び方/.test(SITE_LEARN_METHOD_STEPS[5]));

console.log("\n■ 型が揃えば F50 相当 ✓");
{
  const p = measureSiteMethodParity({
    sitesWithSupervisor: ["realpro", "itandi"],
    rowsBySite: { realpro: 10000, itandi: 4 },
    visionPhotoBySite: { realpro: 3000, itandi: 0 },
    realproButtonsN: REALPRO_BUTTONS.length,
    itandiButtonsN: ITANDI_BUTTONS.length,
  });
  ok("両台帳・両統括で ok", p.ok === true);
  ok("itandi録画要求が出る", !!p.itandi_record_ask && /ITANDI/.test(p.itandi_record_ask));
  ok("穴に記録が少ない", p.gaps.some((g) => /記録が少ない/.test(g)));
}

console.log("\n■ 統括が無いと ✗");
{
  const p = measureSiteMethodParity({
    sitesWithSupervisor: ["realpro"],
    rowsBySite: { realpro: 100, itandi: 0 },
  });
  ok("itandi統括無しは ok=false", p.ok === false);
}

console.log("\n■ 統括根拠にサイト共通の学習方法");
{
  const adv = superviseLearn({
    rows: 10,
    next: 2,
    points: 5,
    opens: 1,
    screens: 1,
    sequence: 1,
    gap_ms: 500,
    weak: [{ kind: "missing", name: "x", why: "薄い" }],
    mode_counts: { normal: 5 },
    site_counts: { itandi: 4 },
    with_ops: 3,
    site: "itandi",
    human_like: {
      ops: 10, typedOnChoose: 0, clickedThenChanged: 0, changedWithoutClick: 1,
      changedWithoutClickFields: ["a"], withCursor: 5, withPoint: 2, rows: 5,
    },
  });
  const ev = (adv.meeting?.evidence || []).find((e) => e.label === "サイト共通の学習方法");
  ok("根拠がある", !!ev);
  ok("itandi向けの文言", !!ev && /itandi/i.test(ev.value));
  const need = (adv.meeting?.learning_tasks || []).find((t) => t.kind === "need_human" && /ITANDI/.test(t.what));
  ok("ITANDI通常録画の課題", !!need, adv.meeting?.learning_tasks?.map((t) => t.kind + ":" + t.what).slice(0, 5));
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exitCode = 1;
