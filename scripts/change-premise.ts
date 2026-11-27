/**
 * 直す前に「前提と流れ」を出す道具（2.8.319 の後の土台強化）。
 *   竹内さん 2026-11-27「なんで改善する際に前提や流れを理解せずに変更したのか／根本的な部分を理解して改善できる仕組みを」
 *
 * 使い方（拡張の流れ・手順書・パネルの言葉を直す前に必ず）:
 *   npx tsx --env-file=.env.local scripts/change-premise.ts --area=list     # 一覧（並べ替え→物件取得→次頁→客完了）
 *   npx tsx --env-file=.env.local scripts/change-premise.ts --area=reset    # リセット→次客
 *   npx tsx --env-file=.env.local scripts/change-premise.ts --area=all      # お客さん1人ぶんの全部
 *   npx tsx --env-file=.env.local scripts/change-premise.ts --check         # 地図の形・手順書の③④・パネルの言葉（終了コード 0/1）
 *
 * 出す物: ① 流れの地図（順に行う手／分かれ道／合流）と、コードの目印の場所（ファイル:行）
 *         ② その場面の決まり（AUTO_RULES）③ 理解の書面の雛形（4点）④ 設計知見を引く言い方
 * ここに出た「形」を読まずに、手順書の文や番号を足さない。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOOP_FLOW_NODES, LOOP_INTERRUPTS, checkFlowMap, checkInterrupts, checkListPlaybookStrength, checkPanelWords, panelPhases, branchesOf, flowNode, type FlowNode } from "../app/lib/loop-flow-map";
import { AUTO_RULES } from "../app/lib/auto-procedure-rules";
import { PLAYBOOK_LIST_AD_SORT_STEPS } from "../app/lib/action-playbook";

const args = process.argv.slice(2);
const arg = (k: string) => (args.find((a) => a.startsWith(`--${k}=`)) || "").slice(k.length + 3);

if (args.includes("--check")) {
  const p = checkFlowMap();
  const s = checkListPlaybookStrength(PLAYBOOK_LIST_AD_SORT_STEPS);
  const pw = checkPanelWords();
  if (p.length || s.length || pw.length) {
    if (pw.length) console.log("❌ パネルの言葉が地図と合っていない:\n  - " + pw.join("\n  - "));
    if (p.length) console.log("❌ 流れの地図に問題:\n  - " + p.join("\n  - "));
    if (s.length) console.log("❌ 手順書の手が地図より弱い:\n  - " + s.join("\n  - "));
    process.exit(1);
  }
  console.log("✅ 流れの地図の形は正しい。手順書の③④は地図の完了の文をそのまま載せている。パネルの言葉は地図と合っている");
  process.exit(0);
}

const AREAS: Record<string, { ids: string[]; scenes: string[]; kb: string }> = {
  list: { ids: ["sort", "list_press", "b_all_sent_next", "b_all_sent_last", "b_zero", "customer_done"], scenes: ["list", "next"], kb: "一覧 全部送付済み 次ページ 0件 客完了" },
  reset: { ids: ["customer_done", "reset_front", "reset", "b_reset_late", "b_reset_retry", "b_reset_fallback", "api_reload", "b_api_skip", "fill"], scenes: ["clear", "switch"], kb: "リセット 次客 API読み直し 押せない 背面 タブ" },
  all: { ids: LOOP_FLOW_NODES.map((n) => n.id), scenes: ["clear", "switch", "cond", "search", "list", "next"], kb: "お客さん1人ぶんの流れ" },
};
const area = arg("area") || "all";
const def = AREAS[area];
if (!def) { console.log("--area は list / reset / all"); process.exit(2); }

const root = process.cwd();
const cache: Record<string, string[]> = {};
function whereIs(n: FlowNode): string {
  const f = n.evidence.file;
  cache[f] ??= readFileSync(join(root, "chrome-extension", f), "utf8").split(/\r?\n/);
  const i = cache[f].findIndex((l) => l.includes(n.evidence.token));
  return i >= 0 ? `chrome-extension/${f}:${i + 1}（${n.evidence.token}）` : `⚠ ${f} に ${n.evidence.token} が無い`;
}
const KIND_JA: Record<string, string> = { step: "順に行う手", branch: "分かれ道（順に行う手ではない）", join: "合流点" };

console.log(`■ ① 流れの地図（${area}）\n`);
for (const id of def.ids) {
  const n = flowNode(id)!;
  const kids = branchesOf(n.id);
  console.log(`・${n.id}［${KIND_JA[n.kind]}］${n.label}`);
  if (n.when) console.log(`    いつ: ${n.when}`);
  if (n.parent) console.log(`    親の手: ${n.parent}`);
  console.log(`    次: ${n.next.join(" / ") || "（なし）"}${kids.length ? `   分かれ道: ${kids.map((k) => k.id).join(", ")}` : ""}`);
  console.log(`    コード: ${whereIs(n)}`);
  console.log(`    点検の印: ${n.audit.join(", ") || "（なし）"}`);
  if (n.note) console.log(`    補足: ${n.note}`);
}
const prob = checkFlowMap();
console.log(prob.length ? `\n❌ 地図に問題:\n  - ${prob.join("\n  - ")}` : "\n✅ 地図の形は正しい（分かれ道は全部 客完了→リセットへ合流）");

// 割り込み（どの段でも起きうる回復）。流れの途中の分岐ではなく、ここに別に並ぶ
console.log(`\n■ ①b 割り込み（どの段からも起きうる・止まった段へ戻って続ける）\n`);
for (const i of LOOP_INTERRUPTS) {
  console.log(`・${i.id} ${i.label}`);
  console.log(`    どの段で: ${i.applies}　／　起きた後: ${i.resume}`);
  console.log(`    コード: chrome-extension/${i.evidence.file}（${i.evidence.token}）　実測: ${i.seen}`);
}
const probI = checkInterrupts();
if (probI.length) console.log(`❌ 割り込みに問題:\n  - ${probI.join("\n  - ")}`);

if (area === "list" || area === "all") {
  console.log("\n■ ①c 手順書の一覧の手（地図の文が③④に載っているか）\n");
  for (const step of PLAYBOOK_LIST_AD_SORT_STEPS) console.log("・" + step);
  const weak = checkListPlaybookStrength(PLAYBOOK_LIST_AD_SORT_STEPS);
  console.log(weak.length ? "\n❌ 手順書の手が地図より弱い:\n  - " + weak.join("\n  - ") : "\n✅ ③④は地図の完了の文をそのまま載せている（決まり1行だけでは終わっていない）");
}

// パネル（拡張の枠の「いま／つぎ」）。正本は地図の panel。直す時は 地図 → npx tsx scripts/gen-panel-words.ts → 試験
console.log("\n■ ①d パネルの言葉（拡張の枠の「いま／つぎ」・正本は地図の panel）\n");
for (const p of panelPhases()) {
  console.log(`・${p.phase}［${p.nodeId}］いま「${p.now}」／つぎ「${p.next}」　次の段: ${p.then.join(", ")}${p.switchTo ? `　押した時点で ${p.switchTo} の言葉へ` : ""}`);
}
for (const n of LOOP_FLOW_NODES.filter((x) => x.noPanel && def.ids.includes(x.id))) console.log(`・（${n.id} は専用の言葉なし）${n.noPanel}`);
const probP = checkPanelWords();
console.log(probP.length ? "\n❌ パネルの言葉に問題:\n  - " + probP.join("\n  - ") : "\n✅ パネルの言葉は地図と合っている。直したら: 地図の panel → npx tsx scripts/gen-panel-words.ts → 試験 panel-from-flow-map");

console.log(`\n■ ② この場面の決まり（AUTO_RULES・scene = ${def.scenes.join("/")}）\n`);
for (const r of AUTO_RULES.filter((x) => def.scenes.includes(x.scene))) {
  console.log(`・${r.id}（${r.since}）${String(r.text).replace(/\s+/g, " ").slice(0, 90)}…`);
}

console.log(`
■ ③ 理解の書面（直す前に書く・曖昧なら竹内さんに1つだけ聞く）
  1. 形: 今回の変更は 順に行う手／分かれ道（どの手の？）／繰り返し／合流 のどれか。（上の地図のどこ？）
  2. 前提: その手の前と後は何か。入口（どこから来る）と出口（どこへ行く）。例外（最初の客・最後の客・失敗）は？
  3. 入れ物: 手順書・パネル・点検の入れ物（文字の一列／next が1つ）は、その形を表せるか。表せないなら入れ物を先に直す。
     パネルの言葉も地図の panel から作る（①d）。手を足したら panel か noPanel（理由）を地図に書く。
  4. 言い直し: 竹内さんの言葉を、自分の言葉で言い直して合っているか。ずれる所があれば1つ聞く。
  ※ 流れを変える時は、コードや手順書の文より先に app/lib/loop-flow-map.ts を直す（手順書の④から先は地図から作られる）。

■ ④ 設計知見を引く
  npx tsx --env-file=.env.local scripts/kb.ts --q="${def.kb}" --max-p=1
  npx tsx --env-file=.env.local scripts/kb.ts --q="直す前に前提と流れを理解する 流れの地図"
`);
