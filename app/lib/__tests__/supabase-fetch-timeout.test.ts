// Supabase の REST への fetch の上限（app/lib/supabase-fetch-timeout.ts）
// 実行: npx tsx app/lib/__tests__/supabase-fetch-timeout.test.ts（自己完結ハーネス。全 PASS で exit 0）
// 2026-10-05 13:14〜13:28 JST の Supabase の停止（522）で、関数が 300秒・画面が「読み込み中」のまま待たされた事の再現と直り
import { createClient } from "@supabase/supabase-js";
import { isSupabaseRestUrl, resolveRestTimeoutMs, withRestTimeout, SUPABASE_REST_TIMEOUT_MS } from "../supabase-fetch-timeout";

let passed = 0, failed = 0; const failures: string[] = [];
async function it(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(actual: T, exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); }

/** 応答しない Supabase（signal で止められた時だけ AbortError で落ちる）＝ 10/05 の 522 の間の形 */
const hangingFetch = (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_res, rej) => {
  const s = init?.signal;
  if (s) s.addEventListener("abort", () => rej(s.reason ?? new DOMException("aborted", "AbortError")));
});
const okFetch = async () => new Response(JSON.stringify([{ id: 1 }]), { status: 200, headers: { "Content-Type": "application/json" } });

async function main() {
  // AbortSignal.timeout の時計は Node では unref される＝待っている間に他の仕事が無いとプロセスが黙って終わる。テストの間だけ生かしておく
  const keepAlive = setInterval(() => {}, 1000);
  console.log("resolveRestTimeoutMs");
  await it("未設定は既定 25秒", () => eq(resolveRestTimeoutMs(undefined), SUPABASE_REST_TIMEOUT_MS));
  await it("空文字も既定", () => eq(resolveRestTimeoutMs(" "), SUPABASE_REST_TIMEOUT_MS));
  await it("0 は付けない（戻す）", () => eq(resolveRestTimeoutMs("0"), null));
  await it("数でない値は付けない", () => eq(resolveRestTimeoutMs("abc"), null));
  await it("数はその値", () => eq(resolveRestTimeoutMs("40000"), 40000));

  console.log("isSupabaseRestUrl");
  await it("REST は対象", () => eq(isSupabaseRestUrl("https://x.supabase.co/rest/v1/templates?select=id"), true));
  await it("RPC も対象", () => eq(isSupabaseRestUrl(new URL("https://x.supabase.co/rest/v1/rpc/conversation_last_customer_at")), true));
  await it("Storage（アップロード）は対象外", () => eq(isSupabaseRestUrl("https://x.supabase.co/storage/v1/object/property-images/a.jpeg"), false));
  await it("Auth は対象外", () => eq(isSupabaseRestUrl("https://x.supabase.co/auth/v1/token"), false));

  console.log("withRestTimeout");
  await it("応答しない REST は上限で AbortError になる", async () => {
    const f = withRestTimeout(hangingFetch, 40);
    const t0 = Date.now();
    let name = "";
    try { await f("https://x.supabase.co/rest/v1/templates"); } catch (e) { name = (e as Error).name; }
    if (!(name === "TimeoutError" || name === "AbortError")) throw new Error(`name=${name}`);
    if (Date.now() - t0 > 2000) throw new Error("上限で止まっていない");
  });
  await it("Storage は打ち切らない（素の fetch のまま）", async () => {
    let gotSignal: AbortSignal | null | undefined = undefined;
    const f = withRestTimeout(async (_i, init) => { gotSignal = init?.signal; return okFetch(); }, 40);
    await f("https://x.supabase.co/storage/v1/object/a.jpeg", {});
    eq(gotSignal == null, true);
  });
  await it("上限なし（null）は素の fetch をそのまま返す", () => eq(withRestTimeout(okFetch, null) === okFetch, true));
  await it("呼び出し側の signal でも止まる", async () => {
    const f = withRestTimeout(hangingFetch, 60_000);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    let threw = false;
    try { await f("https://x.supabase.co/rest/v1/messages", { signal: ac.signal }); } catch { threw = true; }
    eq(threw, true);
  });

  console.log("supabase-js に組み込んだ時");
  await it("止まった Supabase でも throw せず { error } が返る（呼び出し側の既存のエラー処理に流れる）", async () => {
    const sb = createClient("https://x.supabase.co", "anon-key", { global: { fetch: withRestTimeout(hangingFetch, 40) } });
    const t0 = Date.now();
    const { data, error } = await sb.from("templates").select("id");
    eq(data, null);
    if (!error) throw new Error("error が無い");
    if (!/Abort|Timeout/i.test(error.message)) throw new Error(`message=${error.message}`);
    if (Date.now() - t0 > 2000) throw new Error("上限で止まっていない");
  });
  await it("普段の応答はそのまま読める", async () => {
    const sb = createClient("https://x.supabase.co", "anon-key", { global: { fetch: withRestTimeout(okFetch, 40) } });
    const { data, error } = await sb.from("templates").select("id");
    eq(error, null);
    eq(data, [{ id: 1 }]);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log(failures.join("\n")); process.exit(1); }
}
void main();
