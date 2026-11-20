// app/lib/knowledge-usage.ts の単体テスト（RPC は偽物・DB なし）
// 実行: npx tsx --test app/lib/__tests__/knowledge-usage.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { knowledgeUsageTableOn, recordKnowledgeUsage, foldKnowledgeUsage } from "../knowledge-usage";

function fakeRpc(fail: Record<string, string> = {}) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => {
    calls.push({ fn, args });
    return { data: fn === "fold_knowledge_usage" ? 7 : null, error: fail[fn] ? { message: fail[fn] } : null };
  };
  return { rpc, calls };
}

test("既定 on（11/20）・off で止まる", () => {
  assert.equal(knowledgeUsageTableOn({}), true);
  assert.equal(knowledgeUsageTableOn({ KNOWLEDGE_USAGE_TABLE: "off" }), false);
});

test("off: 今まで通り increment_knowledge_used_count（重複は1つ・空は除く）", async () => {
  const f = fakeRpc();
  assert.equal(await recordKnowledgeUsage(f.rpc, ["a", "b", "a", "", null], { KNOWLEDGE_USAGE_TABLE: "off" }), "legacy");
  assert.deepEqual(f.calls, [{ fn: "increment_knowledge_used_count", args: { p_ids: ["a", "b"] } }]);
});

test("on: 小さな表に足す（ai_reply_knowledge は触らない）", async () => {
  const f = fakeRpc();
  assert.equal(await recordKnowledgeUsage(f.rpc, ["a", "b"], { KNOWLEDGE_USAGE_TABLE: "on" }), "table");
  assert.deepEqual(f.calls.map((c) => c.fn), ["increment_knowledge_usage"]);
});

test("on でも関数が無い（migrate の前）・失敗した時は今まで通りに戻す（数えを落とさない）", async () => {
  const f = fakeRpc({ increment_knowledge_usage: "Could not find the function public.increment_knowledge_usage" });
  assert.equal(await recordKnowledgeUsage(f.rpc, ["a"], { KNOWLEDGE_USAGE_TABLE: "on" }), "legacy");
  assert.deepEqual(f.calls.map((c) => c.fn), ["increment_knowledge_usage", "increment_knowledge_used_count"]);
});

test("空の id は呼ばない・両方失敗は failed", async () => {
  const f = fakeRpc();
  assert.equal(await recordKnowledgeUsage(f.rpc, [], { KNOWLEDGE_USAGE_TABLE: "on" }), "none");
  assert.equal(f.calls.length, 0);
  const g = fakeRpc({ increment_knowledge_usage: "x", increment_knowledge_used_count: "y" });
  assert.equal(await recordKnowledgeUsage(g.rpc, ["a"], { KNOWLEDGE_USAGE_TABLE: "on" }), "failed");
});

test("書き戻し: 戻した行の数・関数が無い時はエラーにしない", async () => {
  assert.deepEqual(await foldKnowledgeUsage(fakeRpc().rpc), { folded: 7, error: null });
  assert.deepEqual(await foldKnowledgeUsage(fakeRpc({ fold_knowledge_usage: "Could not find the function public.fold_knowledge_usage" }).rpc), { folded: 0, error: null });
  assert.deepEqual(await foldKnowledgeUsage(fakeRpc({ fold_knowledge_usage: "timeout" }).rpc), { folded: 0, error: "timeout" });
});

test("migrate-schema に表と2つの関数・書き戻しは消す前", () => {
  const src = readFileSync("app/api/migrate-schema/route.ts", "utf8");
  assert.ok(/CREATE TABLE IF NOT EXISTS knowledge_usage \(/.test(src));
  assert.ok(/CREATE OR REPLACE FUNCTION increment_knowledge_usage\(p_ids UUID\[\]\)/.test(src));
  assert.ok(/CREATE OR REPLACE FUNCTION fold_knowledge_usage\(\)/.test(src));
  // 書き戻しは used_count=0 の行を消す前（update-knowledge の cron の最初）
  const cron = readFileSync("app/api/cron/update-knowledge/route.ts", "utf8");
  const fold = cron.indexOf("foldKnowledgeUsage("), del = cron.indexOf('.eq("used_count", 0)');
  assert.ok(fold > 0 && fold < del, `fold ${fold} < delete ${del}`);
});
