// 重点（scripts/lib/exam-focus.ts）と守りの重点の選び（exam-guards の focusIds）の単体テスト（LLM も DB も git も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-focus.test.ts（全 PASS で exit 0）
import { diffSignals, focusOf, focusPool, pickByFocus, focusLine, parseFocusTypes, type FocusSpec } from "../exam-focus";
import { chooseGuards } from "../exam-guards";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

const spec: FocusSpec[] = [
  { id: "q001", type: "返信かAIXか", why: "申込したい→まず返信（APPLY_INTENT_REPLY_FIRST）" },
  { id: "q002", type: "返信かAIXか" },
  { id: "q003", type: "手続きの質問", why: "審査の流れ" },
  { id: "q004", type: "AIXの種類", source: "buildEstimateLine の外れ" },
  { id: "q005", type: "初回" },
];
const diff = [
  "+++ b/app/lib/brain-core.ts",
  "+  if ((process.env.APPLY_INTENT_REPLY_FIRST ?? \"on\") !== \"off\") {",
  "+export function buildEstimateLine(x: string) {",
  "+  const k = process.env.NODE_ENV;",
  "-  old()",
].join("\n");
const sg = diffSignals(diff);
ok("足した行からスイッチ（NODE_ENV は外す）", sg.switches.join(",") === "APPLY_INTENT_REPLY_FIRST", sg.switches.join(","));
ok("足した行から関数", sg.funcs.includes("buildEstimateLine"), sg.funcs.join(","));
const sceneMap = { _note: "x", PROCEDURE_UNKNOWN_POINTS_ONLY: { types: ["手続きの質問"], only: ["q003"] } };
const f = focusOf({ diffText: diff, sceneMap, spec, stage: "brain", switchName: "PROCEDURE_UNKNOWN_POINTS_ONLY" });
ok("重点: 地図の型＋名の出る問題の型", f.types.join(",") === "AIXの種類,手続きの質問,返信かAIXか", f.types.join(","));
ok("重点: 名指し（地図の only・名の出る問題）", f.ids.join(",") === "q001,q003,q004", f.ids.join(","));
ok("候補: 型が重点の問題も入る・狙いは除く", focusPool(f, spec, ["q001"]).sort().join(",") === "q002,q003,q004", focusPool(f, spec, ["q001"]).join(","));
const picks = pickByFocus(f, spec, { n: 2, nightlyIds: new Set(["q002", "q004"]), stableIds: new Set(["q003"]) });
ok("狙いの無い依頼: 名指し＋夜の基準あり＞名指し＋安定", picks.join(",") === "q004,q003", picks.join(","));
ok("1行", focusLine(f, 3).startsWith("重点: 場面 AIXの種類・手続きの質問・返信かAIXか・名指し q001,q003,q004・段 brain"), focusLine(f, 3));
const none = focusOf({ diffText: "+const a = 1;", sceneMap: {}, spec, stage: null });
ok("決められない時は空（RAG のまま）", !none.types.length && !none.ids.length && pickByFocus(none, spec, { n: 8, nightlyIds: new Set(), stableIds: new Set() }).length === 0);
ok("DeepSeek の答え: spec にある型だけ・3つまで", parseFocusTypes('```json\n{"types":["初回","無い型","手続きの質問"]}\n```', new Set(spec.map((p) => p.type))).join(",") === "初回,手続きの質問");
ok("DeepSeek の答えが壊れていれば空", parseFocusTypes("わからない", new Set(["初回"])).length === 0);

// 守り: 重点があれば重点の場面の中から（狙いに一番近い q009 でなく、重点の q002）
const cards = [
  { id: "q001", stage: "brain" as const, embedding: [1, 0] },
  { id: "q009", stage: "brain" as const, embedding: [0.99, 0.01] },
  { id: "q002", stage: "brain" as const, embedding: [0.2, 0.8] },
  { id: "q003", stage: "brain" as const, embedding: null },
];
const g0 = chooseGuards({ targets: ["q001"], cards, nightlyIds: new Set(), stableIds: new Set(), max: 1 });
ok("今まで: 狙いに近い q009", g0[0]?.id === "q009", JSON.stringify(g0));
const g1 = chooseGuards({ targets: ["q001"], cards, nightlyIds: new Set(), stableIds: new Set(["q003"]), max: 2, focusIds: new Set(["q002", "q003"]) });
ok("重点あり: 重点の中から（埋め込みが無くても・安定が先）", g1.map((x) => x.id).join(",") === "q003,q002" && g1[0].why.startsWith("重点の場面"), JSON.stringify(g1));
ok("重点が空なら今まで通り", chooseGuards({ targets: ["q001"], cards, nightlyIds: new Set(), stableIds: new Set(), max: 1, focusIds: new Set() })[0]?.id === "q009");

console.log(`${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
