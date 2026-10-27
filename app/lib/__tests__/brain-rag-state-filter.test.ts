// 節約②: ナレッジ検索の段階の違う行を落とす（2026-10-27）のテスト
// 実行: npx tsx app/lib/__tests__/brain-rag-state-filter.test.ts
import { filterKnowledgeByState, brainRagStateFilterOn } from "../brain-rag-state-filter";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, d?: unknown) => { if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${JSON.stringify(d)}`); } };
const rows = [
  { id: 1, conversation_state: "proposing" }, { id: 2, conversation_state: "applying" }, { id: 3, conversation_state: "感謝返し" },
  { id: 4, conversation_state: null }, { id: 5, conversation_state: "viewing" }, { id: 6, conversation_state: "aix_property_send" }, { id: 7, conversation_state: "proposing" },
];
const got = filterKnowledgeByState(rows, "proposing", 4).map((r) => r.id);
t("状態の名前が違う行を落とし、TPO・AIX の種類・空の行は残す・順は保つ・k 件", JSON.stringify(got) === JSON.stringify([1, 3, 4, 6]), got);
t("今の状態が分からない時は落とさない", filterKnowledgeByState(rows, null, 10).length === 7);
t("既定 off", !brainRagStateFilterOn({}) && brainRagStateFilterOn({ BRAIN_RAG_STATE_FILTER: "on" }));
console.log(`\n${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);
