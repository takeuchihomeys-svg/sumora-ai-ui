// app/lib/build-lease.ts の単体テスト（DB は偽物・LLM なし）
// 実行: npx tsx --test app/lib/__tests__/build-lease.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { tryAcquireLease, releaseLease, buildDecision, buildLeaseOn, isMissingTable, type LeaseDb } from "../build-lease";

/** 主キー（key）で1行だけ入る偽の表 */
function fakeDb(opts: { missing?: boolean; failInsert?: boolean } = {}) {
  const rows = new Map<string, { holder: string; until: string }>();
  let inserts = 0;
  const db: LeaseDb = {
    insert: async (r) => {
      inserts++;
      if (opts.missing) return { error: { code: "42P01", message: 'relation "build_leases" does not exist' } };
      if (opts.failInsert) return { error: { code: "57014", message: "canceling statement due to statement timeout" } };
      if (rows.has(r.key)) return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
      rows.set(r.key, { holder: r.holder, until: r.until });
      return { error: null };
    },
    deleteExpired: async (key, nowIso) => { const x = rows.get(key); if (x && x.until < nowIso) rows.delete(key); return { error: null }; },
    release: async (key, holder) => { const x = rows.get(key); if (x && x.holder === holder) rows.delete(key); return { error: null }; },
  };
  return { db, rows, inserts: () => inserts };
}
const T0 = Date.parse("2026-11-20T01:30:00Z");

test("既定 on・off で止まる", () => {
  assert.equal(buildLeaseOn({}), true);
  assert.equal(buildLeaseOn({ BUILD_LEASE: "off" }), false);
});

test("11/20 の形: 別々の箱から同時に5本来ても、作るのは1本だけ・残りは古い束を返す", async () => {
  const f = fakeDb();
  const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => tryAcquireLease(f.db, "learn:all", `box${i}`, 120_000, T0)));
  assert.equal(rs.filter((x) => x === "acquired").length, 1);
  assert.equal(rs.filter((x) => x === "held").length, 4);
  assert.deepEqual(rs.map((x) => buildDecision(x, true)).filter((d) => d === "build").length, 1);
  assert.ok(rs.filter((x) => x === "held").every((x) => buildDecision(x, true) === "serve_old"));
});

test("作り終えて外したら、次は取れる・他の箱の印は外さない", async () => {
  const f = fakeDb();
  assert.equal(await tryAcquireLease(f.db, "k", "a", 120_000, T0), "acquired");
  await releaseLease(f.db, "k", "b"); // 他人は外せない
  assert.equal(await tryAcquireLease(f.db, "k", "c", 120_000, T0 + 1000), "held");
  await releaseLease(f.db, "k", "a");
  assert.equal(await tryAcquireLease(f.db, "k", "c", 120_000, T0 + 2000), "acquired");
});

test("作っている箱が落ちても（外さないまま）、期限が切れたら取れる", async () => {
  const f = fakeDb();
  assert.equal(await tryAcquireLease(f.db, "k", "dead", 120_000, T0), "acquired");
  assert.equal(await tryAcquireLease(f.db, "k", "x", 120_000, T0 + 60_000), "held");
  assert.equal(await tryAcquireLease(f.db, "k", "x", 120_000, T0 + 121_000), "acquired");
});

test("表が無い（migrate の前）時だけ今まで通り作る", async () => {
  const f = fakeDb({ missing: true });
  const r = await tryAcquireLease(f.db, "k", "a", 120_000, T0);
  assert.equal(r, "no_table");
  assert.equal(buildDecision(r, true), "build");
  assert.ok(isMissingTable({ code: "PGRST205", message: "Could not find the table 'public.build_leases' in the schema cache" }));
});

test("印が書けない（DB が重い・時間切れ）時は作らない＝古い束を返す・束が無ければ待つ", async () => {
  const f = fakeDb({ failInsert: true });
  const r = await tryAcquireLease(f.db, "k", "a", 120_000, T0);
  assert.equal(r, "unavailable");
  assert.equal(buildDecision(r, true), "serve_old");
  assert.equal(buildDecision(r, false), "empty_wait");
});

test("束が無く他が作っている時は待つ（重ねない）", () => {
  assert.equal(buildDecision("held", false), "empty_wait");
  assert.equal(buildDecision("acquired", false), "build");
});

test("DB の呼び出しが投げても unavailable（作らない）", async () => {
  const db: LeaseDb = { insert: async () => { throw new Error("fetch failed"); }, deleteExpired: async () => ({ error: null }), release: async () => ({ error: null }) };
  assert.equal(await tryAcquireLease(db, "k", "a", 1000, T0), "unavailable");
});
