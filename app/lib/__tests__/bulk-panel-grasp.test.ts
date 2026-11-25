/**
 * 一括パネル把握文（決定論）
 * npx tsx app/lib/__tests__/bulk-panel-grasp.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bulkGraspFromQueue, formatBulkPanelGrasp } from "../bulk-panel-grasp";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
}

console.log("■ 決定表");
{
  assert(formatBulkPanelGrasp(null) === null, "null");
  assert(formatBulkPanelGrasp({ total: 0, index: 0 }) === null, "total0");
  const start = formatBulkPanelGrasp({ total: 11, index: 0, nextName: "てん" });
  assert(!!start && /一括11人を把握/.test(start.now), "開始前 now=" + start?.now);
  assert(!!start && /次は てんさん/.test(start.next), "開始前 next");
  assert(!!start && start.graspOk && /✓把握/.test(start.grasp), "開始前 grasp");

  const mid = formatBulkPanelGrasp({ total: 11, index: 3, currentName: "てん", nextName: "やまだ" });
  assert(!!mid && /てんさんを検索中（3\/11）/.test(mid.now), "途中 now=" + mid?.now);
  assert(!!mid && mid.next === "次は やまださん", "途中 next");
  assert(!!mid && /いまてん/.test(mid.grasp) && /次やまだ/.test(mid.grasp), "途中 grasp");

  const withMove = formatBulkPanelGrasp({
    total: 2, index: 1, currentName: "てん", nextName: "やまだ", nextMove: "条件を1つずつ入れる",
  });
  assert(!!withMove && /次の動き:条件を1つずつ入れる/.test(withMove.next), "nextMove=" + withMove?.next);
  assert(!!withMove && /動条件/.test(withMove.grasp), "grasp move");
  assert(!!withMove && /入れている最中/.test(withMove.now), "now action from move=" + withMove?.now);

  const clearing = formatBulkPanelGrasp({
    total: 2, index: 2, currentName: "やまだ", nextName: "",
    nextMove: "前客の選択を1つずつ外す", currentAction: "外している最中",
  });
  assert(!!clearing && /外している最中/.test(clearing.now), "外す中 now=" + clearing?.now);
  assert(!!clearing && /新しいお客さんの条件を入れる/.test(clearing.next), "外す中 next=" + clearing?.next);

  const taskClear = formatBulkPanelGrasp({
    total: 2, index: 1, currentName: "てん", nextName: "やまだ",
    nextMove: "次の間取を外す", taskNow: "間取外:2LDK",
  });
  assert(!!taskClear && /間取外:2LDK/.test(taskClear.now), "taskNow now=" + taskClear?.now);
  assert(!!taskClear && /新しいお客さんの条件を入れる/.test(taskClear.next), "taskNow next=" + taskClear?.next);

  const last = formatBulkPanelGrasp({ total: 2, index: 2, currentName: "最終", nextName: "" });
  assert(!!last && /一括の最後/.test(last.next), "最後 next");
  console.log("  ✓ 決定表OK");
}

console.log("■ キューから");
{
  const g = bulkGraspFromQueue(["てん", "やまだ", "すずき"], 1);
  assert(g.index === 2 && g.currentName === "やまだ" && g.nextName === "すずき", JSON.stringify(g));
  console.log("  ✓ キューOK");
}

console.log("■ 拡張配線");
{
  const bulk = readFileSync(join(process.cwd(), "chrome-extension/bulk-dl.js"), "utf8");
  const bg = readFileSync(join(process.cwd(), "chrome-extension/background.js"), "utf8");
  const man = JSON.parse(readFileSync(join(process.cwd(), "chrome-extension/manifest.json"), "utf8"));
  assert(String(man.version) >= "2.8.219", "ver");
  assert(bulk.includes("axlx-grasp") && bulk.includes("_applyBulkGrasp"), "panel grasp");
  assert(bulk.includes("axlx-bulk-grasp"), "message");
  assert(bg.includes("_publishBulkGrasp") && bg.includes("bulk-panel-grasp.js"), "bg publish");
  assert(String(man.content_scripts || "").includes("bulk-panel-grasp.js") ||
    JSON.stringify(man).includes("bulk-panel-grasp.js"), "manifest loads grasp js");
  console.log("  ✓ 配線OK");
}

console.log("bulk-panel-grasp.test OK");
