// scripts/lib/__tests__/foundation-fill.test.ts — 土台の埋まりの表（npx tsx で回す）
import { foundationFillOf, fillTotalsOf, fillNotShrinking, foundationLeavesOf } from "../foundation-fill";
import { normTags } from "../../foundation-scene-grid";
import type { FoundationRow } from "../foundation-table";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };

const rows: FoundationRow[] = [
  { id: "n.a", name: "A", owner: "作業員L・作業員N", rules: ["x"], measures: ["s.ts"], metric: "m1", parts: ["SW_ON"] },
  { id: "n.b", name: "B", owner: "作業員K2", rules: [], measures: [], metric: null, parts: ["SW_OFF"] },
  { id: "g.c", name: "C", owner: "作業員G", rules: ["y"], measures: ["t.ts"], metric: "m2", parts: [] },
];
const gaps = [
  { id: "n.b", name: "B", owner: "作業員K2", missing: ["rules", "measures", "metric"] as Array<"rules" | "measures" | "metric" | "parts">, detail: "" },
  { id: "g.c", name: "C", owner: "作業員G", missing: ["parts"] as Array<"rules" | "measures" | "metric" | "parts">, detail: "" },
];
const grid = { scenes: ["s1", "s2", "s3"], grid: [
  { id: "n.a", measure: "場面ごと" as const, cells: { s1: 1, s2: 2, s3: 1 }, all: 0 },
  { id: "n.b", measure: "無い" as const, cells: { s1: 0, s2: 1, s3: 0 }, all: 0 },
] };
const fill = foundationFillOf(rows, gaps, grid, { metricSeen: (m) => m === "m1", switchDefault: (s) => (s === "SW_ON" ? "on" : s === "SW_OFF" ? "off" : null) });
const A = fill.find((r) => r.id === "n.a")!, B = fill.find((r) => r.id === "n.b")!, C = fill.find((r) => r.id === "g.c")!;
t("A は全部埋まる", A.cells.every((c) => c.filled), A.cells);
t("A は場面まで", A.depth === "場面まで", A.depth);
t("A の部品は on で正しい", A.cells.find((c) => c.col === "parts")!.correct === true);
t("A の決まりは未測定", A.cells.find((c) => c.col === "rules")!.correct === null);
t("A の持ち主は先頭", A.cells[0].owner === "作業員L");
t("B は一部の場面", B.depth === "一部の場面", B.depth);
t("B の空き場面 s1,s3", B.emptyScenes.join() === "s1,s3", B.emptyScenes);
t("B の部品は off＝正しくない", B.cells.find((c) => c.col === "parts")!.correct === false);
t("C は場面の欄なし", C.depth === "—" && C.cells.length === 4);
const tot = fillTotalsOf(fill, grid);
t("そろった 1", tot.full === 1, tot);
t("場面の空き 2", tot.sceneGap === 2, tot);
t("物差しの無い 1（B）", tot.noMeasure === 1 && tot.noMeasureNames[0] === "B", tot);
const ns = fillNotShrinking({ full: 1, n: 3, sceneGap: 2, noMeasure: 1 }, { full: 1, sceneGap: 2, noMeasure: 2 }, { sceneGap: ["作業員K2"], noMeasure: ["作業員K2"], notFull: ["作業員K2", "作業員G"] });
t("空きが減らない・そろいが増えない を出す（物差しは減った）", ns.length === 2 && ns[0].includes("場面の決まりの空き") && ns[1].includes("そろった"), ns);
t("前の日が無ければ出さない", fillNotShrinking({ full: 1, n: 3, sceneGap: 2, noMeasure: 1 }, { full: null, sceneGap: null, noMeasure: null }, { sceneGap: [], noMeasure: [], notFull: [] }).length === 0);
const alias = foundationFillOf([{ id: "k.x", name: "X", owner: "物件出し", rules: ["z"], measures: [], metric: null, parts: [] }], [], null, { metricSeen: () => false, switchDefault: () => null });
t("物件出し は作業員K2 に付け替える", alias[0].cells.every((c) => c.owner === "作業員K2"), alias[0].cells.map((c) => c.owner));
const leaves = foundationLeavesOf(fill, grid.scenes);
t("葉の鍵は found:<土台>:<場面>:<欄>", leaves.some((l) => l.key === "found:n.b:s1:scene_rules" && !l.filled && l.cause === "misread"));
t("場面の無い欄は all", leaves.some((l) => l.key === "found:n.b:all:measures" && l.cause === "measure"));
t("部品は material", leaves.some((l) => l.key === "found:n.a:all:parts" && l.cause === "material" && l.filled));
t("書き手の選び方は all", leaves.every((l) => l.writer_select === "all"));
t("札の表記ゆれを読み替える", normTags(["場面:物件オススメ", "場面:検討", "汎用"]).join() === "場面:物件を送る,場面:検討中,汎用");
console.log(`foundation-fill: ${pass} 通過・${fail} 失敗`);
if (fail) process.exit(1);
