/**
 * 流れの地図（loop-flow-map.ts）の試験 — 2.8.319 の後の土台強化（失敗の道・2.8.320）
 *   「前提や流れを理解せずに変更した」を繰り返さないための土台（竹内さん 2026-11-27）。
 *   ・地図の形（順に行う手／分かれ道／合流）が正しい
 *   ・分かれ道は 客完了・親の手・次のお客さんの読み直し にしか出られない（勝手に別の手へ飛ばない）
 *   ・どの分かれ道も客完了に合流し、客完了はリセット（reset_front）へ戻る（リセットからの流れは同じ）
 *   ・失敗の道（リセットが押せない・読み直せない）と割り込み（裏が起き直す・タブが見えない）が地図にある
 *   ・地図の目印・点検の印が拡張のコードに実在し、点検が残る段に落ちない
 *   ・手順書の一覧の手は地図から作られる
 *   ・悪い地図（分かれ道が一列・許されない行き先・合流が無い・目印なし）を止められる（自己点検）
 * npx tsx app/lib/__tests__/loop-flow-map.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOOP_FLOW_NODES, LOOP_INTERRUPTS, checkFlowMap, checkInterrupts, checkListPlaybookStrength, renderListPressSteps,
  branchesOf, canReach, flowNode, type FlowNode, type FlowInterrupt,
} from "../loop-flow-map";
import { PLAYBOOK_LIST_AD_SORT_STEPS } from "../action-playbook";
import { AUTO_RULES } from "../auto-procedure-rules";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (detail ? " :: " + detail : "")); }
}
const clone = (): FlowNode[] => JSON.parse(JSON.stringify(LOOP_FLOW_NODES)) as FlowNode[];
const cloneI = (): FlowInterrupt[] => JSON.parse(JSON.stringify(LOOP_INTERRUPTS)) as FlowInterrupt[];

console.log("■ 1. 地図の形");
{
  const p = checkFlowMap();
  ok("今の地図に形の問題が無い", p.length === 0, p.join(" / "));
  const press = flowNode("list_press")!;
  const brs = branchesOf("list_press");
  ok("印刷用PDFを押す手に分かれ道が3つぶら下がる（全部送付済み→次へ／次頁も・最後まで／0件）", brs.length === 3 && press.kind === "step");
  ok("分かれ道は全部 branch で、条件（when）を持つ", LOOP_FLOW_NODES.filter((n) => n.kind === "branch").every((b) => !!b.when));
  ok("客完了（join）は1つだけ", LOOP_FLOW_NODES.filter((n) => n.kind === "join").length === 1);
  ok("最初の手は リセット前の見え方の確認（reset_front）", LOOP_FLOW_NODES.find((n) => n.kind === "step")?.id === "reset_front");
}

console.log("■ 2. 合流とリセットの戻り（リセットからの流れは同じ）");
{
  for (const b of LOOP_FLOW_NODES.filter((n) => n.kind === "branch")) {
    ok(`${b.id} → 客完了に着く`, canReach(b.id, "customer_done"));
  }
  ok("客完了の次はリセット前の確認（reset_front）→ リセット", flowNode("customer_done")!.next.join() === "reset_front" && flowNode("reset_front")!.next.join() === "reset");
  ok("リセットから 客完了 に着ける（1人ぶんが終わる）", canReach("reset", "customer_done"));
  ok("0件の分かれ道はリセットを通らず次の客へ飛ばない（客完了を通る）", flowNode("b_zero")!.next.join() === "customer_done");
}

console.log("■ 3. 失敗の道（リセットが押せない・読み直せない）");
{
  const resetBr = branchesOf("reset").map((b) => b.id).sort().join(",");
  ok("リセットの失敗の道は3本（返事が遅れた／もう1回／従来の外し）", resetBr === "b_reset_fallback,b_reset_late,b_reset_retry", resetBr);
  ok("読み直しの失敗の道は1本（このお客さんを飛ばす）", branchesOf("api_reload").map((b) => b.id).join() === "b_api_skip");
  ok("失敗の道は全部 次のお客さんの読み直し（api_reload）か客完了へ出る", ["b_reset_late", "b_reset_retry", "b_reset_fallback", "b_api_skip"].every((id) => {
    const b = flowNode(id)!;
    return b.next.every((x) => x === "api_reload" || x === "customer_done");
  }));
  ok("読めなかった客は飛ばす（古い条件で検索しない）と文に書いてある", /古い条件では検索せず/.test(flowNode("b_api_skip")!.playbook || ""));
  ok("押した跡があれば、もう1回押さずに先へ進むと文に書いてある", /もう1回押さない/.test(flowNode("b_reset_late")!.playbook || ""));
}

console.log("■ 4. 割り込み（どの段でも起きうる回復）");
{
  const p = checkInterrupts();
  ok("割り込みの形に問題が無い", p.length === 0, p.join(" / "));
  const ids = LOOP_INTERRUPTS.map((i) => i.id).sort().join(",");
  ok("割り込みは3つ（裏が起き直す／入力の仕組みが応答しない／タブが見えないまま止まる）", ids === "i_sw_restart,i_tab_hidden_stall,i_tab_reload", ids);
  ok("割り込みは流れの途中の分岐にしていない（どの段からも同じ回復）", LOOP_FLOW_NODES.every((n) => !/sw_restart|tab_hidden_stall|tab_reload/.test(n.id)));
  ok("割り込みには実測の回が書いてある", LOOP_INTERRUPTS.every((i) => /#\d+/.test(i.seen)));
}

console.log("■ 5. 目印・点検の印が拡張のコードに実在する（点検が残る段に落ちない）");
{
  const root = process.cwd();
  const src: Record<string, string> = {};
  const read = (f: string) => (src[f] ??= readFileSync(join(root, "chrome-extension", f), "utf8"));
  for (const n of LOOP_FLOW_NODES) {
    ok(`${n.id}: ${n.evidence.file} に ${n.evidence.token} がある`, read(n.evidence.file).includes(n.evidence.token));
  }
  for (const i of LOOP_INTERRUPTS) {
    ok(`割り込み ${i.id}: ${i.evidence.file} に ${i.evidence.token} がある`, read(i.evidence.file).includes(i.evidence.token));
  }
  const sa = read("search-audit.js");
  const keep = /var KEEP_STEP = (\/.*\/[a-z]*);/.exec(sa);
  const rule = /var RULE_STEP = (\/.*\/[a-z]*);/.exec(sa);
  ok("search-audit.js の KEEP_STEP／RULE_STEP を読めた", !!keep && !!rule);
  if (keep && rule) {
    const K = new Function("return " + keep[1])() as RegExp;
    const R = new Function("return " + rule[1])() as RegExp;
    const kept = (a: string) => K.test(a) || R.test(a);
    for (const n of LOOP_FLOW_NODES) for (const a of n.audit) {
      ok(`${n.id}: 点検の印 ${a} が KEEP_STEP か RULE_STEP に残る`, kept(a));
    }
    for (const i of LOOP_INTERRUPTS) for (const a of i.audit) {
      ok(`割り込み ${i.id}: 点検の印 ${a} が KEEP_STEP か RULE_STEP に残る`, kept(a));
    }
  }
}

console.log("■ 6. 手順書の一覧の手は地図から作られる・分かれ道が一列に並ばない");
{
  const tail = PLAYBOOK_LIST_AD_SORT_STEPS.slice(3);
  ok("④から先が地図の描き出しと同じ（手で書き足していない）", JSON.stringify(tail) === JSON.stringify(renderListPressSteps()), tail.join(" | ").slice(0, 120));
  ok("①②③は並べ替えの手のまま", /^①/.test(PLAYBOOK_LIST_AD_SORT_STEPS[0]) && /^②/.test(PLAYBOOK_LIST_AD_SORT_STEPS[1]) && /^③/.test(PLAYBOOK_LIST_AD_SORT_STEPS[2]));
  ok("④が「④の1〜3は場合分け・順に行う手ではない」と言う", /^④[^\n]*④の1〜3[^\n]*順に行う手ではない/.test(tail[0]), tail[0]);
  ok("分かれ道は「④の1」「④の2」「④の3」で、④の場合分けと書く", [1, 2, 3].every((k) => tail[k]?.startsWith(`④の${k}（④の場合分け）`)));
  ok("通し番号は ④ と ⑤ だけ（⑥⑦⑧が無い・分かれ道に通し番号が付かない）", !/[⑥⑦⑧⑨]/.test(tail.join("")) && /^⑤客完了/.test(tail[4] || ""));
  ok("⑤ は ④で送り終えた・④の1〜3のどれでもリセットして次のお客さんへ、と言う", /^⑤客完了（④で送り終えた・④の1〜3のどれでも）→リセットを押して次のお客さんへ。リセットからの流れは同じ/.test(tail[4] || ""));
  const strong = checkListPlaybookStrength(PLAYBOOK_LIST_AD_SORT_STEPS);
  ok("③④は地図の完了の文をそのまま載せている", strong.length === 0, strong.join(" / "));
  const stripped = PLAYBOOK_LIST_AD_SORT_STEPS.map((s) => s.startsWith("③") ? s.replace(flowNode("sort")!.playbook || "___", "") : s);
  ok("③から完了の文を消すと止まる（コードだけ直して手順書が古いまま、を止める）", checkListPlaybookStrength(stripped).some((x) => /③に地図/.test(x)));
  const rule = AUTO_RULES.find((r) => r.id === "sort_pressed_then_list");
  ok("決まりの文も地図の完了の文を含む（手と決まりがずれない）", !!rule && rule.text.includes(flowNode("sort")!.playbook || "___"));
  const m = clone();
  m.splice(m.findIndex((n) => n.id === "customer_done"), 0, {
    id: "b_extra", kind: "branch", label: "足した道", parent: "list_press", when: "試し", playbook: "試しの道",
    next: ["customer_done"], evidence: { file: "bulk-dl.js", token: "_sendBatchDone" }, audit: ["dl:zero_count0_finish"],
  });
  const r = renderListPressSteps(m);
  ok("分かれ道を1つ足すと「④の1〜4」「④の4」になり、通し番号は⑤のまま", /④の1〜4/.test(r[0]) && r[4]?.startsWith("④の4（④の場合分け）") && /^⑤客完了/.test(r[5] || ""), r.join(" | ").slice(0, 160));
}

console.log("■ 7. 悪い地図を止める（自己点検）");
{
  const bad = (mut: (m: FlowNode[]) => void): string[] => { const m = clone(); mut(m); return checkFlowMap(m); };
  const g = (m: FlowNode[], id: string) => m.find((n) => n.id === id)!;
  ok("分かれ道に親が無い（一列の手に見える）→止まる", bad((m) => { delete g(m, "b_zero").parent; }).some((s) => /親の手（parent）が無い/.test(s)));
  ok("分かれ道に条件が無い→止まる", bad((m) => { g(m, "b_zero").when = ""; }).some((s) => /条件（when）が無い/.test(s)));
  ok("分かれ道が step になっている（通し番号が付いてしまう形）→止まる", bad((m) => { g(m, "b_zero").kind = "step"; }).some((s) => /branch ではないのに parent/.test(s)));
  ok("分かれ道が勝手に別の手へ飛ぶ（押せない時の道が fill へ直行）→止まる", bad((m) => { g(m, "b_reset_retry").next = ["fill"]; }).some((s) => /は許されない/.test(s)));
  ok("失敗の道が客完了を通らずに次の手へ行く（b_reset_fallback→search）→止まる", bad((m) => { g(m, "b_reset_fallback").next = ["search"]; }).some((s) => /は許されない/.test(s)));
  ok("客完了が2つ→止まる", bad((m) => { g(m, "fill").kind = "join"; }).some((s) => /join（合流点＝客完了）は1つだけ/.test(s)));
  ok("客完了からリセット（reset_front）に戻らない→止まる", bad((m) => { g(m, "customer_done").next = ["reset"]; }).some((s) => /reset_front/.test(s)));
  ok("コードの目印が無い→止まる", bad((m) => { g(m, "b_zero").evidence = { file: "", token: "" }; }).some((s) => /目印（evidence）が無い/.test(s)));
  ok("点検の印が無い→止まる", bad((m) => { g(m, "b_zero").audit = []; }).some((s) => /点検の印（audit）が無い/.test(s)));
  ok("行き先が実在しない→止まる", bad((m) => { g(m, "fill").next = ["nowhere"]; }).some((s) => /実在しない/.test(s)));
  ok("孤立したノード→止まる", bad((m) => { m.push({ id: "lonely", kind: "step", label: "孤立", next: [], evidence: { file: "bulk-dl.js", token: "x" }, audit: ["x"] }); }).some((s) => /孤立/.test(s)));
  // 割り込みの自己点検
  const badI = (mut: (l: FlowInterrupt[]) => void): string[] => { const l = cloneI(); mut(l); return checkInterrupts(l); };
  ok("割り込みに目印が無い→止まる", badI((l) => { l[0].evidence = { file: "", token: "" }; }).some((s) => /目印/.test(s)));
  ok("割り込みに起きた後の動きが無い→止まる", badI((l) => { l[1].resume = ""; }).some((s) => /resume/.test(s)));
  ok("割り込みに点検の印が無い→止まる", badI((l) => { l[2].audit = []; }).some((s) => /点検の印/.test(s)));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("loop-flow-map.test OK");
