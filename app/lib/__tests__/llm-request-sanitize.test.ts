// 2026-09-14 API 漏れ調査: .slice で絵文字の途中が切れ、Anthropic が「no low surrogate in string」で 400 を返していた
//   （analyze-applying・customer-summary・corpus2skill・recommend-templates）。出口（fetch）で片割れを取り除く
// 実行: npx tsx app/lib/__tests__/llm-request-sanitize.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { stripLoneSurrogates, sanitizeLlmJsonBody, wrapFetchWithLlmSanitizer, installLlmFetchSanitizer } from "../llm-request-sanitize";

let passed = 0, failed = 0; const failures: string[] = [];
async function it(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toBeTrue() { if (actual !== true) throw new Error(`expected true but got ${JSON.stringify(actual)}`); },
  };
}
// Anthropic が拒否する形（片割れのエスケープ）が本文に残っていないか
const hasLoneEscape = (body: string) => /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/.test(body.replace(/\\\\/g, ""));

// 本番の失敗の再現: customer-summary は (m.text || "").slice(0, 300) で切る
const customerText = "あ".repeat(299) + "😊よろしくお願いします";
const cut = customerText.slice(0, 300); // 絵文字の前半だけが残る

async function main() {
  await it("再現: .slice で絵文字が切れると JSON.stringify が片割れを \\ud83d で書く（Anthropic が 400 にする形）", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: cut }] });
    expect(hasLoneEscape(body)).toBeTrue();
  });

  await it("片割れを取り除き、送れる JSON にする（前後の文字は残る）", () => {
    const body = JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: cut }] });
    const r = sanitizeLlmJsonBody(body);
    expect(r.removed).toBe(1);
    expect(hasLoneEscape(r.body)).toBe(false);
    const parsed = JSON.parse(r.body) as { model: string; messages: { content: string }[] };
    expect(parsed.messages[0].content).toBe("あ".repeat(299));
    expect(parsed.model).toBe("claude-sonnet-5");
  });

  await it("正しい絵文字・後ろ半分だけの片割れ・配列の中の system ブロックも扱う", () => {
    const lowOnly = "😊".slice(1) + "です";
    const body = JSON.stringify({ system: [{ type: "text", text: "OK😊", cache_control: { type: "ephemeral", ttl: "1h" } }], messages: [{ role: "user", content: [{ type: "text", text: lowOnly }] }] });
    const r = sanitizeLlmJsonBody(body);
    expect(r.removed).toBe(1);
    const parsed = JSON.parse(r.body) as { system: { text: string }[]; messages: { content: { text: string }[] }[] };
    expect(parsed.system[0].text).toBe("OK😊");
    expect(parsed.messages[0].content[0].text).toBe("です");
  });

  await it("直す物が無い本文は1文字も変えない（プロンプトキャッシュの先頭一致を守る）", () => {
    const body = '{"a":"絵文字😊と改行\\nと空白 ","b":1.0}';
    expect(sanitizeLlmJsonBody(body).body).toBe(body);
  });

  await it("「\\ud83d」という文字そのもの（エスケープされた \\）は片割れではないので変えない", () => {
    const body = JSON.stringify({ a: "コードの例 \\ud83d" });
    const r = sanitizeLlmJsonBody(body);
    expect(r.removed).toBe(0);
    expect(r.body).toBe(body);
  });

  await it("JSON でない本文は変えない", () => {
    expect(sanitizeLlmJsonBody("\\ud83d not json").body).toBe("\\ud83d not json");
  });

  await it("stripLoneSurrogates: 正しい対は残し、片割れだけ消す", () => {
    const r = stripLoneSurrogates("a" + "😀".slice(0, 1) + "b😀c" + "😀".slice(1));
    expect(r.text).toBe("ab😀c");
    expect(r.removed).toBe(2);
  });

  await it("fetch の包み: Anthropic 宛ての文字列本文を直す／ほかの宛先・文字列でない本文は触らない", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const fake = async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, body: init?.body });
      return new Response("{}");
    };
    const f = wrapFetchWithLlmSanitizer(fake);
    const bad = JSON.stringify({ messages: [{ role: "user", content: cut }] });
    await f("https://api.anthropic.com/v1/messages", { method: "POST", body: bad });
    await f(new URL("https://api.openai.com/v1/embeddings"), { method: "POST", body: bad });
    await f("https://wfwsmwxakhyxobytszoq.supabase.co/rest/v1/x", { method: "POST", body: bad });
    const bytes = new TextEncoder().encode(bad);
    await f("https://api.anthropic.com/v1/messages", { method: "POST", body: bytes });
    expect(hasLoneEscape(String(seen[0].body))).toBe(false);
    expect(hasLoneEscape(String(seen[1].body))).toBe(false);
    expect(seen[2].body).toBe(bad);
    expect(seen[3].body === bytes).toBeTrue();
  });

  await it("install: globalThis.fetch を1回だけ包み、Anthropic SDK（生成時に global fetch を掴む）経由でも直る", async () => {
    const g = globalThis as unknown as { fetch: typeof fetch };
    const realFetch = g.fetch;
    let captured: unknown = null;
    const fake = Object.assign(async (_i: RequestInfo | URL, init?: RequestInit) => { captured = init?.body; return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "x", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { "content-type": "application/json" } }); }, { __nextPatched: true });
    g.fetch = fake as unknown as typeof fetch;
    try {
      expect(installLlmFetchSanitizer()).toBe(true);
      expect(installLlmFetchSanitizer()).toBe(false); // 二重に包まない
      expect((g.fetch as unknown as { __nextPatched?: boolean }).__nextPatched).toBe(true); // Next の印を引き継ぐ
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: "test", maxRetries: 0 });
      await client.messages.create({ model: "claude-sonnet-5", max_tokens: 10, messages: [{ role: "user", content: cut }] });
      expect(typeof captured).toBe("string");
      expect(hasLoneEscape(captured as string)).toBe(false);
    } finally {
      g.fetch = realFetch;
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
}
main();
