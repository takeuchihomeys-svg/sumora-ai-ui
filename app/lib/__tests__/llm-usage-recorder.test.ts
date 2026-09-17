// 2026-09-14 API 漏れ調査: 使用量を出口（fetch）で DB に残す。約30経路が未記録・返信生成の出力が常に0・ログ検索で集計できない、の解消
// 実行: npx tsx app/lib/__tests__/llm-usage-recorder.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { parseAnthropicRequest, parseUsageFromJson, parseUsageFromSse, wrapFetchWithLlmUsageRecorder, wrapFetchStripSumoraMarks, type LlmUsageRow } from "../llm-usage-recorder";

let passed = 0, failed = 0; const failures: string[] = [];
async function it(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

// 本番の返信生成と同じ形（system 4ブロック・1h キャッシュ・ストリーミング）
const genReplyBody = JSON.stringify({
  model: "claude-sonnet-5", max_tokens: 1500, stream: true, thinking: { type: "disabled" },
  system: [
    { type: "text", text: "あなたは不動産仲介「スモラ」のLINE返信を書くスタッフです。\n\n 以下のルールを守ってください。", cache_control: { type: "ephemeral", ttl: "1h" } },
    { type: "text", text: "会社ルール…", cache_control: { type: "ephemeral", ttl: "1h" } },
  ],
  messages: [{ role: "user", content: "お客様: 初期費用はどれくらいですか？（顧客の個人的な発言）" }],
});
const sse = [
  "event: message_start",
  `data: {"type":"message_start","message":{"id":"m","model":"claude-sonnet-5","usage":{"input_tokens":26015,"cache_read_input_tokens":121805,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"output_tokens":1}}}`,
  "event: content_block_delta",
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"かしこまりました"}}`,
  "event: message_delta",
  `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":642}}`,
  "event: message_stop",
  `data: {"type":"message_stop"}`,
].join("\n");

async function main() {
  await it("リクエスト: モデル・ストリーム・thinking・キャッシュの区切り数・system の先頭だけ（お客様の発言は持たない）", () => {
    const r = parseAnthropicRequest(genReplyBody);
    expect(r.model).toBe("claude-sonnet-5");
    expect(r.stream).toBe(true);
    expect(r.max_tokens).toBe(1500);
    expect(r.thinking_mode).toBe("disabled");
    expect(r.cache_breakpoints).toBe(2);
    expect(r.sys_head?.startsWith("あなたは不動産仲介「スモラ」のLINE返信を書くスタッフです。 以下の")).toBe(true);
    expect(JSON.stringify(r).includes("初期費用")).toBe(false);
    expect(parseAnthropicRequest(JSON.stringify({ model: "x", messages: [] })).thinking_mode).toBe("unset");
  });

  await it("同じ system の呼び出しは同じ sys_key（会話ごとに変わる後ろのブロックに左右されない）", () => {
    const a = parseAnthropicRequest(genReplyBody).sys_key;
    const b = parseAnthropicRequest(genReplyBody.replace("初期費用はどれくらいですか", "内覧できますか")).sys_key;
    expect(a).toBe(b);
  });

  await it("ストリーミング: message_start の入力・キャッシュと message_delta の出力（旧ログでは返信生成の出力が常に0）", () => {
    const u = parseUsageFromSse(sse);
    expect(u.input_uncached).toBe(26015);
    expect(u.cache_read).toBe(121805);
    expect(u.output_tokens).toBe(642);
    expect(u.stop_reason).toBe("end_turn");
    expect(u.model).toBe("claude-sonnet-5");
  });

  await it("通常の応答: 1時間の書き込み・思考トークン・max_tokens で切れた印", () => {
    const u = parseUsageFromJson(JSON.stringify({ model: "claude-sonnet-5", stop_reason: "max_tokens", usage: { input_tokens: 29845, cache_read_input_tokens: 0, cache_creation_input_tokens: 121805, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 121805 }, output_tokens: 1500, output_tokens_details: { thinking_tokens: 300 } } }));
    expect(u.cache_write_1h).toBe(121805);
    expect(u.thinking_tokens).toBe(300);
    expect(u.stop_reason).toBe("max_tokens");
  });

  await it("エラー応答（400 no low surrogate / 529 overloaded）は error_type で残す", () => {
    expect(parseUsageFromJson(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "no low surrogate" } })).error_type).toBe("invalid_request_error");
    expect(parseUsageFromSse(`event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}`).error_type).toBe("overloaded_error");
  });

  await it("fetch の包み: Anthropic の /v1/messages だけ1行ずつ記録し、応答はそのまま返す（再試行は別の行）", async () => {
    const rows: LlmUsageRow[] = [];
    const pending: Promise<unknown>[] = [];
    let call = 0;
    const fake = async (input: RequestInfo | URL) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!u.includes("anthropic")) return new Response("ok");
      call++;
      if (call === 1) return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error" } }), { status: 529, headers: { "content-type": "application/json", "request-id": "req_1" } });
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_2" } });
    };
    const f = wrapFetchWithLlmUsageRecorder(fake, { insert: async (r) => { rows.push(r); }, keepAlive: (p) => { pending.push(p); }, route: () => "/api/generate-reply", env: "test" });
    const r1 = await f("https://api.anthropic.com/v1/messages", { method: "POST", body: genReplyBody });
    const r2 = await f("https://api.anthropic.com/v1/messages", { method: "POST", body: genReplyBody });
    const r3 = await f("https://wfwsmwxakhyxobytszoq.supabase.co/rest/v1/x", { method: "POST", body: "{}" });
    const r4 = await f("https://api.anthropic.com/v1/messages/count_tokens", { method: "POST", body: genReplyBody });
    // 呼び出し側（SDK）は元の応答を最後まで読める
    expect(r1.status).toBe(529);
    expect((await r2.text()).includes("かしこまりました")).toBe(true);
    expect(await r3.text()).toBe("ok");
    expect(r4.status).toBe(200);
    await Promise.all(pending);
    expect(rows.length).toBe(2);
    expect(rows[0].status).toBe(529);
    expect(rows[0].error_type).toBe("overloaded_error");
    expect(rows[0].request_id).toBe("req_1");
    expect(rows[1].status).toBe(200);
    expect(rows[1].output_tokens).toBe(642);
    expect(rows[1].cache_read).toBe(121805);
    expect(rows[1].route).toBe("/api/generate-reply");
    expect(rows[1].env).toBe("test");
    expect(rows[1].error_type).toBe(null);
  });

  await it("通信の失敗・中断も1行（SDK の再試行の数が分かる）し、例外はそのまま呼び出し側へ", async () => {
    const rows: LlmUsageRow[] = [];
    const pending: Promise<unknown>[] = [];
    const fake = async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; };
    const f = wrapFetchWithLlmUsageRecorder(fake, { insert: async (r) => { rows.push(r); }, keepAlive: (p) => { pending.push(p); }, route: () => null });
    let threw = false;
    try { await f("https://api.anthropic.com/v1/messages", { method: "POST", body: genReplyBody }); } catch { threw = true; }
    await Promise.all(pending);
    expect(threw).toBe(true);
    expect(rows.length).toBe(1);
    expect(rows[0].error_type).toBe("aborted");
    expect(rows[0].status).toBe(0);
  });

  // 2026-09-17 竹内（AIX キャッシュ点検）: 共通 prefix を分けると sys_key が潰れるので、呼び出し側の印（headers）を action / conversation_id に残す
  await it("印のヘッダ: action / conversation_id を行に残し、Anthropic には送らない（Headers / Record / 配列のどの形でも・元の init は壊さない）", async () => {
    const shapes: { name: string; headers: HeadersInit }[] = [
      { name: "Headers", headers: new Headers({ "content-type": "application/json", "X-Sumora-LLM-Action": "conv_match", "x-sumora-llm-conversation": "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7" }) },
      { name: "Record", headers: { "content-type": "application/json", "x-sumora-llm-action": "conv_match", "x-sumora-llm-conversation": "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7" } },
      { name: "配列", headers: [["content-type", "application/json"], ["x-sumora-llm-action", "conv_match"], ["x-sumora-llm-conversation", "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7"]] },
    ];
    for (const s of shapes) {
      const rows: LlmUsageRow[] = [];
      const pending: Promise<unknown>[] = [];
      let sent: RequestInit | undefined;
      const fake = async (_input: RequestInfo | URL, init?: RequestInit) => { sent = init; return new Response(sse, { headers: { "content-type": "text/event-stream" } }); };
      const f = wrapFetchWithLlmUsageRecorder(fake, { insert: async (r) => { rows.push(r); }, keepAlive: (p) => { pending.push(p); }, route: () => "/api/aix/action" });
      const init: RequestInit = { method: "POST", body: genReplyBody, headers: s.headers };
      await f("https://api.anthropic.com/v1/messages", init);
      await Promise.all(pending);
      const sentHeaders = new Headers(sent?.headers);
      expect(`${s.name}:${sentHeaders.get("x-sumora-llm-action")}`).toBe(`${s.name}:null`);
      expect(`${s.name}:${sentHeaders.get("x-sumora-llm-conversation")}`).toBe(`${s.name}:null`);
      expect(`${s.name}:${sentHeaders.get("content-type")}`).toBe(`${s.name}:application/json`);
      expect(`${s.name}:${sent?.body === genReplyBody}`).toBe(`${s.name}:true`);
      expect(`${s.name}:${rows[0].action}`).toBe(`${s.name}:conv_match`);
      expect(`${s.name}:${rows[0].conversation_id}`).toBe(`${s.name}:dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7`);
      // 元の init は壊さない（呼び出し側が SDK の再試行で同じ init を使い回す）
      expect(`${s.name}:${new Headers(init.headers).get("x-sumora-llm-action")}`).toBe(`${s.name}:conv_match`);
      expect(`${s.name}:${sent === init}`).toBe(`${s.name}:false`);
    }
  });

  await it("印のヘッダが無い時は action / conversation_id は null で、init はそのまま渡す", async () => {
    const rows: LlmUsageRow[] = [];
    const pending: Promise<unknown>[] = [];
    let sent: RequestInit | undefined;
    const fake = async (_input: RequestInfo | URL, init?: RequestInit) => { sent = init; return new Response(sse, { headers: { "content-type": "text/event-stream" } }); };
    const f = wrapFetchWithLlmUsageRecorder(fake, { insert: async (r) => { rows.push(r); }, keepAlive: (p) => { pending.push(p); }, route: () => null });
    const init: RequestInit = { method: "POST", body: genReplyBody, headers: { "content-type": "application/json" } };
    await f("https://api.anthropic.com/v1/messages", init);
    await Promise.all(pending);
    expect(sent === init).toBe(true);
    expect(rows[0].action).toBe(null);
    expect(rows[0].conversation_id).toBe(null);
  });

  await it("印の値: encodeURIComponent 済み（非 ASCII）は戻す・素の値はそのまま", async () => {
    const rows: LlmUsageRow[] = [];
    const pending: Promise<unknown>[] = [];
    const fake = async () => new Response(sse, { headers: { "content-type": "text/event-stream" } });
    const f = wrapFetchWithLlmUsageRecorder(fake, { insert: async (r) => { rows.push(r); }, keepAlive: (p) => { pending.push(p); }, route: () => null });
    await f("https://api.anthropic.com/v1/messages", { method: "POST", body: genReplyBody, headers: { "x-sumora-llm-action": encodeURIComponent("会話を合わせる/apply"), "x-sumora-llm-conversation": "100%raw" } });
    await Promise.all(pending);
    expect(rows[0].action).toBe("会話を合わせる/apply");
    expect(rows[0].conversation_id).toBe("100%raw");
  });

  await it("記録が無効でも印のヘッダは Anthropic 宛から取り除く（wrapFetchStripSumoraMarks）。他のホストには触らない", async () => {
    let sent: RequestInit | undefined;
    const fake = async (_input: RequestInfo | URL, init?: RequestInit) => { sent = init; return new Response("{}"); };
    const f = wrapFetchStripSumoraMarks(fake);
    const init: RequestInit = { method: "POST", body: "{}", headers: { "x-api-key": "k", "x-sumora-llm-action": "property_send" } };
    await f("https://api.anthropic.com/v1/messages", init);
    expect(new Headers(sent?.headers).get("x-sumora-llm-action")).toBe(null);
    expect(new Headers(sent?.headers).get("x-api-key")).toBe("k");
    await f("https://example.com/x", init);
    expect(sent === init).toBe(true);
  });

  await it("sys_key_full: 全ブロックの全文で変わる（後ろのブロックが違えば別・区切り位置だけ違えば同じ）。sys_key は先頭400字のまま", () => {
    const a = parseAnthropicRequest(genReplyBody);
    const b = parseAnthropicRequest(genReplyBody.replace("会社ルール…", "会社ルール…（経路固有の文）"));
    expect(a.sys_key).toBe(b.sys_key);
    expect(a.sys_key_full === b.sys_key_full).toBe(false);
    // 区切り位置だけ変えたもの（"\n\n" で結合した全文が同じ）は同じ sys_key_full
    const joined = JSON.stringify({ model: "claude-sonnet-5", messages: [], system: "あなたは不動産仲介「スモラ」のLINE返信を書くスタッフです。\n\n 以下のルールを守ってください。\n\n会社ルール…" });
    expect(parseAnthropicRequest(joined).sys_key_full).toBe(a.sys_key_full);
    expect(parseAnthropicRequest(JSON.stringify({ model: "x", messages: [] })).sys_key_full).toBe(null);
  });

  await it("記録の失敗（DB 書き込みのエラー）で本来の応答を止めない", async () => {
    const pending: Promise<unknown>[] = [];
    const f = wrapFetchWithLlmUsageRecorder(async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }), { insert: async () => { throw new Error("db down"); }, keepAlive: (p) => { pending.push(p); }, route: () => { throw new Error("no store"); } });
    const r = await f("https://api.anthropic.com/v1/messages", { method: "POST", body: genReplyBody });
    expect((await r.text()).includes("message_stop")).toBe(true);
    await Promise.allSettled(pending);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
}
main();
