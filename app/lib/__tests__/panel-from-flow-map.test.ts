/**
 * パネルの言葉が流れの地図から作られているか（2.8.323・竹内さん 2026-11-27
 *   「改善したらパネルも改善される仕組みちゃんとつくる／パネルに記載されている文字ちゃんと改善したながれにする」）。
 *
 * 見る物は「構造」: 地図に手を足したらパネルも決めさせる／つぎが次の段を指す／地図に無い道を言わない／
 *   拡張の写しが古くない／手で書いた古い言葉がコードに残らない／並べ替えは押した時点で物件取得の言葉へ。
 * 悪い地図（パネル無し・言葉の重なり・つぎが次を指さない・道が無い）を止める自己点検も含む。
 *
 * npx tsx app/lib/__tests__/panel-from-flow-map.test.ts
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  LOOP_FLOW_NODES,
  PANEL_PHASE_KEYS,
  checkPanelWords,
  panelPhaseWords,
  panelPhases,
  type FlowNode,
} from "../loop-flow-map";
import { PANEL_PHASE_WORDS, formatBulkPanelGrasp } from "../bulk-panel-grasp";
import { regenerate } from "../../../scripts/gen-panel-words";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
}
const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");
const req = createRequire(import.meta.url);
const js = req(join(root, "chrome-extension/bulk-panel-grasp.js"));

/** 地図をまるごと複製して、悪い形を作る（元は壊さない） */
function clone(): FlowNode[] {
  return JSON.parse(JSON.stringify(LOOP_FLOW_NODES)) as FlowNode[];
}
function withPanel(nodes: FlowNode[], phase: string) {
  for (const n of nodes) for (const p of n.panel || []) if (p.phase === phase) return p;
  throw new Error("段が無い: " + phase);
}

console.log("■ 今の地図のパネルは正しい");
{
  const bad = checkPanelWords();
  assert(bad.length === 0, "地図のパネルの言葉に問題: " + bad.join(" / "));
  const ps = panelPhases();
  assert(ps.length === PANEL_PHASE_KEYS.length && ps.every((p, i) => p.phase === PANEL_PHASE_KEYS[i]), "段が8つ・順番どおり");
  // 全部の手が panel か noPanel を持つ
  for (const n of LOOP_FLOW_NODES) assert(!!(n.panel?.length) !== !!n.noPanel, `${n.id} は panel か noPanel のどちらか1つ`);
  console.log("  ✓ 8段・全部の手がパネルか理由を持つ");
}

console.log("■ 悪い地図を止める（自己点検）");
{
  // ① 手を足したのにパネルを決めていない
  const a = clone();
  a.splice(a.findIndex((n) => n.id === "fill") + 1, 0, {
    id: "new_step", kind: "step", label: "新しい手", next: ["search"],
    evidence: { file: "page-script.js", token: "fill_done" }, audit: ["fill_done"],
  });
  assert(checkPanelWords(a).some((m) => /new_step[^\n]*panel[^\n]*noPanel/.test(m)), "手を足してパネルを決めていないのを止める: " + checkPanelWords(a).join("/"));
  // ② 言葉が別の段と同じ（古い言葉が別の段に残る）
  const b = clone();
  withPanel(b, "sort").now = withPanel(b, "list").now;
  assert(checkPanelWords(b).some((m) => /同じ＝古い言葉/.test(m)), "いまの言葉の重なりを止める");
  // ③ つぎが次の段を指していない
  const c = clone();
  withPanel(c, "sort").next = "リセットを押す";
  assert(checkPanelWords(c).some((m) => /つぎが次を指していない/.test(m)), "つぎが次の段を指さないのを止める");
  // ④ 地図に無い道をパネルが言う（検索のあとに客完了へ行くと言う）
  const d = clone();
  withPanel(d, "search").then = ["done"];
  withPanel(d, "search").next = "客完了";
  assert(checkPanelWords(d).some((m) => /地図の道が無い/.test(m)), "地図に無い流れをパネルが言うのを止める");
  // ⑤ 段が足りない
  const e = clone();
  const nx = e.find((n) => n.id === "b_all_sent_next")!;
  nx.panel = nx.panel!.filter((p) => p.phase !== "next_page");
  assert(checkPanelWords(e).some((m) => /next_page が地図に無い/.test(m)), "段が足りないのを止める");
  // ⑥ 客完了がリセットへ戻らない（輪が閉じない）
  const f = clone();
  withPanel(f, "done").then = ["list"];
  withPanel(f, "done").next = "物件取得";
  assert(checkPanelWords(f).some((m) => /done の次は reset/.test(m)), "輪が閉じないのを止める");
  // ⑦ switchTo が then に無い
  const g = clone();
  withPanel(g, "sort").switchTo = "done";
  assert(checkPanelWords(g).some((m) => /switchTo/.test(m)), "switchTo が then に無いのを止める");
  // ⑧ panel と noPanel の両方
  const h = clone();
  h.find((n) => n.id === "fill")!.noPanel = "両方持つ";
  assert(checkPanelWords(h).some((m) => /両方/.test(m)), "panel と noPanel の両方を止める");
  console.log("  ✓ 8つの悪い形を止める");
}

console.log("■ パネルの言葉は地図から作られ、写しが古くない");
{
  assert(JSON.stringify(PANEL_PHASE_WORDS) === JSON.stringify(panelPhaseWords()), "TS の PANEL_PHASE_WORDS が地図と違う（手で別に持っている）");
  assert(JSON.stringify(js.PANEL_PHASE_WORDS) === JSON.stringify(panelPhaseWords()), "bulk-panel-grasp.js が地図と違う");
  const bp = read("chrome-extension/bulk-panel-grasp.js");
  assert(regenerate(bp, "PANEL_PHASE_WORDS") === bp, "bulk-panel-grasp.js の生成部分が古い（npx tsx scripts/gen-panel-words.ts）");
  const ps = read("chrome-extension/page-script.js");
  assert(regenerate(ps, "_AXLX_PANEL_WORDS") === ps, "page-script.js の生成部分が古い（npx tsx scripts/gen-panel-words.ts）");
  // page-script の写しを実際に評価して、地図と同じか見る
  const m = ps.match(/\/\* PANEL_WORDS:BEGIN \*\/\n([\s\S]*?)\n\s*\/\* PANEL_WORDS:END \*\//);
  assert(!!m, "page-script に目印");
  const w = new Function(String(m![1]).replace(/^\s*var _AXLX_PANEL_WORDS/, "var _AXLX_PANEL_WORDS") + "; return _AXLX_PANEL_WORDS;")();
  assert(JSON.stringify(w) === JSON.stringify(panelPhaseWords()), "page-script の写しを評価すると地図と違う");
  console.log("  ✓ TS・拡張の裏／枠・画面の中(MAIN) が地図と同じ");
}

console.log("■ 手で書いた古い言葉がコードに残っていない（生成部分の外）");
{
  const strip = (s: string) => s.replace(/\/\* PANEL_WORDS:BEGIN \*\/[\s\S]*?\/\* PANEL_WORDS:END \*\//, "");
  const files = ["chrome-extension/bulk-panel-grasp.js", "chrome-extension/bulk-dl.js", "chrome-extension/page-script.js"];
  const words = panelPhases();
  for (const f of files) {
    const body = strip(read(f));
    for (const p of words) {
      assert(!body.includes(`"${p.now}"`), `${f} に「${p.now}」を手で書いている（地図の panel から引く）`);
      if (p.next.length >= 10) assert(!body.includes(`"${p.next}"`), `${f} に「${p.next}」を手で書いている（地図の panel から引く）`);
    }
  }
  // 検索の段の「つぎ」も地図の言葉。検索確認の前だけ _guardNextMove が「検索結果の表示を待つ」に直す（守りとして残す）
  const psBody = strip(read("chrome-extension/page-script.js"));
  assert(/ph === "search" \? _AXLX_PANEL_WORDS\.search\.next/.test(psBody), "page-script の検索の つぎ は地図の言葉");
  assert(/var safe = waitResults \? "検索結果の表示を待つ" : "検索を押す"/.test(psBody), "確認前の守り（_guardNextMove）は残っている");
  console.log("  ✓ 3つのファイルに手書きの言葉なし");
}

console.log("■ 並べ替えは押した時点でパネルも物件取得の言葉へ（並べ替え最中のまま残らない）");
{
  const sortP = withPanel(clone(), "sort");
  assert(sortP.switchTo === "list", "地図: sort.switchTo=list");
  const dl = read("chrome-extension/bulk-dl.js");
  const iPressed = dl.indexOf('_liveDlStep("sort_pressed"');
  const iAnn = dl.indexOf('_announcePhase("list", "sort_pressed")');
  const iLag = dl.indexOf('_auditSort("sort_lag_grace"');
  assert(iPressed > 0 && iAnn > iPressed && iLag > iAnn, "押した直後（猶予より前）に物件取得の言葉を出す");
  assert(/_adSortDone && \/並べ替え\/\.test\(_caG\)\) _caG = _panelWord\("list", "now"\)/.test(dl), "完了後の「いま」は地図の物件取得の言葉");
  assert(/nmG = _panelWord\("list", "next"\) \|\| nmG/.test(dl), "完了後の「つぎ」は地図の物件取得の言葉");
  // 表示: 物件取得の言葉で渡せば、並べ替え最中は出ない
  const L = PANEL_PHASE_WORDS.list;
  const out = js.formatBulkPanelGrasp({ total: 3, index: 1, currentName: "ひらた", nextName: "てん", currentAction: L.now, nextMove: L.next });
  assert(out.now.includes(PANEL_PHASE_WORDS.list.now) && !out.now.includes(PANEL_PHASE_WORDS.sort.now), "いま=" + out.now);
  assert(out.next.includes(L.next), "つぎ=" + out.next);
  console.log("  ✓ 押した直後に切り替わる・並べ替え最中が残らない");
}

console.log("■ 8つの段それぞれ、枠に地図の言葉がそのまま出る（TS と拡張が同じ）");
{
  for (const p of panelPhases()) {
    if (p.phase === "reset") continue; // reset は「外す」系の言い換えで つぎ が固定（別の試験で見ている）
    const g = { total: 3, index: 2, currentName: "ひらた", nextName: "てん", currentAction: p.now, nextMove: p.next };
    const a = formatBulkPanelGrasp(g);
    const b = js.formatBulkPanelGrasp(g);
    assert(!!a && !!b && a.now === b.now && a.next === b.next, `${p.phase}: TS と JS の表示が違う`);
    assert(a!.now.includes(p.now), `${p.phase}: いまに地図の言葉が出ない: ${a!.now}`);
    assert(a!.next.includes(p.next), `${p.phase}: つぎに地図の言葉が出ない: ${a!.next}`);
  }
  console.log("  ✓ 7段（reset除く）で一致");
}

console.log("panel-from-flow-map.test OK");
