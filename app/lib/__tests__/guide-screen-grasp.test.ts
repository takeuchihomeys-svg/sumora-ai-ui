/**
 * F57 手順書×画面照会 段ごと完了線
 * npx tsx app/lib/__tests__/guide-screen-grasp.test.ts
 */
import {
  auditGuideScreenGrasp,
  GUIDE_SCREEN_PHASES,
} from "../guide-screen-grasp";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const searchSteps = [
  { k: "page:guide_phase_after_confirm" },
  { k: "page:guide_phase_after_area" },
  { k: "page:guide_phase_after_place" },
  { k: "page:guide_phase_before_search" },
  { k: "page:guide_phase_after_search" },
];

const fullListSteps = [
  ...searchSteps,
  { k: "dl:list_flow_grasp" },
  { k: "dl:search_to_sort" },
  { k: "dl:sort_hilo" },
];

{
  const r = auditGuideScreenGrasp({ steps: searchSteps });
  assert(r.path.wantList === true, "検索後あり→一覧要");
  assert(r.missing.includes("一覧") || r.missing.some((m) => /一覧|並べ替え|search/.test(m)), "一覧欠が名指し: " + r.missing.join(","));
  assert(!r.improve_complete, "検索までだけでは完了にしない");
  console.log("✓ 検索までだけでは improve_complete=false", r.missing.join("・"));
}

{
  const r = auditGuideScreenGrasp({ steps: fullListSteps });
  assert(r.improve_complete, "一覧・並べ替え印まで揃えば完了: " + r.line);
  console.log("✓ 必須段揃い improve_complete=true");
}

{
  const r = auditGuideScreenGrasp({
    steps: [
      ...searchSteps,
      { k: "page:guide_phase_station_skip" },
      { k: "dl:list_flow_grasp" },
      { k: "dl:search_to_sort" },
      { k: "dl:sort_menu" },
    ],
  });
  assert(r.improve_complete, "駅スキップ印でも駅必須を満たす");
  console.log("✓ 駅スキップ経路OK");
}

{
  assert(GUIDE_SCREEN_PHASES.length >= 10, "段定義が足りない");
  console.log("✓ 段定義", GUIDE_SCREEN_PHASES.length);
}

{
  // ★ 2.8.192: sort_cursor_wait だけでは並べ替え完了にしない
  const r = auditGuideScreenGrasp({
    steps: [
      ...searchSteps,
      { k: "dl:list_flow_grasp" },
      { k: "dl:search_to_sort" },
      { k: "dl:sort_cursor_wait" },
    ],
  });
  assert(!r.improve_complete, "待ち予約だけでは完了にしない");
  assert(r.missing.some((m) => /並べ替え/.test(m)), "並べ替え欠が名指し: " + r.missing.join(","));
  console.log("✓ sort_cursor_wait だけでは incomplete");
}

{
  const r = auditGuideScreenGrasp({
    steps: [
      ...searchSteps,
      { k: "dl:flow_atom_ok_after_search_rows" },
      { k: "dl:sort_cursor_go" },
      { k: "dl:sort_menu" },
    ],
  });
  assert(r.improve_complete, "原子+go+menu で完了: " + r.line);
  console.log("✓ 細部原子経路OK");
}

console.log("\nguide-screen-grasp.test OK");
