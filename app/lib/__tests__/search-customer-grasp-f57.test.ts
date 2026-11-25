/**
 * F57: お客さん検索把握印が揃うと after_search が埋まる／欠け名指し
 * npx tsx app/lib/__tests__/search-customer-grasp-f57.test.ts
 */
import { auditGuideScreenGrasp } from "../guide-screen-grasp";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const base = [
  { k: "page:guide_phase_after_confirm" },
  { k: "page:guide_phase_after_area" },
  { k: "page:guide_phase_after_place" },
  { k: "page:guide_phase_before_search" },
];

{
  // 意図だけでは after_search は guide_phase_after_search が要る（intent だけでは不足しうる）
  const r = auditGuideScreenGrasp({
    steps: [...base, { k: "page:search_customer_grasp_intent" }],
  });
  assert(!r.improve_complete, "intent only incomplete");
  console.log("✓ intentのみでは未完", r.missing.join("・"));
}

{
  const r = auditGuideScreenGrasp({
    steps: [
      ...base,
      { k: "page:guide_phase_after_search" },
      { k: "page:search_customer_grasp_intent" },
      { k: "page:search_customer_grasp_ok" },
      { k: "dl:list_flow_grasp" },
      { k: "dl:search_to_sort" },
      { k: "dl:sort_menu" },
    ],
  });
  assert(r.improve_complete, "screen ok + sort → complete: " + r.line);
  console.log("✓ 客検索画面把握＋並べ替えで完了");
}

{
  const r = auditGuideScreenGrasp({
    steps: [
      ...base,
      { k: "page:guide_phase_after_search_screen" },
      { k: "dl:list_flow_grasp" },
      { k: "dl:sort_cursor_go" },
      { k: "dl:sort_hilo" },
    ],
  });
  assert(r.improve_complete, "after_search_screen alone fills after_search: " + r.line);
  console.log("✓ after_search_screen で検索後段OK");
}

console.log("\nsearch-customer-grasp-f57.test OK");
