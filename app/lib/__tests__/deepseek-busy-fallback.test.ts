// DeepSeek が混んでいる・落ちている時に Claude で作り直す予備のテスト（2026-10-15 の障害の形をそのまま再現）
// 実行: npx tsx app/lib/__tests__/deepseek-busy-fallback.test.ts（全 PASS で exit 0）
// ⚠ --env-file を付けない（本番の鍵・DB を読まない。DeepSeek も Claude も呼ばない＝fetch は全部差し替え）
//
// 10/15 10:33 JST〜 の本番の形: DeepSeek が HTTP 200 を返したまま1文字も流さない → 90秒で stream_error（出力0）→ 下書きが空。
//   200 の時点で Response を返していたので Claude に戻す所を通らなかった。
import * as alt from "../llm-alt-provider";
import { createSseConverter } from "../llm-alt-provider";

let passed = 0, failed = 0;
async function it(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function ok(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const enc = new TextEncoder();
/** keep-alive だけを流し続けて終わらない本文（10/15 の DeepSeek の形） */
const hangingBody = () => new ReadableStream<Uint8Array>({
  start(c) { c.enqueue(enc.encode(": keep-alive\n\n")); },
  pull() { return new Promise(() => { /* 永遠に来ない */ }); },
});
/** 正常な DeepSeek の 1文字ずつの形 */
const goodBody = (text: string) => new ReadableStream<Uint8Array>({
  start(c) {
    c.enqueue(enc.encode(": keep-alive\n\n"));
    for (const ch of [text.slice(0, 2), text.slice(2)]) c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`));
    c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 3, prompt_cache_miss_tokens: 10 } })}\n\n`));
    c.enqueue(enc.encode("data: [DONE]\n\n"));
    c.close();
  },
});
/** 何も中身が来ずにすぐ閉じる本文 */
const emptyBody = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(": keep-alive\n\n")); c.close(); } });

type Mode = "hang" | "good" | "empty" | "503" | "400";
let mode: Mode = "good";
const calls = { deepseek: 0, anthropic: 0 };
const anthropicSignals: Array<AbortSignal | null | undefined> = [];
const stub = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  if (url.includes("api.deepseek.com")) {
    calls.deepseek++;
    const stream = JSON.parse(String(init?.body ?? "{}")).stream === true;
    if (mode === "503") return new Response("Service Unavailable: server too busy", { status: 503 });
    if (mode === "400") return new Response("bad request", { status: 400 });
    if (!stream) {
      if (mode === "hang") {
        // 読み切りの形で止まる: signal（全体の上限）で切れる
        return await new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)));
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "DS" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } }), { status: 200 });
    }
    const body = mode === "hang" ? hangingBody() : mode === "empty" ? emptyBody() : goodBody("DSの返信");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  if (!url.includes("api.anthropic.com")) return new Response("{}", { status: 200 });
  calls.anthropic++;
  anthropicSignals.push(init?.signal);
  if (init?.signal?.aborted) throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  return new Response(JSON.stringify({ content: [{ type: "text", text: "Claudeの返信" }], usage: { input_tokens: 10, output_tokens: 1 } }), { status: 200 });
}) as typeof fetch;
const reset = (m: Mode) => { mode = m; calls.deepseek = 0; calls.anthropic = 0; anthropicSignals.length = 0; };

const send = (o: { stream?: boolean; action?: string; signal?: AbortSignal } = {}) => globalThis.fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: { "content-type": "application/json", ...(o.action ? { "x-sumora-llm-action": o.action } : {}) },
  body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 50, stream: !!o.stream, system: "ハードゲート: テスト", messages: [{ role: "user", content: "お客様: 別のお部屋も見てみたいです" }] }),
  ...(o.signal ? { signal: o.signal } : {}),
});
const textOf = async (r: Response) => r.text();

async function main() {
  // 止まった Promise で黙って exit 0 しないよう、終わるまでイベントループを保つ（最後に process.exit）
  setInterval(() => { /* keep alive */ }, 1000);
  setTimeout(() => { console.log("✗ 全体の時間切れ（どこかで止まった）"); process.exit(1); }, 90_000);
  console.log("── 設定（readBusyGuard）");
  await it("既定は on・最初の1文字 15秒・全体 60秒・2回続けて失敗で 5分遮断", () => {
    const g = alt.readBusyGuard({});
    ok(g.enabled && g.firstTokenMs === 15_000 && g.totalMs === 60_000 && g.breakerFailures === 2 && g.breakerCooldownMs === 300_000, JSON.stringify(g));
  });
  await it("DEEPSEEK_FALLBACK_CLAUDE=off で今までどおり（全体 90秒・遮断なし）", () => {
    const g = alt.readBusyGuard({ DEEPSEEK_FALLBACK_CLAUDE: "off" });
    ok(!g.enabled && g.totalMs === 90_000 && g.breakerFailures === 0, JSON.stringify(g));
  });
  await it("数字は範囲に丸める・読めない値は既定", () => {
    const g = alt.readBusyGuard({ DEEPSEEK_FIRST_TOKEN_MS: "500", DEEPSEEK_TIMEOUT_MS: "abc", DEEPSEEK_BREAKER_COOLDOWN_MS: "999999999" });
    ok(g.firstTokenMs === 3_000 && g.totalMs === 60_000 && g.breakerCooldownMs === 3_600_000, JSON.stringify(g));
  });

  console.log("\n── 混雑の失敗の見分け（isBusyFailure）");
  await it("時間切れ・5xx・429・最初の1文字が来ない は混雑", () => {
    ok(alt.isBusyFailure(Object.assign(new Error("x"), { name: "TimeoutError" })), "timeout");
    ok(alt.isBusyFailure(new alt.AltBusyError("first_token_timeout", "x")), "first token");
    ok(alt.isBusyFailure(new Error("deepseek 503: too busy")), "503");
    ok(alt.isBusyFailure(new Error("deepseek 429: rate")), "429");
  });
  await it("400（送り方が悪い）は混雑に数えない", () => ok(!alt.isBusyFailure(new Error("deepseek 400: bad")), "400"));

  console.log("\n── 回路の遮断（createAltBreaker・時計を差し替え）");
  await it("2回続けて失敗で遮断・5分で明ける・明けた後の試しが駄目ならすぐ遮断・通れば戻る", () => {
    let now = 0;
    const b = alt.createAltBreaker({ breakerFailures: 2, breakerCooldownMs: 300_000 }, () => now);
    b.onFailure(true); ok(!b.isOpen(), "1回では遮断しない");
    b.onFailure(true); ok(b.isOpen(), "2回で遮断");
    now = 299_999; ok(b.isOpen(), "5分の間は遮断");
    now = 300_000; ok(!b.isOpen(), "5分で明ける");
    b.onFailure(true); ok(b.isOpen(), "明けた後の試しが駄目ならまた遮断");
    now = 700_000; b.onSuccess(); ok(!b.isOpen() && b.state().consecutive === 0, "通れば戻る");
  });
  await it("混雑でない失敗は数えない・成功で数え直し", () => {
    const b = alt.createAltBreaker({ breakerFailures: 2, breakerCooldownMs: 1000 }, () => 0);
    b.onFailure(false); b.onFailure(false); ok(!b.isOpen(), "400 等");
    b.onFailure(true); b.onSuccess(); b.onFailure(true); ok(!b.isOpen(), "間に成功");
  });

  console.log("\n── 最初の1文字まで読む（readUntilFirstContent）");
  await it("keep-alive の後に中身 → 読めた分を返す", async () => {
    const r = await alt.readUntilFirstContent(goodBody("こんにちは").getReader(), createSseConverter("m"), 3000);
    ok(r.events.some((e) => e.includes("content_block_delta")), JSON.stringify(r.events).slice(0, 200));
  });
  await it("★ keep-alive だけで止まる → 上限で first_token_timeout", async () => {
    const t0 = Date.now();
    try { await alt.readUntilFirstContent(hangingBody().getReader(), createSseConverter("m"), 300); ok(false, "投げない"); }
    catch (e) { ok(e instanceof alt.AltBusyError && e.kind === "first_token_timeout", String(e)); }
    ok(Date.now() - t0 < 2000, "待ちすぎ");
  });
  await it("中身なしで終わる → empty_stream", async () => {
    try { await alt.readUntilFirstContent(emptyBody().getReader(), createSseConverter("m"), 3000); ok(false, "投げない"); }
    catch (e) { ok(e instanceof alt.AltBusyError && e.kind === "empty_stream", String(e)); }
  });

  console.log("\n── 出口の包み（llm-alt-provider を実際に入れて通す・最初の1文字の上限 3秒）");
  globalThis.fetch = stub;
  alt.installAltProvider({
    LLM_ALT_PROVIDER: "deepseek", LLM_ALT_ACTIONS: "reply_generate,property_check_result,property_rank", DEEPSEEK_API_KEY: "dummy",
    LLM_ALT_FALLBACK: "on", DEEPSEEK_FIRST_TOKEN_MS: "3000", DEEPSEEK_TIMEOUT_MS: "10000",
  });

  await it("正常な DeepSeek（1文字ずつ）はそのまま DeepSeek の文", async () => {
    alt.resetAltBreakers(); reset("good");
    const t = await textOf(await send({ stream: true }));
    ok(calls.deepseek === 1 && calls.anthropic === 0 && t.includes("DS") && t.includes("message_stop"), `${JSON.stringify(calls)} ${t.slice(0, 120)}`);
  });
  await it("★ 10/15 の形: 200 のまま1文字も来ない → 3秒で Claude に作り直す（下書きが空にならない）", async () => {
    alt.resetAltBreakers(); reset("hang");
    const t0 = Date.now();
    const t = await textOf(await send({ stream: true }));
    const ms = Date.now() - t0;
    ok(calls.deepseek === 1 && calls.anthropic === 1 && t.includes("Claudeの返信"), `${JSON.stringify(calls)} ${t.slice(0, 120)}`);
    ok(ms >= 2900 && ms < 6000, `待ち ${ms}ms`);
  });
  await it("★ 続けて2回目も止まる → 回路を遮断・3回目は DeepSeek を試さず即 Claude", async () => {
    reset("hang");
    await textOf(await send({ stream: true }));
    ok(calls.deepseek === 1 && calls.anthropic === 1, `2回目 ${JSON.stringify(calls)}`);
    reset("hang");
    const t0 = Date.now();
    const t = await textOf(await send({ stream: true }));
    ok(calls.deepseek === 0 && calls.anthropic === 1 && t.includes("Claudeの返信") && Date.now() - t0 < 1000, `3回目 ${JSON.stringify(calls)} ${Date.now() - t0}ms`);
  });
  await it("中身なしで閉じる（空）→ Claude", async () => {
    alt.resetAltBreakers(); reset("empty");
    const t = await textOf(await send({ stream: true }));
    ok(calls.deepseek === 1 && calls.anthropic === 1 && t.includes("Claudeの返信"), JSON.stringify(calls));
  });
  await it("503 too busy → すぐ Claude", async () => {
    alt.resetAltBreakers(); reset("503");
    const t = await textOf(await send({ stream: true }));
    ok(calls.deepseek === 1 && calls.anthropic === 1 && t.includes("Claudeの返信"), JSON.stringify(calls));
  });
  await it("400 は今までどおり Claude に戻すが、遮断には数えない", async () => {
    alt.resetAltBreakers(); reset("400");
    await textOf(await send({ stream: true })); await textOf(await send({ stream: true }));
    reset("good");
    await textOf(await send({ stream: true }));
    ok(calls.deepseek === 1 && calls.anthropic === 0, `遮断していない ${JSON.stringify(calls)}`);
  });
  await it("★ 読み切りの形（AIX）: 止まる → 全体の上限で Claude。呼び出し側の signal が切れていても新しい signal で通す", async () => {
    alt.resetAltBreakers(); reset("hang");
    const callerSignal = AbortSignal.timeout(1000); // AIX の 25秒の代わり（DeepSeek の上限 10秒より短い）
    const r = await send({ action: "property_check_result", signal: callerSignal });
    const j = await r.json() as { content?: Array<{ text?: string }> };
    ok(calls.deepseek === 1 && calls.anthropic === 1 && j.content?.[0]?.text === "Claudeの返信", JSON.stringify(calls));
    ok(anthropicSignals[0] !== callerSignal && !anthropicSignals[0]?.aborted, "Claude には切れていない signal");
  });
  await it("物件の判断・読み取り（NO_CLAUDE_FALLBACK_ACTIONS）は今までどおり Claude に倒さない（遮断もしない）", async () => {
    alt.resetAltBreakers(); reset("503");
    let threw = false;
    try { await send({ action: "property_rank" }); } catch { threw = true; }
    try { await send({ action: "property_rank" }); } catch { /* 2回目 */ }
    reset("good");
    await send({ action: "property_rank" });
    ok(threw && calls.anthropic === 0 && calls.deepseek === 1, `${threw} ${JSON.stringify(calls)}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
