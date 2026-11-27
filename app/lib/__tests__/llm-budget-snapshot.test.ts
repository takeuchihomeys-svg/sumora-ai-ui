// 2026-11-27 作業員L（統括役の決め）: 月の使用額の控え（quality_daily の budget:month_sums・毎時1行）
//   冷えた関数は控えの1行から始め、控えの後の行だけ読む（前は月の行を最大5万行読んでいた）。控えが無い・古い・区切りが違う時は今まで通り
// 実行: npx tsx app/lib/__tests__/llm-budget-snapshot.test.ts（偽物の DB・LLM も DB も使わない）
import assert from "node:assert/strict";

type Q = { table: string; filters: Array<[string, string, unknown]> };
function fakeDb(o: { snapshot: unknown | null; rows: Array<Record<string, unknown>> }) {
  const log: Q[] = []; const upserts: Array<Record<string, unknown>> = [];
  const sb = {
    from(table: string) {
      const q: Q = { table, filters: [] }; log.push(q);
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      for (const m of ["select", "order", "limit"]) chain[m] = self;
      chain.eq = (k: string, v: unknown) => { q.filters.push(["eq", k, v]); return chain; };
      chain.gte = (k: string, v: unknown) => { q.filters.push(["gte", k, v]); return chain; };
      chain.gt = (k: string, v: unknown) => { q.filters.push(["gt", k, v]); return chain; };
      chain.maybeSingle = async () => ({ data: o.snapshot ? { detail: o.snapshot } : null, error: null });
      chain.upsert = async (row: Record<string, unknown>) => { upserts.push(row); return { error: null }; };
      chain.then = (res: (v: unknown) => unknown) => {
        const gt = q.filters.find((f) => f[0] === "gt");
        const data = o.rows.filter((r) => !gt || Number(r.id) > Number(gt[2]));
        return Promise.resolve({ data, error: null }).then(res);
      };
      return chain;
    },
  };
  return { sb, log, upserts };
}

async function main() {
  const now = Date.parse("2026-11-27T05:00:00Z");
  const env = {} as Record<string, string>;
  const { readBudgetConfig, spendWindowStart, openaiWindowStart } = await import("../llm-budget-route");
  const cfg = readBudgetConfig(env, now);
  const key = `${spendWindowStart(cfg, now).since}|${openaiWindowStart(cfg, now)}`;
  const m = await import("../llm-budget-route-server");

  // 純関数: 控えの読み
  const snap = { since: "x", key, lastId: 500, claudeUsd: 10, openaiUsd: 3, deepseekUsd: 1, prod: { claudeUsd: 9, openaiUsd: 2, deepseekUsd: 0 }, at: now - 30 * 60_000 };
  assert.equal(m.budgetSnapshotSeedOf(snap, key, now)?.lastId, 500, "新しく区切りが同じ控えは使う");
  assert.equal(m.budgetSnapshotSeedOf({ ...snap, key: "other" }, key, now), null, "区切りが違えば使わない");
  assert.equal(m.budgetSnapshotSeedOf({ ...snap, at: now - 4 * 3_600_000 }, key, now), null, "3時間より古ければ使わない");
  assert.equal(m.budgetSnapshotSeedOf({ ...snap, lastId: 0 }, key, now), null);
  assert.equal(m.budgetSnapshotSeedOf(null, key, now), null);
  assert.equal(m.budgetSnapshotDue(Date.parse("2026-11-27T05:03:00Z")), true, "毎時0〜4分の回だけ書く");
  assert.equal(m.budgetSnapshotDue(Date.parse("2026-11-27T05:05:00Z")), false);

  // 冷えた関数: 控えから始めて、控えの後の行だけ足す
  const row = (id: number, model: string, input: number, route: string | null = null) => ({ id, model, route, created_at: "2026-11-27T04:00:00Z", input_uncached: input, cache_read: 0, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0, output_tokens: 0 });
  const rows = [row(400, "claude-sonnet-5-5", 1_000_000), row(501, "claude-sonnet-5-5", 1_000_000), row(502, "gpt-6.1-terra", 1_000_000)];
  const a = fakeDb({ snapshot: snap, rows });
  const s = await m.monthSums(a.sb as never, now, env);
  assert.ok(s, "読める");
  assert.equal(s!.lastId, 502);
  assert.equal(Math.round(s!.claudeUsd * 100) / 100, 12, "控え $10 ＋ 後の Sonnet 1M 入力 $2（控えの前の行 id 400 は足さない）");
  assert.equal(Math.round(s!.openaiUsd * 100) / 100, 4, "控え $3 ＋ Terra 1M 入力 $1");
  const logRead = a.log.find((q) => q.table === "llm_usage_logs");
  assert.deepEqual(logRead?.filters.find((f) => f[0] === "gt"), ["gt", "id", 500], "控えの後の行だけ読む");

  // 書く: 読み切れた時だけ・その日の1行
  const w = await m.writeBudgetSnapshot(a.sb as never, now + 1, env);
  assert.equal(w.written, true);
  assert.equal(a.upserts[0].metric, "budget:month_sums"); assert.equal(a.upserts[0].scope, "all"); assert.equal(a.upserts[0].day, "2026-11-27");

  console.log("llm-budget-snapshot ok 15");
}
main().catch((e) => { console.error(e); process.exit(1); });
