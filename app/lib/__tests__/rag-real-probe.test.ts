// app/lib/rag-real-probe.ts の単体テスト（DB は偽物）
// 実行: npx tsx --test app/lib/__tests__/rag-real-probe.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ragRealProbeOn, realProbeCalls, probeEmbeddingOf, realProbeFindings, runRealProbe, type RealProbeResult } from "../rag-real-probe";

const emb = Array.from({ length: 1536 }, (_, i) => (i % 7) / 100);

test("既定 on・off で止まる", () => {
  assert.equal(ragRealProbeOn({}), true);
  assert.equal(ragRealProbeOn({ RAG_REAL_PROBE: "off" }), false);
});

test("本番と同じ引数で3つの関数", () => {
  const c = realProbeCalls(emb);
  assert.deepEqual(c.map((x) => x.rpc), ["match_reply_examples", "match_aix_reply_examples", "match_reply_knowledge"]);
  assert.equal(c[0].args.match_count, 24);
  assert.deepEqual(c[0].args.filter_states, ["proposing", "hearing"]);
  assert.equal(c[1].args.match_count, 15);
  assert.equal(c[1].args.filter_action, "property_check_result");
});

test("問いにできるのは 1536 の数の配列だけ", () => {
  assert.ok(probeEmbeddingOf(emb));
  assert.equal(probeEmbeddingOf([1, 2]), null);
  assert.equal(probeEmbeddingOf("x"), null);
});

test("11/20 の形（手本が2.5〜2.9秒）を遅いと拾う・ナレッジ 0.9秒は拾わない", () => {
  const rs: RealProbeResult[] = [
    ...[2575, 2945, 3100].map((ms) => ({ rpc: "match_reply_examples", query: "q", ms, rows: 24, error: null })),
    ...[3200, 3500, 2900].map((ms) => ({ rpc: "match_aix_reply_examples", query: "q", ms, rows: 15, error: null })),
    ...[900, 1100, 800].map((ms) => ({ rpc: "match_reply_knowledge", query: "q", ms, rows: 40, error: null })),
  ];
  const f = realProbeFindings(rs);
  assert.deepEqual(f.map((x) => `${x.rpc}:${x.kind}`), ["match_aix_reply_examples:real_slow"]);
  assert.deepEqual(realProbeFindings(rs, 2500).map((x) => x.rpc).sort(), ["match_aix_reply_examples", "match_reply_examples"]);
});

test("失敗と0件を拾う", () => {
  const f = realProbeFindings([
    { rpc: "a", query: "q", ms: 8400, rows: null, error: "57014 canceling statement due to statement timeout" },
    { rpc: "b", query: "q", ms: 50, rows: 0, error: null },
  ]);
  assert.deepEqual(f.map((x) => `${x.rpc}:${x.kind}`), ["a:real_error", "b:real_empty"]);
});

test("最近の問い n 個で順に呼ぶ（壊れた行は飛ばす）", async () => {
  const calls: string[] = [];
  const sb = {
    from: () => ({ select: () => ({ order: () => ({ limit: async () => ({ data: [{ text_key: "壊れ", embedding: [1] }, { text_key: "proposing: a", embedding: emb }, { text_key: "b", embedding: emb }], error: null }) }) }) }),
    rpc: async (fn: string) => { calls.push(fn); return { data: [1, 2], error: null }; },
  };
  const rs = await runRealProbe(sb, 2);
  assert.equal(rs.length, 6);
  assert.equal(calls.length, 6);
  assert.ok(rs.every((r) => r.rows === 2 && r.error === null));
});
