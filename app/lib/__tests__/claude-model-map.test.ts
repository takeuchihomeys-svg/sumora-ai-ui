// 2026-09-29 竹内「Sonnet を Sonnet 5.5 に置き換えたら…費用も抑えて質が上がるなら置き換える」: 出口（fetch）の1か所で Sonnet 5 → 5.5 に写す
// 実行: npx tsx app/lib/__tests__/claude-model-map.test.ts（自己完結ハーネス・env 不要。全 PASS で exit 0）
import {
  mapClaudeModelRequest, parseActionList, isActionSelected, cacheGroupOf, effectiveActionName, sendWithClaudeModelMap,
  REPLY_GENERATE_SYSTEM_MARKER, SONNET_55_MODEL, type ClaudeModelEnv,
} from "../claude-model-map";
import { wrapFetchWithLlmUsageRecorder, type LlmUsageRow, LLM_ACTION_HEADER } from "../llm-usage-recorder";
import { ROUTE_MARKERS } from "../llm-alt-provider";

let passed = 0, failed = 0; const failures: string[] = [];
async function it(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toEqual(exp: unknown) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
  };
}

const ON = (actions: string): ClaudeModelEnv => ({ CLAUDE_SONNET_MODEL: SONNET_55_MODEL, CLAUDE_SONNET55_ACTIONS: actions });
// 本番の customer-summary と同じ形（LangChain ChatAnthropic・system 2ブロック 1h・thinking disabled）
const summaryBody = JSON.stringify({
  model: "claude-sonnet-5", max_tokens: 600, thinking: { type: "disabled" },
  system: [
    { type: "text", text: "あなたは賃貸仲介の営業アシスタントです。", cache_control: { type: "ephemeral", ttl: "1h" } },
    { type: "text", text: "改善ルール", cache_control: { type: "ephemeral", ttl: "1h" } },
  ],
  messages: [{ role: "user", content: "名前: テスト" }],
});
// 返信生成（名札なし・system 先頭が「【指示の優先順位】…ハードゲート」）
const replyBody = JSON.stringify({
  model: "claude-sonnet-5", max_tokens: 1500, stream: true, thinking: { type: "disabled" },
  system: [{ type: "text", text: "【指示の優先順位】ハードゲート＞…", cache_control: { type: "ephemeral", ttl: "1h" } }],
  messages: [{ role: "user", content: "." }],
});
const haikuBody = JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 100, thinking: { type: "disabled" }, messages: [{ role: "user", content: "." }] });

async function main() {
  await it("既定（環境変数なし）は本文を1文字も変えない＝今まで通り Sonnet 5", () => {
    for (const env of [{}, { CLAUDE_SONNET_MODEL: SONNET_55_MODEL }, { CLAUDE_SONNET55_ACTIONS: "*" }, { CLAUDE_SONNET_MODEL: "claude-sonnet-5", CLAUDE_SONNET55_ACTIONS: "*" }] as ClaudeModelEnv[]) {
      const r = mapClaudeModelRequest(summaryBody, env, "customer_summary");
      expect(r.changed).toBe(false);
      expect(r.body).toBe(summaryBody);
    }
  });

  await it("知らない置き換え先（書き間違い）は替えない", () => {
    const r = mapClaudeModelRequest(summaryBody, { CLAUDE_SONNET_MODEL: "claude-sonnet-5.5", CLAUDE_SONNET55_ACTIONS: "*" }, "customer_summary");
    expect(r.reason).toBe("unsupported_target");
    expect(r.body).toBe(summaryBody);
  });

  await it("選んだ名札だけ: model を 5.5・thinking disabled→between_tools・キーの並びは元のまま", () => {
    const r = mapClaudeModelRequest(summaryBody, ON("customer_summary"), "customer_summary");
    expect(r.changed).toBe(true);
    const j = JSON.parse(r.body) as Record<string, unknown>;
    expect(j.model).toBe(SONNET_55_MODEL);
    expect(j.thinking).toEqual({ type: "between_tools" });
    expect(Object.keys(j)).toEqual(Object.keys(JSON.parse(summaryBody) as object));
    expect(JSON.stringify(j.system)).toBe(JSON.stringify((JSON.parse(summaryBody) as { system: unknown }).system));
    expect(mapClaudeModelRequest(summaryBody, ON("customer_summary"), "brain_fresh").changed).toBe(false);
    expect(mapClaudeModelRequest(summaryBody, ON("customer_summary"), null).changed).toBe(false);
  });

  await it("Haiku・他のモデルは `*` でも触らない", () => {
    const r = mapClaudeModelRequest(haikuBody, ON("*"), "final_check_rule_check");
    expect(r.changed).toBe(false);
    expect(r.body).toBe(haikuBody);
  });

  await it("temperature / top_p / top_k は落とす・effort xhigh/max は between_tools と組めないので high", () => {
    const b = JSON.stringify({ model: "claude-sonnet-5", max_tokens: 10, temperature: 0, top_p: 0.9, top_k: 5, thinking: { type: "disabled" }, output_config: { effort: "xhigh", format: { type: "json_schema" } }, messages: [] });
    const r = mapClaudeModelRequest(b, ON("*"), "x");
    const j = JSON.parse(r.body) as Record<string, unknown>;
    expect("temperature" in j || "top_p" in j || "top_k" in j).toBe(false);
    expect(j.output_config).toEqual({ effort: "high", format: { type: "json_schema" } });
    expect(r.edits.includes("drop:temperature")).toBe(true);
  });

  await it("adaptive・thinking 省略は触らない（between_tools にするのは disabled だけ）", () => {
    const a = JSON.stringify({ model: "claude-sonnet-5", max_tokens: 10, thinking: { type: "adaptive" }, messages: [] });
    expect((JSON.parse(mapClaudeModelRequest(a, ON("*"), "x").body) as { thinking: unknown }).thinking).toEqual({ type: "adaptive" });
    const o = JSON.stringify({ model: "claude-sonnet-5", max_tokens: 10, messages: [] });
    expect("thinking" in (JSON.parse(mapClaudeModelRequest(o, ON("*"), "x").body) as object)).toBe(false);
  });

  await it("強制のツール選択（any / tool）は 5.5 で 400 → この呼び出しは替えない（auto は替える）", () => {
    for (const type of ["any", "tool"]) {
      const b = JSON.stringify({ model: "claude-sonnet-5", max_tokens: 10, tools: [{ name: "t" }], tool_choice: { type, name: "t" }, messages: [] });
      const r = mapClaudeModelRequest(b, ON("*"), "x");
      expect(r.reason).toBe("forced_tool_choice");
      expect(r.body).toBe(b);
    }
    const auto = JSON.stringify({ model: "claude-sonnet-5", max_tokens: 10, tools: [{ name: "t" }], tool_choice: { type: "auto" }, messages: [] });
    expect(mapClaudeModelRequest(auto, ON("*"), "x").changed).toBe(true);
  });

  await it("本物と温めは1組: 名札を1つ書くと組ごと替わる（温めが古いモデルを温め続けない）", () => {
    expect(isActionSelected("customer_summary_warm", parseActionList("customer_summary"))).toBe(true);
    expect(isActionSelected("final_check_warm_revision", parseActionList("final_check_revision"))).toBe(true);
    expect(isActionSelected("final_check_warm_rule_check", parseActionList("final_check_revision"))).toBe(false);
    expect(isActionSelected("final_check_warm_context_check", parseActionList("final_check_*"))).toBe(true);
    // ブレインは毎回の層・全体の層・温めが同じ前置き（40k）
    for (const n of ["brain_full", "brain_fresh_claude", "brain-warm"]) expect(isActionSelected(n, parseActionList("brain_fresh"))).toBe(true);
    expect(isActionSelected("keep-warm", parseActionList("reply_generate"))).toBe(true);
    expect(cacheGroupOf("foo_warm")).toEqual(["foo", "foo_warm"]);
    expect(cacheGroupOf("aix_meta_patch")).toEqual(["aix_meta_patch"]);
  });

  await it("`*` は名札なしも含む・`-名前` は組ごと外す（返信生成を最後に替える指定）", () => {
    const l = parseActionList("*, -reply_generate");
    expect(isActionSelected(null, l)).toBe(true);
    expect(isActionSelected("reply_generate", l)).toBe(false);
    expect(isActionSelected("keep-warm", l)).toBe(false);
    expect(isActionSelected("customer_summary", l)).toBe(true);
    expect(isActionSelected(null, parseActionList("customer_summary"))).toBe(false);
    // 返信生成は名札なし → system 先頭で reply_generate と見なす
    expect(mapClaudeModelRequest(replyBody, ON("*,-reply_generate"), null).changed).toBe(false);
    expect(mapClaudeModelRequest(replyBody, ON("reply_generate"), null).changed).toBe(true);
    expect(effectiveActionName(null, "あなたは…")).toBe(null);
  });

  await it("返信生成の目印は llm-alt-provider.ROUTE_MARKERS と同じ文字列", () => {
    expect(REPLY_GENERATE_SYSTEM_MARKER).toBe(ROUTE_MARKERS.reply_generate);
  });

  const okJson = (model: string, stop = "end_turn") => new Response(JSON.stringify({ model, stop_reason: stop, content: [{ type: "text", text: "{}" }], usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });

  await it("送る手順: 断り（refusal）なら元の本文（Sonnet 5）で1回だけ送り直す", async () => {
    const sent: string[] = [];
    const send = async (_i: RequestInfo | URL, init?: RequestInit) => {
      const m = (JSON.parse(String(init?.body)) as { model: string }).model; sent.push(m);
      return m === SONNET_55_MODEL ? okJson(m, "refusal") : okJson(m);
    };
    const res = await sendWithClaudeModelMap(send, "https://api.anthropic.com/v1/messages", { method: "POST", body: summaryBody }, "customer_summary", ON("customer_summary"));
    expect(sent).toEqual([SONNET_55_MODEL, "claude-sonnet-5"]);
    expect(((await res.json()) as { model: string }).model).toBe("claude-sonnet-5");
  });

  await it("送る手順: 400 なら Sonnet 5 で送り直す・普通の応答は1回だけ・対象外は写さない", async () => {
    const sent: string[] = [];
    const send400 = async (_i: RequestInfo | URL, init?: RequestInit) => {
      const m = (JSON.parse(String(init?.body)) as { model: string }).model; sent.push(m);
      return m === SONNET_55_MODEL ? new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error" } }), { status: 400 }) : okJson(m);
    };
    await sendWithClaudeModelMap(send400, "u", { body: summaryBody }, "customer_summary", ON("customer_summary"));
    expect(sent).toEqual([SONNET_55_MODEL, "claude-sonnet-5"]);
    sent.length = 0;
    const sendOk = async (_i: RequestInfo | URL, init?: RequestInit) => { const m = (JSON.parse(String(init?.body)) as { model: string }).model; sent.push(m); return okJson(m); };
    await sendWithClaudeModelMap(sendOk, "u", { body: summaryBody }, "customer_summary", ON("customer_summary"));
    expect(sent).toEqual([SONNET_55_MODEL]);
    sent.length = 0;
    await sendWithClaudeModelMap(sendOk, "u", { body: summaryBody }, "brain_fresh", ON("customer_summary"));
    expect(sent).toEqual(["claude-sonnet-5"]);
  });

  await it("記録の包み: 実際に送ったモデル・thinking を記録し、名札は Anthropic に送らない", async () => {
    const rows: LlmUsageRow[] = [];
    const pending: Promise<unknown>[] = [];
    let sentHeaders: Headers | null = null;
    let sentModel = "";
    const inner = async (_i: RequestInfo | URL, init?: RequestInit) => {
      sentHeaders = new Headers(init?.headers);
      sentModel = (JSON.parse(String(init?.body)) as { model: string }).model;
      return okJson(sentModel);
    };
    const f = wrapFetchWithLlmUsageRecorder(inner, {
      insert: async (r) => { rows.push(r); }, keepAlive: (p) => { pending.push(p); }, route: () => "/api/customer-summary",
      modelEnv: () => ON("customer_summary"),
    });
    await f("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", [LLM_ACTION_HEADER]: "customer_summary" }, body: summaryBody });
    await Promise.all(pending);
    expect(sentModel).toBe(SONNET_55_MODEL);
    expect(sentHeaders!.get(LLM_ACTION_HEADER)).toBe(null);
    expect(rows.length).toBe(1);
    expect(rows[0].model).toBe(SONNET_55_MODEL);
    expect(rows[0].thinking_mode).toBe("between_tools");
    expect(rows[0].action).toBe("customer_summary");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { for (const f of failures) console.log("  - " + f); process.exit(1); }
}
main();
