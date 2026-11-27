/**
 * 押したことの把握（2.8.328）の試験 — 竹内さん 2026-11-27「ちゃんと押したら押したってこと理解できるように
 *   それぞれの手順書のところでもボタンをおしたってことの把握がちゃんとすれば改善される」
 *   ・ボタンを押す手には全部 presses（押した／効いた／効かない時）がある（形の点検・悪い地図を止める）
 *   ・押した印・効いた印・失敗の印が拡張のコードで実際に出されている（幽霊の印を止める）
 *   ・その印が点検の上限で捨てられない（KEEP_STEP か RULE_STEP・ページ側は _PIN にも）
 *   ・手順書の手と決まりに、地図から作った文がそのまま載っている（抜けたら止める）
 * npx tsx app/lib/__tests__/press-grasp-map.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOOP_FLOW_NODES, PRESS_REQUIRED_NODES, checkPresses, checkPressPlaybook, pressLine, pressLinesOf, renderListPressSteps,
  type FlowNode,
} from "../loop-flow-map";
import {
  PLAYBOOK_AREA_CONFIRM_STEPS, PLAYBOOK_FLOW_SERIES, PLAYBOOK_LIST_AD_SORT_STEPS, PLAYBOOK_SEARCH_GRASP_STEPS,
} from "../action-playbook";
import { AUTO_RULES } from "../auto-procedure-rules";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (detail ? " :: " + detail : "")); }
}
const clone = (): FlowNode[] => JSON.parse(JSON.stringify(LOOP_FLOW_NODES)) as FlowNode[];
const EXT = join(process.cwd(), "chrome-extension");
const src = {
  page: readFileSync(join(EXT, "page-script.js"), "utf8"),
  dl: readFileSync(join(EXT, "bulk-dl.js"), "utf8"),
  bg: readFileSync(join(EXT, "background.js"), "utf8"),
  audit: readFileSync(join(EXT, "search-audit.js"), "utf8"),
};
const allPresses = LOOP_FLOW_NODES.flatMap((n) => (n.presses || []).map((p) => ({ node: n.id, p })));

console.log("■ 1. 地図の押す物の形");
{
  const e = checkPresses();
  ok("今の地図に押す物の形の問題が無い", e.length === 0, e.join(" / "));
  ok("押す手（リセット・入力・検索・並べ替え・印刷用PDF・次へ）が全部 presses を持つ",
    PRESS_REQUIRED_NODES.every((id) => (LOOP_FLOW_NODES.find((n) => n.id === id)?.presses || []).length > 0));
  const buttons = allPresses.map((x) => x.p.button);
  for (const b of ["リセット", "所在地絞り込み", "駅の設定へ進む", "確定してリストへ", "検索", "高→低", "印刷用PDF", "次へ"]) {
    ok(`押す物「${b}」が地図にある`, buttons.includes(b));
  }
  ok("どの押す物も効いた（高→低は時間差の認識）のを待ってから次の手へ", allPresses.every((x) => x.p.gate));
  ok("高→低の効いたは時間差で認識する（画面から確かめきれないため）",
    /時間差/.test(allPresses.find((x) => x.p.button === "高→低")?.p.effectJa || ""));
}

console.log("■ 2. 悪い地図を止める（自己点検）");
{
  const a = clone(); a.find((n) => n.id === "fill")!.presses = [];
  ok("押す手から presses を消すと止まる", checkPresses(a).some((t) => /fill はボタンを押す手なのに/.test(t)));
  const b = clone(); const pb = b.find((n) => n.id === "search")!.presses![0]; pb.effect = [...pb.receipt];
  ok("効いた印を押した印と同じにすると止まる（押した＝効いた、の取り違え）", checkPresses(b).some((t) => /押した≠効いた/.test(t)));
  const c = clone(); const pc = c.find((n) => n.id === "sort")!.presses![0]; pc.gate = false; pc.onFail = "そのまま進む";
  ok("待たない押す物が「記録」を書かないと止まる（黙って進む）", checkPresses(c).some((t) => /黙って進む/.test(t)));
  const d = clone(); d.find((n) => n.id === "list_press")!.presses![0].effect = [];
  ok("効いた印が空だと止まる", checkPresses(d).some((t) => /効いた印が無い/.test(t)));
  const f = clone(); f.find((n) => n.id === "reset")!.presses![0].fail = [];
  ok("失敗の印が空だと止まる", checkPresses(f).some((t) => /押せなかった・効かなかった印が無い/.test(t)));
}

console.log("■ 3. 印が拡張のコードで実際に出されている（幽霊の印を止める）");
/** 印がそのファイルで作られているか: 文字そのまま／press_ok_<種類>（_pressKindOf が種類を返す）／<領域>_press_ok（組み立て） */
function emitted(name: string, s: string): boolean {
  if (s.includes(`"${name}"`) || s.includes(`'${name}'`)) return true;
  const m = /^press_(ok|ng)_(.+)$/.exec(name);
  if (m && s.includes(`"press_${m[1]}_"`) && s.includes(`return "${m[2]}"`)) return true;
  const g = /^(\w+?)_press_(ok|fail)$/.exec(name);
  if (g && s.includes(`"_press_${g[2]}"`) && s.includes(`_verifyPressUnderstood("${g[1]}"`)) return true;
  return false;
}
function fileOf(mark: string): { body: string; name: string; label: string } {
  if (mark.startsWith("page:")) return { body: src.page, name: mark.slice(5), label: "page-script.js" };
  if (mark.startsWith("dl:")) return { body: src.dl, name: mark.slice(3), label: "bulk-dl.js" };
  return { body: src.bg, name: mark, label: "background.js" };
}
for (const { node, p } of allPresses) {
  for (const mark of [...p.receipt, ...p.effect, ...p.fail]) {
    const f = fileOf(mark);
    ok(`${node}「${p.button}」の印 ${mark} を ${f.label} が出す`, emitted(f.name, f.body));
  }
  const ev = p.evidence.file === "page-script.js" ? src.page : p.evidence.file === "bulk-dl.js" ? src.dl : src.bg;
  ok(`${node}「${p.button}」の目印 ${p.evidence.token} がコードにある`, ev.includes(p.evidence.token));
}

console.log("■ 4. 印が点検の上限で捨てられない");
function regexOf(body: string, varName: string): RegExp {
  const m = new RegExp(`var ${varName} = (\\/\\^.*\\/);`).exec(body);
  if (!m) throw new Error(`${varName} が見つからない`);
  return eval(m[1]) as RegExp;
}
const KEEP = regexOf(src.audit, "KEEP_STEP");
const RULE = regexOf(src.audit, "RULE_STEP");
const PIN = regexOf(src.page, "_PIN");
for (const { node, p } of allPresses) {
  for (const mark of [...p.receipt, ...p.effect, ...p.fail]) {
    ok(`${node}「${p.button}」の ${mark} が残る段（KEEP か RULE）`, KEEP.test(mark) || RULE.test(mark));
    if (mark.startsWith("page:")) ok(`  ページ側でも先に送る（_PIN）: ${mark}`, PIN.test(mark.slice(5)));
  }
}
ok("入力の終わりの数（page:press_sum）も残る", KEEP.test("page:press_sum") && PIN.test("press_sum"));

console.log("■ 5. 手順書・決まりに地図の文がそのまま載る");
{
  const rule = AUTO_RULES.find((r) => r.id === "press_grasp_each");
  ok("決まり press_grasp_each がある", !!rule);
  const e = checkPressPlaybook(rule?.text || "");
  ok("決まりに全部の押す物の文がある", e.length === 0, e.join(" / "));
  ok("決まりは入力の終わりの数で確かめる", JSON.stringify(rule?.verify || {}).includes("page:press_sum"));
  ok("拡張の『確かめ済みの決まり』に press_grasp_each がある", /"press_grasp_each"/.test(src.page));
  const has = (steps: ReadonlyArray<string>, re: RegExp, line: string) => steps.some((s) => re.test(s) && s.includes(line));
  const ln = (node: string, button: string) => pressLine(LOOP_FLOW_NODES.find((n) => n.id === node)!.presses!.find((p) => p.button === button)!);
  ok("所在地①に「所在地絞り込み」の把握", has(PLAYBOOK_AREA_CONFIRM_STEPS, /^①/, ln("fill", "所在地絞り込み")));
  ok("所在地③に「確定してリストへ」の把握", has(PLAYBOOK_AREA_CONFIRM_STEPS, /^③/, ln("fill", "確定してリストへ")));
  ok("検索①に「検索」の把握", has(PLAYBOOK_SEARCH_GRASP_STEPS, /^①/, ln("search", "検索")));
  ok("一覧③に「高→低」の把握", has(PLAYBOOK_LIST_AD_SORT_STEPS, /^③/, ln("sort", "高→低")));
  ok("一覧④に「印刷用PDF」の把握", has(PLAYBOOK_LIST_AD_SORT_STEPS, /^④(?!の)/, ln("list_press", "印刷用PDF")));
  ok("④の場合分け（全部送付済み→次へ）に「次へ」の把握", has(PLAYBOOK_LIST_AD_SORT_STEPS, /^④の\d/, ln("b_all_sent_next", "次へ")));
  ok("⑤客完了→リセットに「リセット」の把握", has(PLAYBOOK_LIST_AD_SORT_STEPS, /^⑤/, ln("reset", "リセット")));
  ok("一連の流れの before_clear に「リセット」の把握",
    (PLAYBOOK_FLOW_SERIES.find((f) => f.id === "before_clear")?.label || "").includes(ln("reset", "リセット")));
  ok("④から先は地図から作ったまま（手で書き足していない）",
    JSON.stringify(PLAYBOOK_LIST_AD_SORT_STEPS.slice(-renderListPressSteps().length)) === JSON.stringify(renderListPressSteps()));
  ok("押す物の無い手は文を作らない", pressLinesOf("customer_done").length === 0);
  ok("検索①は PDF の字を含まない（拡張の _pbListNext が一覧の手と取り違えない）", !/pdf/i.test(PLAYBOOK_SEARCH_GRASP_STEPS[0]));
  ok("悪い手順書（文が抜けた）を止める", checkPressPlaybook("検索を押す").length === allPresses.length);
}

console.log(`\n結果: ${passed} 通過 / ${failed} 失敗`);
if (failed) process.exit(1);
