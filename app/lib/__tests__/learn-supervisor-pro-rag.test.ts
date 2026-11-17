/**
 * 統括Pro RAG引き
 * 実行: npx tsx app/lib/__tests__/learn-supervisor-pro-rag.test.ts
 */
import { buildProRagQuery } from "../learn-supervisor-pro-rag";
import { buildSupervisorProPayload } from "../learn-supervisor-pro";
import type { SupervisorAdvice } from "../learn-supervisor";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name, extra ?? ""); }
};

const adv = (): SupervisorAdvice => ({
  verdict: "almost",
  headline: "もう少し",
  actions: [],
  score: { coverage: 50, weak: 2, delta: null },
  block: null,
  lines: [],
  meeting: {
    today: ["今日"],
    agenda: [{ priority: 1, topic: "連携の穴", why: "F32止6", decide: "自動1回" }],
    questions: [],
    evidence: [
      { label: "学習土台点検（F番号）", value: "欠 F31 F32" },
      { label: "土台 F32_link_pipeline", value: "止:6" },
    ],
    learning_tasks: [],
  },
  self_check: { ok: true, issues: [], capped_by: null },
});

console.log("■ 問いの組み方");
{
  const q = buildProRagQuery(adv(), { meet: ["RAGできているか"], notes: ["solid=96"] });
  ok("物件検索・統括Proが入る", /物件検索/.test(q) && /統括Pro/.test(q), q);
  ok("議題が入る", /RAGできているか/.test(q), q);
  ok("土台・連携が入る", /F31|F32|止/.test(q), q);
}

console.log("\n■ payload に kb_hits");
{
  const p = buildSupervisorProPayload(adv(), null, {
    query: "test",
    kb_hits: [{
      id8: "abcd1234",
      title: "【決定】テスト",
      insight: "本文",
      priority: 1,
      score: 1.2,
      tags: ["Chrome拡張"],
    }],
    log_memory: [{ at: "2026-11-17", today: "昨日の結論", next: "次手" }],
    line: "統括Pro RAG 1件",
    ok: true,
    why: null,
  });
  ok("kb_hits がある", Array.isArray(p.kb_hits) && (p.kb_hits as unknown[]).length === 1);
  ok("log_memory がある", Array.isArray(p.log_memory) && (p.log_memory as unknown[]).length === 1);
  ok("kb_query がある", p.kb_query === "test");
}

console.log(`\n結果: ${pass} ok / ${fail} ng`);
if (fail) process.exit(1);
