/**
 * 手順書 build_v9: 検索把握・area確定・extra_guides(clear/switch/pet)
 * npx tsx app/lib/__tests__/playbook-search-extra-guides.test.ts
 */
import {
  PLAYBOOK_BUILD_V,
  PLAYBOOK_SEARCH_GRASP_STEPS,
  PLAYBOOK_AREA_CONFIRM_STEPS,
  PLAYBOOK_EXTRA_GUIDES,
  PLAYBOOK_MAX_STEPS,
  PLAYBOOK_FIELD_JA,
  buildPlaybook,
  checkPlaybook,
  cleanPlaybookName,
  normalizePlaybookSteps,
} from "../action-playbook";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(PLAYBOOK_BUILD_V >= 9, "build_v >= 9");
assert(PLAYBOOK_SEARCH_GRASP_STEPS.length === 3, "3 search grasp steps");
assert(PLAYBOOK_AREA_CONFIRM_STEPS.length === 3, "3 area confirm steps");
assert(PLAYBOOK_EXTRA_GUIDES.some((g) => g.id === "clear"), "extra clear");
assert(PLAYBOOK_EXTRA_GUIDES.some((g) => g.id === "switch"), "extra switch");
assert(PLAYBOOK_EXTRA_GUIDES.some((g) => g.id === "pet"), "extra pet");
assert(PLAYBOOK_FIELD_JA["最初前1234次最後"] === "次のページへ", "pager field mapped");
assert(cleanPlaybookName("印刷用PDF🧠88通す｜td") === "印刷用PDF", "strip brain+通す+tag");
assert(
  normalizePlaybookSteps(["印刷用PDF🧠88通す｜td", "印刷用PDF｜img"]).steps.join("|") === "印刷用PDFを押す",
  "PDF variants collapse to one known step",
);

const pb = buildPlaybook({
  generated_at: new Date().toISOString(),
  scene_flows: [
    { scene: "search", runs: 5, ops: 1, steps: ["検索"], variants: 1 },
    { scene: "area", runs: 1, ops: 1, steps: ["city_code[]"], variants: 1 },
    { scene: "list", runs: 5, ops: 2, steps: ["印刷用PDF"], variants: 1 },
    { scene: "next", runs: 3, ops: 1, steps: ["左の最初前1234次最後｜div.pager_box"], variants: 1 },
  ],
  points: {},
  opens: {},
  next: {},
});

assert(pb.build_v >= 9, "pb build_v");
assert(Array.isArray(pb.extra_guides) && pb.extra_guides.length >= 3, "extra_guides present");
assert(pb.extra_guides.every((g) => g.steps.length >= 3), "extra guides each >=3");
assert(
  (pb.extra_guides.find((g) => g.id === "clear")?.steps.length || 0) >= 5,
  "clear guide has fine steps (>=5)",
);
assert(
  pb.extra_guides.find((g) => g.id === "clear")!.steps.some((t) => /名前付き|1つずつ言う/.test(t)),
  "clear guide names grasp",
);

const search = pb.scenes.find((s) => s.scene === "search");
assert(!!search, "search scene");
assert(search!.steps.some((t) => /①条件を入れ終えたら[^。]*検索ボタンを押す/.test(t)), "search ①");
assert(search!.steps.some((t) => /②検索したことを手順書/.test(t)), "search ②");
assert(search!.steps.some((t) => /③把握OKのあと[^。]*待って並べ替え/.test(t)), "search ③");
assert(search!.rules.includes("search_customer_screen_grasp"), "search rule grasp");
assert(search!.steps.length <= PLAYBOOK_MAX_STEPS, "search max");

const area = pb.scenes.find((s) => s.scene === "area");
assert(!!area, "area scene");
assert(area!.steps.some((t) => /確定してリストへ/.test(t)), "area has confirm");
assert(area!.steps.some((t) => /所在地絞り込みを開く|区の欄/.test(t)), "area open or ward kept");
assert(area!.detail.length === area!.steps.length, "area detail=steps");

const next = pb.scenes.find((s) => s.scene === "next");
assert(!!next, "next scene");
assert(next!.detail.some((d) => d.step === "次のページへ"), "next mapped not 未分類");
assert(!next!.steps.some((t) => /未分類/.test(t)), "next no 未分類");

assert(pb.gaps.some((g) => /検索場面/.test(g)), "gap search fixed");
assert(pb.gaps.some((g) => /所在地場面/.test(g)), "gap area fixed");
assert(pb.gaps.some((g) => /場面なし/.test(g)), "gap extra guides");

// 既に把握手がある時は二重に載せない
const again = buildPlaybook({
  scene_flows: [
    {
      scene: "search",
      runs: 5,
      ops: 3,
      steps: [...PLAYBOOK_SEARCH_GRASP_STEPS],
      variants: 1,
    },
  ],
});
const s2 = again.scenes.find((s) => s.scene === "search")!;
const ones = s2.steps.filter((t) => /①条件を入れ終えたら[^。]*検索ボタンを押す/.test(t));
assert(ones.length === 1, "no duplicate search guide");

// DB実測と同じ薄い形（search=検索1手・area=区1手・list=PDFのみ）でも全ガイドが載る
const thinLikeDb = buildPlaybook({
  generated_at: "2026-11-23T01:00:00Z",
  scene_flows: [
    { scene: "area", runs: 426, ops: 1, steps: ["city_code[]"], variants: 3 },
    { scene: "search", runs: 5, ops: 1, steps: ["検索"], variants: 1 },
    { scene: "list", runs: 69, ops: 2, steps: ["印刷用PDF｜img", "印刷用PDF🧠88通す｜td"], variants: 8 },
  ],
});
assert(thinLikeDb.build_v >= 9, "thin db-like build");
assert(
  thinLikeDb.scenes.find((s) => s.scene === "search")!.steps.some((t) => /②検索したことを手順書/.test(t)),
  "thin search grasp",
);
{
  const a = thinLikeDb.scenes.find((s) => s.scene === "area")!;
  assert(a.steps.some((t) => /確定してリストへ/.test(t)), "thin area confirm");
  assert(a.steps.some((t) => /所在地絞り込みを開く/.test(t)), "thin area open");
  assert(a.detail.length === a.steps.length, "thin area detail sync");
}
assert(
  thinLikeDb.scenes.find((s) => s.scene === "list")!.steps.some((t) => /①並べ替え/.test(t)),
  "thin list AD still",
);
{
  const list = thinLikeDb.scenes.find((s) => s.scene === "list")!;
  assert(!list.steps.some((t) => /未分類/.test(t)), "PDF🧠通す must not stay 未分類 in steps");
  assert(!list.unknown.some((u) => /印刷用PDF/.test(u)), "PDF🧠通す must not stay in unknown " + list.unknown.join(","));
  assert(
    !checkPlaybook(thinLikeDb).some((x) => /未分類の欄/.test(x)),
    "checkPlaybook no 未分類 for PDF brain suffix",
  );
}
assert(
  ["clear", "switch", "pet"].every((id) => thinLikeDb.extra_guides.some((g) => g.id === id)),
  "thin extra_guides",
);

// ★ build_v10: 録画が station だけでも area/cond/search/list が scenes に載る（連続客の外し→入れ抜け防止）
const stationOnly = buildPlaybook({
  generated_at: "2026-11-23T10:00:00Z",
  scene_flows: [
    { scene: "station", runs: 40, ops: 4, steps: ["route_id[]", "station_id[]"], variants: 2 },
  ],
});
assert(stationOnly.build_v >= 10, "station-only build_v10");
for (const sc of ["area", "cond", "search", "list"] as const) {
  assert(!!stationOnly.scenes.find((s) => s.scene === sc), "inject scene " + sc);
}
assert(
  stationOnly.scenes.find((s) => s.scene === "cond")!.steps.some((t) => /外しだけで終わらない|条件を1つずつ/.test(t)),
  "cond guide mentions fill",
);
assert(
  !stationOnly.gaps.some((g) => /一連の流れ「検索押下の把握」に紐づく場面 search が手順に無い/.test(g)),
  "flow_series search scene present after inject",
);

console.log("playbook-search-extra-guides.test OK");
