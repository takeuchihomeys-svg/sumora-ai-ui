/**
 * 一括パネル把握文（決定論）
 * npx tsx app/lib/__tests__/bulk-panel-grasp.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PANEL_PHASE_WORDS, bulkGraspFromQueue, fillAfter, formatBulkPanelGrasp } from "../bulk-panel-grasp";

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
  assert(!!withMove && withMove.next.includes("次の動き:" + fillAfter(PANEL_PHASE_WORDS.reset.next, "やまださん")), "nextMove=" + withMove?.next);
  assert(!!withMove && /動やまださんの条件/.test(withMove.grasp), "grasp move=" + withMove?.grasp);
  assert(!!withMove && !/\{after\}/.test(withMove.next + withMove.grasp), "{after} が残らない");
  assert(!!withMove && withMove.now.includes(PANEL_PHASE_WORDS.fill.now), "now action from move=" + withMove?.now);

  const clearing = formatBulkPanelGrasp({
    total: 2, index: 2, currentName: "やまだ", nextName: "",
    nextMove: "リセットで空にして次のお客さんへ", currentAction: "外している最中",
  });
  assert(!!clearing && clearing.now.includes(PANEL_PHASE_WORDS.reset.now) && !/外している最中/.test(clearing.now), "外す中→手順書の言葉 now=" + clearing?.now);
  assert(!!clearing && clearing.next.includes(fillAfter(PANEL_PHASE_WORDS.reset.next, "次のお客さん")), "外す中 next=" + clearing?.next);

  const taskClear = formatBulkPanelGrasp({
    total: 2, index: 1, currentName: "てん", nextName: "やまだ",
    nextMove: "次の間取を外す", taskNow: "間取外:2LDK",
  });
  assert(!!taskClear && /間取外:2LDK/.test(taskClear.now), "taskNow now=" + taskClear?.now);
  assert(!!taskClear && taskClear.next.includes(fillAfter(PANEL_PHASE_WORDS.reset.next, "やまださん")), "taskNow next=" + taskClear?.next);

  const last = formatBulkPanelGrasp({ total: 2, index: 2, currentName: "最終", nextName: "" });
  assert(!!last && /一括の最後/.test(last.next), "最後 next");
  console.log("  ✓ 決定表OK");
}

// ★ 2.8.329 竹内さん「表記にずれのない内容にする」: リセットの「つぎ」は位置で誰の条件かが変わる（構造で見る）
console.log("■ リセットの位置で つぎ の名前が変わる");
{
  const base = { total: 3, index: 2, currentName: "たなか", nextName: "すずき", currentAction: "リセットを押す最中" };
  const pre = formatBulkPanelGrasp({ ...base, resetPos: "pre_fill" });
  assert(!!pre && pre.next.startsWith("次の動き:たなかさんの条件"), "入れる前＝いまの客 next=" + pre?.next);
  assert(!!pre && /その次の客は すずきさん/.test(pre.next) && !/^次は /.test(pre.next), "入れる前は「次は 次の客」と言わない next=" + pre?.next);
  const post = formatBulkPanelGrasp({ ...base, resetPos: "post_send" });
  assert(!!post && /^次は すずきさん／次の動き:すずきさんの条件/.test(post.next), "送付のあと＝次の客 next=" + post?.next);
  const unknown = formatBulkPanelGrasp({ ...base });
  assert(!!unknown && /次の動き:すずきさんの条件/.test(unknown.next), "位置不明は次の客 next=" + unknown?.next);
  for (const r of [pre, post, unknown]) assert(!!r && !/\{after\}/.test(r.now + r.next + r.grasp), "{after} が残らない");
  console.log("  ✓ 位置OK");
}

// ★ 2.8.329 実測 #1677: 枠に「handoff」がそのまま出た。英字だけの段名は出さない
console.log("■ 英字の段名を出さない");
{
  for (const raw of ["handoff", "list_done", "ready_next", "next_clear", "zzz_unknown"]) {
    const r = formatBulkPanelGrasp({ total: 2, index: 1, currentName: "てん", nextName: "やまだ", currentAction: raw });
    assert(!!r && !/[a-z]{3,}/.test(r.now + r.next + r.grasp), raw + " が出た now=" + r?.now + " grasp=" + r?.grasp);
  }
  console.log("  ✓ 出ない");
}

// 拡張の写し（bulk-panel-grasp.js）が TS と同じ文を返す
console.log("■ JS の写しが同じ文");
{
  const src = readFileSync(join(process.cwd(), "chrome-extension/bulk-panel-grasp.js"), "utf8");
  const sandbox: Record<string, unknown> = {};
  new Function("window", "module", src)(sandbox, undefined);
  const js = (sandbox as { AxlxBulkPanelGrasp?: { formatBulkPanelGrasp: typeof formatBulkPanelGrasp } }).AxlxBulkPanelGrasp;
  assert(!!js, "写しが読めない");
  const cases = [
    { total: 3, index: 2, currentName: "たなか", nextName: "すずき", currentAction: "リセットを押す最中", resetPos: "pre_fill" },
    { total: 3, index: 2, currentName: "たなか", nextName: "すずき", currentAction: "リセットを押す最中", resetPos: "post_send" },
    { total: 2, index: 1, currentName: "てん", nextName: "やまだ", nextMove: "条件を1つずつ入れる" },
    { total: 2, index: 1, currentName: "てん", nextName: "やまだ", currentAction: "handoff" },
  ];
  for (const c of cases) {
    const a = JSON.stringify(formatBulkPanelGrasp(c));
    const b = JSON.stringify(js!.formatBulkPanelGrasp(c));
    assert(a === b, "TS と JS が違う\n TS=" + a + "\n JS=" + b);
  }
  console.log("  ✓ 同じ");
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
