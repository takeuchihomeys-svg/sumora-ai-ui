/**
 * パネルの「いま／つぎ」の言葉が、手順書と同じ言葉か（竹内さん 2026-11-27「アナウンスも手順書とあわせる・確認できる」）
 *   ・拡張の写し（bulk-panel-grasp.js）と TS が同じ言葉
 *   ・一覧の手に「全部送付済み→次へ／次頁も全部送付済み／0件／客完了→リセットして次客へ」がある
 *   ・パネルの各言葉の要の語が、手順書（手・一連の流れ）に在る
 * npx tsx app/lib/__tests__/bulk-panel-playbook-sync.test.ts
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { PANEL_PHASE_WORDS, formatBulkPanelGrasp } from "../bulk-panel-grasp";
import { PLAYBOOK_FLOW_SERIES, PLAYBOOK_LIST_AD_SORT_STEPS, PLAYBOOK_EXTRA_GUIDES, PLAYBOOK_SEARCH_GRASP_STEPS } from "../action-playbook";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
}

const req = createRequire(import.meta.url);
const js = req(join(process.cwd(), "chrome-extension/bulk-panel-grasp.js"));

console.log("■ JS の写しと TS が同じ言葉");
{
  assert(JSON.stringify(js.PANEL_PHASE_WORDS) === JSON.stringify(PANEL_PHASE_WORDS), "PANEL_PHASE_WORDS が JS と TS で違う");
  const g = { total: 3, index: 2, currentName: "てん", nextName: "やまだ", nextMove: "前客の選択を1つずつ外す", currentAction: "外している最中" };
  const a = formatBulkPanelGrasp(g);
  const b = js.formatBulkPanelGrasp(g);
  assert(!!a && !!b && a.now === b.now && a.next === b.next, "表示が JS と TS で違う: " + a?.now + " / " + b?.now);
  assert(!/外している最中|1つずつ外す/.test(String(a?.now) + String(a?.next)), "古い言葉が残っている");
  console.log("  ✓ 同じ");
}

console.log("■ 一覧の手に 送付済み→次へ／0件／客完了→リセット がある");
{
  const steps = PLAYBOOK_LIST_AD_SORT_STEPS.join("\n");
  assert(/⑤[^\n]*全部「送付済み」[^\n]*次へ[^\n]*次のページ/.test(steps), "⑤ 全部送付済み→次へで次のページ");
  assert(/⑥[^\n]*次のページも全部送付済み[^\n]*客完了/.test(steps), "⑥ 次頁も全部送付済み→客完了");
  assert(/⑦[^\n]*0件[^\n]*客完了/.test(steps), "⑦ 0件→客完了");
  assert(/⑧[^\n]*リセット[^\n]*次のお客さん[^\n]*リセットからの流れは同じ/.test(steps), "⑧ 客完了→リセットして次のお客さん");
  const handoff = PLAYBOOK_FLOW_SERIES.find((p) => p.id === "handoff");
  assert(/0件/.test(String(handoff?.label)) && /次頁も全部送付済み/.test(String(handoff?.label)) && /リセット/.test(String(handoff?.label)), "一連の流れ handoff");
  const next = PLAYBOOK_FLOW_SERIES.find((p) => p.id === "next");
  assert(/全部送付済みなら「次へ」/.test(String(next?.label)), "一連の流れ next");
  console.log("  ✓ ある");
}

console.log("■ パネルの言葉の要の語が手順書に在る");
{
  const corpus = [
    PLAYBOOK_LIST_AD_SORT_STEPS.join("\n"),
    PLAYBOOK_SEARCH_GRASP_STEPS.join("\n"),
    PLAYBOOK_FLOW_SERIES.map((p) => p.label).join("\n"),
    JSON.stringify(PLAYBOOK_EXTRA_GUIDES),
  ].join("\n");
  const must: Array<[string, string[]]> = [
    ["reset", ["リセット"]],
    ["fill", ["条件を入れ"]],
    ["search", ["検索"]],
    ["sort", ["並べ替え"]],
    ["list", ["全部送付済み", "客完了"]],
    ["all_sent", ["全部送付済み", "次へ", "次のページ"]],
    ["next_page", ["次のページ"]],
    ["done", ["客完了", "リセット"]],
  ];
  for (const [k, words] of must) {
    for (const w of words) assert(corpus.includes(w), `手順書に「${w}」が無い（パネルの ${k}）`);
  }
  // パネルの言葉自体にも、その要の語が入っている（言葉が手順書から離れていない）
  const w = PANEL_PHASE_WORDS;
  assert(/リセット/.test(w.reset.now) && /API/.test(w.reset.next), "reset の言葉");
  assert(/送付済み/.test(w.all_sent.now) && /次ページ/.test(w.all_sent.now), "all_sent の言葉");
  assert(/客完了/.test(w.done.now) && /リセット/.test(w.done.now), "done の言葉");
  console.log("  ✓ 在る");
}

console.log("bulk-panel-playbook-sync.test OK");
