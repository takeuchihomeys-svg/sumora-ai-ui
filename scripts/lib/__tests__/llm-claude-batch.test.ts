// 試験の Claude の呼び出しを Message Batches に回す包み（scripts/lib/llm-claude-batch.ts）・試験の混雑の時間（exam-brain examPeakAt）
// 実行: npx tsx scripts/lib/__tests__/llm-claude-batch.test.ts（自己完結・LLM も DB も使わない。全 PASS で exit 0）
import { makeClaudeBatchFetch, batchActive, messageToSse, isNightJst, type BatchStats } from "../llm-claude-batch";
import { examPeakAt } from "../exam-brain";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

(async () => {
  // いつ入るか
  const night = new Date("2026-10-21T18:00:00Z"); // JST 3:00
  const day = new Date("2026-10-21T03:00:00Z"); // JST 12:00
  ok("夜の窓", isNightJst(night) && !isNightJst(day));
  ok("auto: Claude の試験の夜だけ", batchActive({ LLM_TEST_FINAL_CLAUDE: "1" }, night) && !batchActive({ LLM_TEST_FINAL_CLAUDE: "1" }, day) && !batchActive({}, night));
  ok("auto: 予約の回は昼でも", batchActive({ LLM_TEST_FINAL_CLAUDE: "1", EXAM_FROM_QUEUE: "1" }, day));
  ok("on／off", batchActive({ EXAM_CLAUDE_BATCH: "on" }, day) && !batchActive({ EXAM_CLAUDE_BATCH: "off", LLM_TEST_FINAL_CLAUDE: "1" }, night));

  // バッチの往復（偽の API）
  const msg = (t: string) => ({ id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: t }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 7, cache_read_input_tokens: 50 } });
  const seen: string[] = [];
  let created: Array<{ custom_id: string; params: Record<string, unknown> }> = [];
  let polls = 0, direct = 0;
  const api = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u = String(input); seen.push(`${init?.method ?? "GET"} ${u.replace("https://api.anthropic.com", "")}`);
    if (u.endsWith("/v1/messages/batches") && init?.method === "POST") { created = (JSON.parse(String(init.body)) as { requests: typeof created }).requests; return new Response(JSON.stringify({ id: "b1", processing_status: "in_progress" }), { status: 200 }); }
    if (u.endsWith("/v1/messages/batches/b1")) { polls++; return new Response(JSON.stringify({ id: "b1", processing_status: polls >= 2 ? "ended" : "in_progress", results_url: "https://api.anthropic.com/v1/messages/batches/b1/results" }), { status: 200 }); }
    if (u.endsWith("/results")) return new Response(created.map((r) => JSON.stringify({ custom_id: r.custom_id, result: r.params.messages && JSON.stringify(r.params).includes("NG") ? { type: "errored", error: {} } : { type: "succeeded", message: msg(`答え:${(r.params.messages as Array<{ content: string }>)[0].content}`) } })).join("\n"), { status: 200 });
    if (u.endsWith("/v1/messages")) { direct++; return new Response(JSON.stringify(msg("直の答え")), { status: 200, headers: { "content-type": "application/json" } }); }
    return new Response("?", { status: 404 });
  };
  const stats: BatchStats = { batches: 0, requests: 0, ok: 0, fallback: 0, waitedMs: 0 };
  const f = makeClaudeBatchFetch(api, { env: { EXAM_CLAUDE_BATCH_WINDOW_MS: "5", EXAM_CLAUDE_BATCH_POLL_MS: "200" }, stats, log: () => {}, sleep: async () => {} });
  const req = (content: string, stream = false) => ({ method: "POST", headers: { "x-api-key": "k", "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 100, stream, messages: [{ role: "user", content }] }) });
  const [a, b, c] = await Promise.all([f("https://api.anthropic.com/v1/messages", req("一")), f("https://api.anthropic.com/v1/messages", req("二", true)), f("https://api.anthropic.com/v1/messages", req("NG"))]);
  const ja = await a.json() as { content: Array<{ text: string }> };
  ok("同じ時の要求は1つのバッチ", stats.batches === 1 && created.length === 3 && !("stream" in created[0].params), JSON.stringify(seen));
  ok("答え（普通の要求）はバッチの message", ja.content[0].text === "答え:一" && a.headers.get("x-claude-batch") === "b1");
  const sse = await b.text();
  ok("stream の要求は SSE に組み直す", b.headers.get("content-type") === "text/event-stream" && sse.includes("message_start") && sse.includes('"text":"答え:二"') && sse.includes("message_stop"));
  ok("バッチで失敗した要求は直に呼ぶ", direct === 1 && ((await c.json()) as { content: Array<{ text: string }> }).content[0].text === "直の答え" && stats.fallback === 1 && stats.ok === 2);
  // バッチに出さない物
  const before = direct;
  await f("https://api.anthropic.com/v1/messages", { ...req("x"), body: JSON.stringify({ model: "m", fallbacks: "default", messages: [{ role: "user", content: "x" }] }) });
  await f("https://api.anthropic.com/v1/messages/count_tokens", req("x"));
  ok("fallbacks 付き・数えるだけの要求はそのまま", direct === before + 1 && stats.batches === 1);
  // 待ちの上限で直に呼ぶ
  let t = 0;
  const slow = async (input: RequestInfo | URL, init?: RequestInit) => { const u = String(input); if (u.endsWith("/batches") && init?.method === "POST") return new Response(JSON.stringify({ id: "b2" }), { status: 200 }); if (u.endsWith("/b2")) return new Response(JSON.stringify({ processing_status: "in_progress" }), { status: 200 }); if (u.endsWith("/cancel")) return new Response("{}", { status: 200 }); return new Response(JSON.stringify(msg("直")), { status: 200 }); };
  const f2 = makeClaudeBatchFetch(slow, { env: { EXAM_CLAUDE_BATCH_WINDOW_MS: "1", EXAM_CLAUDE_BATCH_TIMEOUT_MIN: "1" }, log: () => {}, sleep: async (ms) => { t += ms; }, now: () => t });
  const r2 = await f2("https://api.anthropic.com/v1/messages", req("遅い"));
  ok("待ちの上限を超えたら直に呼ぶ", ((await r2.json()) as { content: Array<{ text: string }> }).content[0].text === "直");
  // SSE の組み直し（考え・道具）
  const s2 = messageToSse({ content: [{ type: "thinking", thinking: "考え", signature: "sig" }, { type: "tool_use", id: "t1", name: "f", input: { a: 1 } }], stop_reason: "tool_use", usage: { output_tokens: 3 } });
  ok("SSE: 考え・道具の差分", s2.includes("thinking_delta") && s2.includes("signature_delta") && s2.includes('"partial_json":"{\\"a\\":1}"') && s2.includes('"stop_reason":"tool_use"'));

  // 試験の混雑の時間（変えられる）
  const wedUtc2 = new Date("2026-10-21T02:00:00Z");
  ok("既定は llm-price の表（平日 UTC 1-4 は混雑）", examPeakAt(wedUtc2, {}));
  ok("EXAM_DEEPSEEK_PEAK_UTC で変える", !examPeakAt(wedUtc2, { EXAM_DEEPSEEK_PEAK_UTC: "6-10" }) && examPeakAt(new Date("2026-10-21T07:00:00Z"), { EXAM_DEEPSEEK_PEAK_UTC: "6-10" }));
  ok("off＝混雑なし", !examPeakAt(wedUtc2, { EXAM_DEEPSEEK_PEAK_UTC: "off" }));
  ok("曜日も変えられる（土曜を混雑に）", examPeakAt(new Date("2026-10-24T02:00:00Z"), { EXAM_DEEPSEEK_PEAK_UTC: "1-4", EXAM_DEEPSEEK_PEAK_DAYS: "6-6" }));

  console.log(`llm-claude-batch: ${pass} PASS / ${fail} FAIL`);
  if (fail) process.exitCode = 1;
})();
