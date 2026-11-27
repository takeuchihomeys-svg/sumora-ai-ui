/**
 * 流れの地図（loop-flow-map.ts）の試験 — 2.8.319 の後の土台強化
 *   「前提や流れを理解せずに変更した」を繰り返さないための土台（竹内さん 2026-11-27）。
 *   ・地図の形（順に行う手／分かれ道／合流）が正しい
 *   ・どの分かれ道も客完了に合流し、客完了はリセットへ戻る（リセットからの流れは同じ）
 *   ・地図の目印・点検の印が拡張のコードに実在する
 *   ・手順書の一覧の手は地図から作られていて、分かれ道が通し番号の手として並ばない
 *   ・悪い地図（分かれ道が一列・合流しない・合流点が2つ・目印なし）を止められる（自己点検）
 * npx tsx app/lib/__tests__/loop-flow-map.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOOP_FLOW_NODES, checkFlowMap, renderListPressSteps, branchesOf, canReach, flowNode, type FlowNode,
} from "../loop-flow-map";
import { PLAYBOOK_LIST_AD_SORT_STEPS } from "../action-playbook";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (detail ? " :: " + detail : "")); }
}
const clone = (): FlowNode[] => JSON.parse(JSON.stringify(LOOP_FLOW_NODES)) as FlowNode[];

console.log("■ 1. 地図の形");
{
  const p = checkFlowMap();
  ok("今の地図に形の問題が無い", p.length === 0, p.join(" / "));
  const press = flowNode("list_press")!;
  const brs = branchesOf("list_press");
  ok("印刷用PDFを押す手に分かれ道が3つぶら下がる（全部送付済み→次へ／次頁も・最後まで／0件）", brs.length === 3 && press.kind === "step");
  ok("分かれ道は全部 branch で、条件（when）を持つ", brs.every((b) => b.kind === "branch" && !!b.when));
  ok("客完了（join）は1つだけ", LOOP_FLOW_NODES.filter((n) => n.kind === "join").length === 1);
}

console.log("■ 2. どの分かれ道も 客完了→リセットへ合流する（リセットからの流れは同じ）");
{
  for (const b of LOOP_FLOW_NODES.filter((n) => n.kind === "branch")) {
    ok(`${b.id} → 客完了に着く`, canReach(b.id, "customer_done"));
  }
  ok("客完了の次はリセット（次のお客さんへ戻る）", flowNode("customer_done")!.next.join() === "reset");
  ok("リセットから 客完了 に着ける（1人ぶんが終わる）", canReach("reset", "customer_done"));
  ok("0件の分かれ道はリセットを通らず次の客へ飛ばない（客完了を通る）", flowNode("b_zero")!.next.join() === "customer_done");
}

console.log("■ 3. 目印・点検の印が拡張のコードに実在する");
{
  const root = process.cwd();
  const src: Record<string, string> = {};
  const read = (f: string) => (src[f] ??= readFileSync(join(root, "chrome-extension", f), "utf8"));
  for (const n of LOOP_FLOW_NODES) {
    ok(`${n.id}: ${n.evidence.file} に ${n.evidence.token} がある`, read(n.evidence.file).includes(n.evidence.token));
  }
  const sa = read("search-audit.js");
  const keep = /var KEEP_STEP = (\/.*\/[a-z]*);/.exec(sa);
  const rule = /var RULE_STEP = (\/.*\/[a-z]*);/.exec(sa);
  ok("search-audit.js の KEEP_STEP／RULE_STEP を読めた", !!keep && !!rule);
  if (keep && rule) {
    const K = new Function("return " + keep[1])() as RegExp;
    const R = new Function("return " + rule[1])() as RegExp;
    for (const n of LOOP_FLOW_NODES) for (const a of n.audit) {
      ok(`${n.id}: 点検の印 ${a} が KEEP_STEP か RULE_STEP に残る`, K.test(a) || R.test(a));
    }
  }
}

console.log("■ 4. 手順書の一覧の手は地図から作られる・分かれ道が一列に並ばない");
{
  const tail = PLAYBOOK_LIST_AD_SORT_STEPS.slice(3);
  ok("④から先が地図の描き出しと同じ（手で書き足していない）", JSON.stringify(tail) === JSON.stringify(renderListPressSteps()), tail.join(" | ").slice(0, 120));
  ok("①②③は並べ替えの手のまま", /^①/.test(PLAYBOOK_LIST_AD_SORT_STEPS[0]) && /^②/.test(PLAYBOOK_LIST_AD_SORT_STEPS[1]) && /^③/.test(PLAYBOOK_LIST_AD_SORT_STEPS[2]));
  ok("④が「④の1〜3は場合分け・順に行う手ではない」と言う", /^④[^\n]*④の1〜3[^\n]*順に行う手ではない/.test(tail[0]), tail[0]);
  ok("分かれ道は「④の1」「④の2」「④の3」で、④の場合分けと書く", [1, 2, 3].every((k) => tail[k]?.startsWith(`④の${k}（④の場合分け）`)));
  ok("通し番号は ④ と ⑤ だけ（⑥⑦⑧が無い・分かれ道に通し番号が付かない）", !/[⑥⑦⑧⑨]/.test(tail.join("")) && /^⑤客完了/.test(tail[4] || ""));
  ok("⑤ は ④で送り終えた・④の1〜3のどれでもリセットして次のお客さんへ、と言う", /^⑤客完了（④で送り終えた・④の1〜3のどれでも）→リセットを押して次のお客さんへ。リセットからの流れは同じ/.test(tail[4] || ""));
  // 枝を足したら数字も勝手に追従する（文を手で直さない）
  const m = clone();
  m.splice(m.findIndex((n) => n.id === "customer_done"), 0, {
    id: "b_extra", kind: "branch", label: "足した道", parent: "list_press", when: "試し", playbook: "試しの道",
    next: ["customer_done"], evidence: { file: "bulk-dl.js", token: "_sendBatchDone" }, audit: [],
  });
  const r = renderListPressSteps(m);
  ok("分かれ道を1つ足すと「④の1〜4」「④の4」になり、通し番号は⑤のまま", /④の1〜4/.test(r[0]) && r[4]?.startsWith("④の4（④の場合分け）") && /^⑤客完了/.test(r[5] || ""), r.join(" | ").slice(0, 160));
}

console.log("■ 5. 悪い地図を止める（自己点検）");
{
  const bad = (mut: (m: FlowNode[]) => void): string[] => { const m = clone(); mut(m); return checkFlowMap(m); };
  const g = (m: FlowNode[], id: string) => m.find((n) => n.id === id)!;
  ok("分かれ道に親が無い（一列の手に見える）→止まる", bad((m) => { delete g(m, "b_zero").parent; }).some((s) => /親の手（parent）が無い/.test(s)));
  ok("分かれ道に条件が無い→止まる", bad((m) => { g(m, "b_zero").when = ""; }).some((s) => /条件（when）が無い/.test(s)));
  ok("分かれ道が step になっている（通し番号が付いてしまう形）→止まる", bad((m) => { g(m, "b_zero").kind = "step"; }).some((s) => /branch ではないのに parent/.test(s)));
  ok("分かれ道が客完了に合流しない→止まる", bad((m) => { g(m, "b_zero").next = ["reset"]; g(m, "b_zero").kind = "branch"; m.forEach((n) => { if (n.id !== "b_zero") n.next = n.next.filter((x) => x !== "customer_done" || n.id === "customer_done" || n.id === "b_all_sent_last" || n.id === "list_press"); }); g(m, "b_all_sent_last").next = ["list_press"]; g(m, "list_press").next = ["list_press", "b_all_sent_next", "b_all_sent_last"]; }).some((s) => /合流しない/.test(s)));
  ok("客完了が2つ→止まる", bad((m) => { g(m, "fill").kind = "join"; }).some((s) => /join（合流点＝客完了）は1つだけ/.test(s)));
  ok("客完了からリセットに戻れない→止まる", bad((m) => { g(m, "customer_done").next = []; }).some((s) => /次は step（リセット）/.test(s) || /戻れない/.test(s)));
  ok("コードの目印が無い→止まる", bad((m) => { g(m, "b_zero").evidence = { file: "", token: "" }; }).some((s) => /目印（evidence）が無い/.test(s)));
  ok("行き先が実在しない→止まる", bad((m) => { g(m, "fill").next = ["nowhere"]; }).some((s) => /実在しない/.test(s)));
  ok("孤立したノード→止まる", bad((m) => { m.push({ id: "lonely", kind: "step", label: "孤立", next: [], evidence: { file: "bulk-dl.js", token: "x" }, audit: [] }); }).some((s) => /孤立/.test(s)));
}

console.log("■ 6. 直す前の決まりが書いてある（消えたら止まる）");
{
  const root = process.cwd();
  for (const f of ["CLAUDE.md", ".cursor/rules/sumora-ai-ui.mdc"]) {
    const t = readFileSync(join(root, f), "utf8");
    ok(`${f} に「直す前に前提と流れを理解」・地図・道具が書いてある`, /直す前に「前提と流れ」を理解してから書く/.test(t) && t.includes("loop-flow-map.ts") && t.includes("change-premise.ts"));
  }
  ok("道具 scripts/change-premise.ts がある", readFileSync(join(root, "scripts/change-premise.ts"), "utf8").includes("理解の書面"));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("loop-flow-map.test OK");
