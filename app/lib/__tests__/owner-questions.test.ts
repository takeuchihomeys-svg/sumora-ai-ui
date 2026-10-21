// 2026-10-22 質問の台帳（owner_questions）とブレインの分からない事（brain_unknowns）の純関数のテスト
// 実行: npx tsx app/lib/__tests__/owner-questions.test.ts（全 PASS で exit 0）
import { aggregateUnknowns, mergeUnknownRow, unknownsFromExamReasons, unknownsFromLinkSummary, unknownsFromTurn, brainUnknownsEnabled } from "../brain-unknowns";
import { groupOpenQuestions, renderOpenQuestions, kbRowForAnswer, type OwnerQuestion } from "../owner-questions";

let fail = 0;
const ok = (c: boolean, m: string) => { if (c) console.log(`PASS ${m}`); else { fail++; console.log(`FAIL ${m}`); } };

// 1. 自信が低の番の理由・スタッフしか知らない事・会社の決まりの指摘を拾う（文は残さない）
const hits = unknownsFromTurn({
  id: 1, conversation_id: "conv-1", customer_turn_at: "2026-10-21T01:00:00Z",
  final_check: { final_codes: ["FABRICATED_POLICY:warning", "FABRICATED_POLICY:block", "RULE_VIOLATION:warning"], confidence: { v: "x", score: 30, band: "low", reasons: [{ code: "company_fact", ja: "会社の事実に反する言い切り", delta: -30 }, { code: "scene_prior_high", ja: "", delta: 5 }] } },
  draft_last: "初期費用は合計で250,000円となります！！",
});
ok(hits.some((h) => h.kind === "low_confidence_reason" && h.key === "company_fact"), "低の理由を拾う");
ok(!hits.some((h) => h.key === "scene_prior_high"), "足す点の理由は拾わない");
ok(hits.filter((h) => h.kind === "company_rule_missing").length === 1, "同じコードは1番1回");
ok(hits.every((h) => !JSON.stringify(h.ref).includes("250,000")), "例の印に下書きの文を入れない");

// 2. 自信が中・高なら理由を拾わない
ok(!unknownsFromTurn({ id: 2, conversation_id: "c", customer_turn_at: null, final_check: { confidence: { v: "x", score: 80, band: "high", reasons: [{ code: "fc_warn", ja: "", delta: -5 }] } }, draft_last: null }).length, "高の番は拾わない");

// 3. つなぎの切れは数だけ足す（例は会話 id と時刻だけ）
const link = unknownsFromLinkSummary({ links: { promise_picker: { byType: { no_picker: 3 }, examples: [{ conv: "abcd1234", at: "2026-10-21T02:00:00Z", breakType: "no_picker" }] } } }, { no_picker: "ピッカーなし" }, { promise_picker: "約束→ピッカー" });
const la = aggregateUnknowns(link);
ok(la.length === 1 && la[0].n === 3 && la[0].label === "約束→ピッカー：ピッカーなし" && la[0].refs.length === 1, "つなぎの切れを型ごとに数える");

// 4. 足し合わせ: 数は足す・例は重ねない・5つまで
const merged = mergeUnknownRow({ count: 4, sample_ref: [{ conversation_id: "abcd1234", at: "2026-10-21T02:00:00Z" }], first_at: "2026-10-01T00:00:00Z", last_at: "2026-10-20T00:00:00Z" }, la[0], "2026-10-22T00:00:00Z");
ok(merged.count === 7 && merged.sample_ref.length === 1 && merged.first_at === "2026-10-01T00:00:00Z" && merged.last_at === "2026-10-21T02:00:00Z", "既存の行と足す");

// 5. 試験の外れの理由
const ex = aggregateUnknowns(unknownsFromExamReasons({ label: "L1", reasons: [{ id: "q1", kind: "道の取り違え" }, { id: "q2", kind: "道の取り違え" }, { id: "q3", kind: "依頼の抜け" }] }));
ok(ex[0].key === "道の取り違え" && ex[0].n === 2 && ex[0].refs[0].exam_label === "L1", "試験の外れの型を数える");

// 6. 切替
ok(brainUnknownsEnabled({}) && !brainUnknownsEnabled({ BRAIN_UNKNOWNS: "off" }), "既定 on・off で止まる");

// 7. 台帳の並べ方と表示
const base = { options: [], why: null, source_kind: null, source_ref: null, answer: null, answered_at: null, kb_id: null } as const;
const rows: OwnerQuestion[] = [
  { ...base, id: "aaaaaaaa-1", kind: "question", topic: "費用", question: "Q費用", recommended: "R", status: "open", priority: 2, created_at: "2026-10-22T00:00:01Z" },
  { ...base, id: "bbbbbbbb-1", kind: "question", topic: "用意してもらう物", question: "Q用意", recommended: null, status: "open", priority: 1, created_at: "2026-10-22T00:00:02Z" },
  { ...base, id: "cccccccc-1", kind: "question", topic: "費用", question: "Q済み", recommended: null, status: "answered", priority: 1, created_at: "2026-10-22T00:00:00Z" },
  { ...base, id: "dddddddd-1", kind: "gold", topic: "正解", question: "Qgold", recommended: null, status: "open", priority: 2, created_at: "2026-10-22T00:00:00Z" },
];
const g = groupOpenQuestions(rows);
ok(g.length === 2 && g[0].topic === "用意してもらう物" && g[1].items.length === 1, "未回答の普通の質問だけを話題順に");
const text = renderOpenQuestions(rows);
ok(text.includes("1. Q用意") && text.includes("2. Q費用") && !text.includes("Q済み") && !text.includes("Qgold") && text.includes("gold）1件"), "表示は番号つき・gold は数だけ");
const kb = kbRowForAnswer(rows[0], "そうする", "2026-10-22T10:00:00Z");
ok(kb.category === "architecture" && kb.priority === 1 && (kb.tags as string[]).includes("竹内さんの決定"), "答えの設計知見は P1・札 竹内さんの決定");

if (fail) { console.log(`\n${fail} 件 FAIL`); process.exit(1); }
console.log("\nALL PASS");
