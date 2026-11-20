// ensureConversation: 問い合わせの失敗を「会話が無い」と取り違えて作りに行かない（作業員M 2026-11-21）
// 実行: npx tsx app/lib/__tests__/line-webhook-ensure-conversation.test.ts（DB には触らない・偽の db）
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test";
type EnsureFn = typeof import("../line-webhook-text").ensureConversation;
let ensureConversation: EnsureFn;
let passed = 0, failed = 0;
const t = (name: string, ok: boolean, extra?: unknown) => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`, extra ?? ""); } };

type R = { data: unknown; error: unknown };
function fakeDb(selectResult: R, insertResult: R, retryResult?: R) {
  const calls = { select: 0, insert: 0 };
  const chain = (r: () => R) => {
    const o: Record<string, unknown> = {};
    for (const k of ["eq", "limit", "select", "maybeSingle"]) o[k] = () => o;
    (o as { then: unknown }).then = (res: (v: R) => unknown) => Promise.resolve(r()).then(res);
    return o;
  };
  const db = {
    from: () => ({
      select: () => { calls.select++; return chain(() => (calls.select === 1 ? selectResult : retryResult ?? selectResult)); },
      insert: () => { calls.insert++; return chain(() => insertResult); },
    }),
  };
  return { db: db as never, calls };
}
const acc = { key: "sumora", token: "", secret: "x" } as never;
(async () => {
  ({ ensureConversation } = await import("../line-webhook-text"));
  {
    const f = fakeDb({ data: null, error: { message: "canceling statement due to statement timeout" } }, { data: { id: "new" }, error: null });
    const r = await ensureConversation(f.db, "Uabc", acc, "2026-11-21T00:00:00Z");
    t("問い合わせが失敗したら null で、作りに行かない", r === null && f.calls.insert === 0, { r, calls: f.calls });
  }
  {
    const f = fakeDb({ data: [{ id: "c1", account: "sumora" }], error: null }, { data: null, error: null });
    t("ある会話はそのまま", (await ensureConversation(f.db, "Uabc", acc, "x")) === "c1" && f.calls.insert === 0);
  }
  {
    const f = fakeDb({ data: [], error: null }, { data: { id: "new1" }, error: null });
    t("本当に無い時だけ作る", (await ensureConversation(f.db, "Uabc", acc, "x")) === "new1" && f.calls.insert === 1);
  }
  {
    const f = fakeDb({ data: [], error: null }, { data: null, error: { message: "fail" } }, { data: [], error: null });
    t("作るのも失敗したら null（受け口が本文を貯める）", (await ensureConversation(f.db, "Uabc", acc, "x")) === null);
  }
  console.log(`\nline-webhook-ensure-conversation: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
