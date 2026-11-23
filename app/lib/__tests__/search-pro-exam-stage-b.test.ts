// 統括Pro 段B の判定（2026-11-23 作業員G・#474・LLM なし）
// 実行: npx tsx app/lib/__tests__/search-pro-exam-stage-b.test.ts
import { judgeStageB, proTextFromEvidence } from "../search-pro-exam";

let failed = 0;
function ok(name: string, cond: boolean) { if (!cond) { failed++; console.log("  ✗", name); } else console.log("  ✓", name); }

const ev = [
  { label: "土台 F6_auto_after_bundle", value: "✗ 新束のあとの自動走行 0件" },
  { label: "統括Pro把握", value: "写真は flash未実行（学べ0）なので photo_learn が先" },
  { label: "足りない土台（統括Pro判断）", value: "1.F55 自動反映が未達" },
];
const text = proTextFromEvidence(ev);
ok("統括Pro の行だけをつなぐ", /flash未実行/.test(text) && !/新束のあと/.test(text));
const t = { id: "x", b_forbid: ["flash未実行"], b_expect: ["F55"] };
const r = judgeStageB(t, text);
ok("言ってはいけない言い方を拾う", !r.ok && r.forbidHits.length === 1 && r.expectMissing.length === 0);
ok("正しい文は ok", judgeStageB(t, "F55 自動反映を確かめる").ok === true);
ok("言うべき事が無ければ外れ", judgeStageB(t, "何か").expectMissing.join() === "F55");
ok("正解の欄が無ければ判定しない", judgeStageB({ id: "y" }, text).judged === false);
ok("残沿線0 で駅へ飛ばす（4070 の型）", !judgeStageB({ id: "z", b_forbid: ["残沿線[ 　]*0.{0,40}(飛ば|スキップ|skip)"] }, "残沿線0なら station_line をスキップして駅選択へ").ok);

if (failed) { console.log(`FAIL ${failed}`); process.exit(1); } else console.log("全 PASS");
