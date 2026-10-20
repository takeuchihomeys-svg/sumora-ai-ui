// DeepSeek の出口の共通の門（個人の値があれば Claude に戻す）と、ブレインの部品ごとのスイッチのテスト
// 実行: npx tsx app/lib/__tests__/alt-pii-gate.test.ts
// 2026-10-15 竹内「核となるブレインはアンソロピック（Claude）に。核じゃない所を DeepSeek にする。個人情報は渡さないのを徹底」
import { readFileSync } from "node:fs";
import * as alt from "../llm-alt-provider";
import * as recorder from "../llm-usage-recorder";
import { altPiiSignal, altPiiGateEnabled } from "../alt-pii-gate";
import { maskPII } from "../pii-mask";

let passed = 0, failed = 0;
async function it(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function ok(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const calls = { deepseek: 0, anthropic: 0 };
const stub = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  if (url.includes("api.deepseek.com")) {
    calls.deepseek++;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } }), { status: 200 });
  }
  if (!url.includes("api.anthropic.com")) return new Response("{}", { status: 200 });
  calls.anthropic++;
  return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 1 } }), { status: 200 });
}) as typeof fetch;
const reset = () => { calls.deepseek = 0; calls.anthropic = 0; };
const send = (headers: Record<string, string>, text: string) => globalThis.fetch("https://api.anthropic.com/v1/messages", {
  method: "POST", headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 50, system: "ハードゲート: テスト", messages: [{ role: "user", content: text }] }),
});

async function main() {
  console.log("── 門の判定（純関数 altPiiSignal）");
  await it("携帯番号（ハイフン・空白・続け）", () => {
    ok(altPiiSignal("連絡は090-1234-5678まで") === "携帯電話の番号", "hyphen");
    ok(altPiiSignal("・携帯番号\n080 1234 5678") === "携帯電話の番号", "space（maskPII が伏せない形）");
    ok(altPiiSignal("07012345678") === "携帯電話の番号", "plain");
  });
  await it("★ 空白区切りの携帯番号（実データ 10/01〜15 で2通）: 2026-10-18 から maskPII も伏せる・門は生の文で拾う（二重）", () => {
    ok(maskPII("080 1234 5678", []) === "[電話番号非表示]", "maskPII masks");
    ok(altPiiSignal("080 1234 5678") === "携帯電話の番号", "gate raw");
    const prev = process.env.PII_MASK_PHONE_SPACE;
    process.env.PII_MASK_PHONE_SPACE = "off";
    try { ok(altPiiSignal(maskPII("080 1234 5678", [])) === "携帯電話の番号", "off=旧（伏せない→門が拾う）"); } finally { if (prev === undefined) delete process.env.PII_MASK_PHONE_SPACE; else process.env.PII_MASK_PHONE_SPACE = prev; }
  });
  await it("メール・記入済みの申込フォーム・生年月日の欄と値・個人番号・口座番号", () => {
    ok(altPiiSignal("a.b@example.co.jp") === "メールアドレス", "mail");
    ok(altPiiSignal("【申込者様記入欄】\n・生年月日 1995年3月12日") === "記入済みの申込フォーム", "form");
    ok(altPiiSignal("生年月日：平成7年3月") === "生年月日の値", "birth era");
    ok(altPiiSignal("生年月日 1995/03/12") === "生年月日の値", "birth slash");
    ok(altPiiSignal("マイナンバー 1234 5678 9012") === "個人番号・免許証番号", "id");
    ok(altPiiSignal("口座番号：1234567") === "口座番号", "bank");
  });
  await it("★ 当てない物: 指示文の語・物件の築年月・会社の電話・URL の番号・空のフォーマット・今の日付", () => {
    ok(altPiiSignal("本人確認書類（運転免許証・パスポート）と生年月日・勤務先・年収をご用意ください") === null, "instructions");
    ok(altPiiSignal("築年月: 平成27年3月／2015年3月20日竣工") === null, "築年月");
    ok(altPiiSignal("管理会社 06-1234-5678") === null, "landline");
    ok(altPiiSignal("https://suumo.jp/chintai/jnc_000012345678/ と https://www.homes.co.jp/chintai/b-1472470012524/") === null, "url");
    ok(altPiiSignal("物件番号 100012345678") === null, "reins");
    ok(altPiiSignal("【申込者様記入欄】\n・氏名\n・生年月日\n・携帯番号") === null, "empty form");
    ok(altPiiSignal("2026年10月15日に内覧") === null, "today");
  });
  await it("スイッチ（既定 on・off で止める）", () => {
    ok(altPiiGateEnabled({}) && !altPiiGateEnabled({ LLM_ALT_PII_GATE: "off" }), "switch");
  });

  console.log("\n── 出口の包み（実際に入れて通す）");
  globalThis.fetch = stub;
  alt.installAltProvider({ LLM_ALT_PROVIDER: "deepseek", LLM_ALT_ACTIONS: "reply_generate", DEEPSEEK_API_KEY: "dummy", LLM_ALT_FALLBACK: "on" });
  const CONV = { [recorder.LLM_CONVERSATION_HEADER]: "conv-test", [recorder.LLM_CUTOFF_HEADER]: "all" };
  await it("値の無い本文は今までどおり DeepSeek", async () => {
    reset(); await send(CONV, "お客様: 別のお部屋も見てみたいです");
    ok(calls.deepseek === 1 && calls.anthropic === 0, JSON.stringify(calls));
  });
  await it("★ 印 all でも本文に携帯番号（伏せ漏れ）→ Claude", async () => {
    reset(); await send(CONV, "お客様: 携帯は090 1234 5678です");
    ok(calls.anthropic === 1 && calls.deepseek === 0, JSON.stringify(calls));
  });
  await it("★ 会話の無い呼び出しでも本文に記入済みの申込フォーム → Claude", async () => {
    reset(); await send({}, "【申込者様記入欄】\n・生年月日 1995年3月12日\n・年収 400万円");
    ok(calls.anthropic === 1 && calls.deepseek === 0, JSON.stringify(calls));
  });

  console.log("\n── ブレインの部品ごとのスイッチ（BRAIN_DS_PARTS）");
  const base = { LLM_ALT_PROVIDER: "deepseek", LLM_ALT_ACTIONS: "reply_generate", DEEPSEEK_API_KEY: "k" };
  await it("★ 既定は全部 off（セーブデータも Claude）", () => {
    ok(alt.brainDsPartsOn({}).length === 0, "default");
    ok(!alt.shouldRouteAlt(alt.readAltConfig(base), "brain_checkpoint"), "not routed");
  });
  await it("BRAIN_DS_CHECKPOINT=on で brain_checkpoint だけ回す（他のブレインは回さない）", () => {
    const cfg = alt.readAltConfig({ ...base, BRAIN_DS_CHECKPOINT: "on" });
    ok(alt.shouldRouteAlt(cfg, "brain_checkpoint"), "checkpoint");
    for (const n of ["brain_fresh", "brain_full", "brain_strategy", "customer_summary"]) ok(!alt.shouldRouteAlt(cfg, n), n);
    ok(alt.shouldRouteAlt(cfg, "reply_generate"), "既存の LLM_ALT_ACTIONS はそのまま");
  });
  await it("主の相手が無くても部品のスイッチは効く（LLM_ALT_ACTIONS は今までどおり効かない）", () => {
    const cfg = alt.readAltConfig({ DEEPSEEK_API_KEY: "k", BRAIN_DS_CHECKPOINT: "on", LLM_ALT_ACTIONS: "reply_generate" });
    ok(!!cfg && alt.shouldRouteAlt(cfg, "brain_checkpoint") && !alt.shouldRouteAlt(cfg, "reply_generate"), JSON.stringify(cfg ? [...cfg.actions] : null));
  });
  await it("★ 核（今の番の判断・戦略・全体の分析・要約）は部品の表に載せない", () => {
    for (const n of ["brain_fresh", "brain_full", "brain_strategy", "brain_fresh_claude", "customer_summary", "brain-warm"]) ok(!(n in alt.BRAIN_DS_PARTS), n);
  });
  await it("★ セーブデータは時刻の線の印を付ける（スイッチ on の時・全部渡してよい会話だけ all・他は blocked）", () => {
    const src = readFileSync("app/lib/brain-core.ts", "utf8");
    // 2026-10-20 決定 209b9a92: 印は先に読み（DeepSeek に回るかで伏せ方を分けるため）、同じ物を付ける
    ok(/const cpCutoffHeader = await checkpointCutoffHeader\(conversationId\)/.test(src) && /\[LLM_ACTION_HEADER\]: "brain_checkpoint", \[LLM_CONVERSATION_HEADER\]: conversationId, \.\.\.cpCutoffHeader \}/.test(src), "header");
    ok(/mark\.kind === "all" \? formatCutoffMark\(mark\) : "blocked"/.test(src), "all only");
    ok(/maskPII\(userContent, \[customerName\]\)/.test(src), "名前は伏せたまま");
  });

  console.log(`\n合計: ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
