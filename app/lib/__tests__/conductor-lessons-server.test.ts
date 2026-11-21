// npx tsx app/lib/__tests__/conductor-lessons-server.test.ts
// 2026-11-21 作業員L: 学びの行が0件の間は埋め込みも RPC も呼ばない（数えは60秒取り置き）・漏れの線の会話
import assert from "node:assert/strict";
import { currentLessonCount, resetLessonCountMemo, loadConductorLessons, lessonsExcludeConvs } from "../conductor-lessons-server";

let counts = 0, rpcs = 0;
const fake = (n: number) => ({
  from: () => ({ select: () => ({ eq: async () => { counts++; return { count: n, error: null }; } }) }),
  rpc: async () => { rpcs++; return { data: [], error: null }; },
}) as never;

(async () => {
  resetLessonCountMemo();
  const sb0 = fake(0);
  assert.equal(await currentLessonCount(sb0, 1_000), 0);
  assert.equal(await currentLessonCount(sb0, 30_000), 0); // 60秒の取り置き＝数え直さない
  assert.equal(counts, 1);
  assert.deepEqual(await loadConductorLessons(sb0, { conversationId: "c1", customerTurn: "他にもありますか" }), []);
  assert.equal(rpcs, 0); // 0件の間は RPC を呼ばない
  resetLessonCountMemo();
  assert.equal(await currentLessonCount(fake(5), 100_000), 5);
  // 漏れの線: 今の会話と試験の問題の元の会話
  assert.deepEqual(lessonsExcludeConvs("conv-now", { BRAIN_JUDGE_EXAMPLES_EXCLUDE_CONV: "conv-src" }), ["conv-now", "conv-src"]);
  assert.deepEqual(lessonsExcludeConvs("conv-now", {}), ["conv-now"]);
  console.log("conductor-lessons-server: ok");
})().catch((e) => { console.error(e); process.exit(1); });
