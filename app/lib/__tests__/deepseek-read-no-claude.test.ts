// app/lib/__tests__/deepseek-read-no-claude.test.ts
// 実行: npx tsx app/lib/__tests__/deepseek-read-no-claude.test.ts（自己完結ハーネス。全 PASS で exit 0・外に通信しない）
//
// 2026-09-25 竹内「分析 DeepSeek で必ず行う。クロードに切り替えない。物件判断のところ。
//   読み取り必ず DeepSeek で、抜けの内容にプロンプトキャッシュを効かせる」
// 固定すること:
//   ① 物件の判断・読み取り（🌟・希望の照合・条件の要約・間取り図の有無）は DeepSeek が失敗・空・鍵なしでも **Claude を1回も呼ばない**
//   ② 失敗したら同じ前置き・同じ設定（推論なし・温度0）のまま **1回だけ**読み直す（2回目は送る文字が一字一句同じ＝キャッシュが当たる）
//   ③ 2回とも駄目なら「読み取れなかった」の印（🌟なしの1行・要確認・readFailed）
//   ④ 固定の前置き（抜けの内容を聞く所）が先頭・中身が後ろ。前置きの文字はハッシュで見張る
// fetch は差し替える（DeepSeek・Anthropic の宛先ごとに数える）。お客様の情報は使わない（物件の説明文は架空）

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// DB・使用量の記録は外に出さない（createClient が作れる程度の仮の値。宛先は下の fetch で握る）
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test";
process.env.LLM_USAGE_RECORD = "off";
process.env.ANTHROPIC_API_KEY = "dummy-anthropic";
delete process.env.LLM_ALT_PROVIDER;
delete process.env.LLM_ALT_ACTIONS;

let passed = 0, failed = 0;
const failures: string[] = [];
async function it(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function ok(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

// ── fetch の差し替え ──
type Reply = { status: number; body?: unknown } | "throw";
let deepseekReplies: Reply[] = [];
const calls = { deepseek: 0, anthropic: 0, other: 0 };
const deepseekBodies: string[] = [];
const stub = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  if (url.includes("api.anthropic.com")) { calls.anthropic++; return new Response(JSON.stringify({ content: [{ type: "text", text: '{"recommended":[1]}' }] }), { status: 200 }); }
  if (url.includes("api.deepseek.com")) {
    calls.deepseek++;
    deepseekBodies.push(String(init?.body ?? ""));
    const r = deepseekReplies.shift() ?? { status: 500 };
    if (r === "throw") throw new Error("timeout");
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}), { status: r.status });
  }
  calls.other++;
  return new Response("{}", { status: 200 });
}) as typeof fetch;
globalThis.fetch = stub;

function reset(replies: Reply[], key: string | null = "dummy-deepseek") {
  deepseekReplies = [...replies];
  calls.deepseek = 0; calls.anthropic = 0; calls.other = 0;
  deepseekBodies.length = 0;
  if (key) process.env.DEEPSEEK_API_KEY = key; else delete process.env.DEEPSEEK_API_KEY;
}
const dsText = (text: string) => ({ status: 200, body: { choices: [{ message: { content: text } }], usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_cache_hit_tokens: 896, prompt_cache_miss_tokens: 104 } } });
const dsEmpty = () => dsText("");

const SUMMARIES = ["【1】テスト物件A 101\n賃料 7.2万円 / 1K / 25㎡", "【2】テスト物件B 202\n賃料 7.4万円 / 1LDK / 30㎡", "【3】テスト物件C 303\n賃料 6.9万円 / 1K / 22㎡"];

(async () => {
  const vap = await import("../vision-alt-provider");
  const rank = await import("../pickup-rank");
  const brainImage = await import("../property-brain-image");
  const sheetRead = await import("../sheet-read-server");
  const sheetPrompt = await import("../sheet-prompt");
  const analysis = await import("../pickup-image-analysis");
  const summaryServer = await import("../condition-summary-server");
  const sheetFacts = await import("../sheet-facts");
  const alt = await import("../llm-alt-provider");
  const recorder = await import("../llm-usage-recorder");

  console.log("\n── ★ 🌟 の順位付け: Claude に倒さない ──");

  await it("★ 鍵を外すと DeepSeek も Claude も呼ばず「読み取れなかった」（🌟なし・説明文はそのまま）", async () => {
    reset([], null);
    const out = await rank.rankAndAnnotateSummariesDetailed(SUMMARIES, "家賃〜7.5万円 / 1K");
    ok(out.status === "failed", `status=${out.status}`);
    ok(JSON.stringify(out.summaries) === JSON.stringify(SUMMARIES), "説明文が変わった");
    ok(calls.anthropic === 0, `Claude が ${calls.anthropic} 回呼ばれた`);
    ok(calls.deepseek === 0, `鍵なしで DeepSeek に ${calls.deepseek} 回出た`);
    ok(rank.RANK_FAILED_NOTICE.includes("読み取れなかった"), "印の文言");
  });

  await it("★ DeepSeek が 500 を2回返す → DeepSeek 2回（1回だけ読み直し）・Claude 0回・failed", async () => {
    reset([{ status: 500 }, { status: 500 }]);
    const out = await rank.rankAndAnnotateSummariesDetailed(SUMMARIES, "家賃〜7.5万円 / 1K");
    ok(out.status === "failed", `status=${out.status}`);
    ok(calls.deepseek === 2, `DeepSeek ${calls.deepseek} 回`);
    ok(calls.anthropic === 0, `Claude が ${calls.anthropic} 回呼ばれた`);
  });

  await it("★ 時間切れ（throw）→ 空の返事 → Claude 0回・failed", async () => {
    reset(["throw", dsEmpty()]);
    const out = await rank.rankAndAnnotateSummariesDetailed(SUMMARIES, null);
    ok(out.status === "failed" && calls.deepseek === 2 && calls.anthropic === 0, JSON.stringify({ s: out.status, ...calls }));
  });

  await it("★ 1回目が空・2回目で答え → 🌟★ が付く・2回の送信は一字一句同じ（前置きキャッシュ）・推論なし・温度0", async () => {
    reset([dsEmpty(), dsText('{"recommended":[2,1]}')]);
    const out = await rank.rankAndAnnotateSummariesDetailed(SUMMARIES, "家賃〜7.5万円 / 1LDK");
    ok(out.status === "ranked", `status=${out.status}`);
    ok(out.summaries[1].startsWith("【2🌟★】") && out.summaries[0].startsWith("【1🌟】") && out.summaries[2].startsWith("【3】"), out.summaries.map((s) => s.split("\n")[0]).join(" "));
    ok(deepseekBodies.length === 2 && deepseekBodies[0] === deepseekBodies[1], "読み直しの送信が1回目と違う（キャッシュが外れる）");
    const b = JSON.parse(deepseekBodies[0]) as { thinking?: { type: string }; temperature?: number; reasoning_effort?: string; messages: Array<{ content: string }> };
    ok(b.thinking?.type === "disabled" && b.temperature === 0 && b.reasoning_effort === undefined, JSON.stringify({ t: b.thinking, temp: b.temperature, e: b.reasoning_effort }));
    ok(b.messages[b.messages.length - 1].content.startsWith(rank.RANK_PROMPT_PREFIX), "固定の前置きが先頭でない");
    ok(calls.anthropic === 0, "Claude");
  });

  await it("1回目で答えれば読み直さない（DeepSeek 1回）", async () => {
    reset([dsText('{"recommended":[3]}')]);
    const out = await rank.rankAndAnnotateSummariesDetailed(SUMMARIES, null);
    ok(out.status === "ranked" && calls.deepseek === 1, JSON.stringify({ s: out.status, ...calls }));
  });

  await it("物件が1件なら呼ばない（skipped）", async () => {
    reset([]);
    const out = await rank.rankAndAnnotateSummariesDetailed([SUMMARIES[0]], null);
    ok(out.status === "skipped" && calls.deepseek === 0, JSON.stringify(calls));
  });

  console.log("\n── ★ 読み直しの共通の口（callDeepSeekRead）──");

  await it("★ retryIf が false（時間の枠が残っていない）なら読み直さない", async () => {
    reset([{ status: 500 }, dsText("{}")]);
    const r = await vap.callDeepSeekRead(null, "x", { maxTokens: 10, timeoutMs: 1000 }, () => 1, { retryIf: () => false });
    ok(r.failed && calls.deepseek === 1, JSON.stringify({ f: r.failed, ...calls }));
  });

  await it("★ parse が投げても落ちずに読み直す（崩れた JSON）", async () => {
    reset([dsText("{壊れた"), dsText('{"a":1}')]);
    const r = await vap.callDeepSeekRead(null, "x", { maxTokens: 10, timeoutMs: 1000 }, (t) => (JSON.parse(t) as { a: number }).a);
    ok(!r.failed && r.value === 1 && r.attempts.length === 2 && r.attempts[1].retry, JSON.stringify({ v: r.value, n: r.attempts.length }));
  });

  console.log("\n── ★ 間取り図の有無（拡張の判定・売上サポ）──");

  await it("★ 500 → 読み直し → 500 で facts=null・failed・Claude 0回", async () => {
    reset([{ status: 500 }, { status: 500 }]);
    const r = await brainImage.readFloorPlanFacts("https://example.com/fp.jpg", ["bath_toilet_separate"], { timeoutMs: 8000 });
    ok(r.facts === null && r.failed === true, JSON.stringify(r));
    ok(calls.deepseek === 2 && calls.anthropic === 0, JSON.stringify(calls));
  });

  await it("★ 鍵なし → DeepSeek も Claude も呼ばない・failed", async () => {
    reset([], null);
    const r = await brainImage.readFloorPlanFacts("https://example.com/fp.jpg", ["storage"], { timeoutMs: 8000 });
    ok(r.facts === null && r.failed === true && calls.deepseek === 0 && calls.anthropic === 0, JSON.stringify({ r, calls }));
  });

  await it("★ 時間の枠が 1.5秒未満しか残らなければ読み直さない（拡張の判定の 8秒を超えない）", async () => {
    reset([{ status: 500 }, dsText('{"storage":true}')]);
    const r = await brainImage.readFloorPlanFacts("https://example.com/fp.jpg", ["storage"], { timeoutMs: 1000 });
    ok(r.failed === true && calls.deepseek === 1, JSON.stringify(calls));
  });

  await it("★ 前置き: system 固定（お客様の情報なし）・問い→画像の順・前置きのハッシュ固定", async () => {
    const h = createHash("sha256").update(brainImage.PROPERTY_BRAIN_IMAGE_SYSTEM).digest("hex").slice(0, 16);
    ok(h === "14c4fc7b55f984c8" || process.env.PRINT_HASH === "1", `PROPERTY_BRAIN_IMAGE_SYSTEM のハッシュ ${h}（変えたら固定値も直す）`);
    reset([dsText('{"storage":true}')]);
    await brainImage.readFloorPlanFacts("https://example.com/fp.jpg", ["storage"], { timeoutMs: 8000 });
    const b = JSON.parse(deepseekBodies[0]) as { messages: Array<{ role: string; content: unknown }> };
    ok(b.messages[0].role === "system" && b.messages[0].content === brainImage.PROPERTY_BRAIN_IMAGE_SYSTEM, "system が先頭でない");
    const u = b.messages[1].content as Array<{ type: string }>;
    ok(u[0].type === "text" && u[1].type === "image_url", "問い→画像の順でない");
  });

  console.log("\n── ★ 希望の照合（決まった手順で決まらない希望＝抜けの内容）──");
  const wants = [{ id: "W1", text: "洋室が広め", source: "会話", mode: "soft" }] as unknown as Parameters<typeof sheetRead.judgeWantsByText>[2];
  const text = sheetFacts.parseSheetText("");

  await it("★ 500 ×2 → checks 空・failed・使用量 2行・Claude 0回", async () => {
    reset([{ status: 500 }, { status: 500 }]);
    const r = await sheetRead.judgeWantsByText(text, null, wants);
    ok(r.failed && r.checks.length === 0 && r.usage.length === 2 && r.usage[1].retry, JSON.stringify(r));
    ok(calls.anthropic === 0, "Claude");
  });

  await it("★ 崩れた返事 → 同じ文で読み直して読めた・温度0・推論なし・固定の頭が先頭", async () => {
    reset([dsText("すみません"), dsText('{"checks":[{"id":"w1","result":"ok","why":"洋室 7帖"}]}')]);
    const r = await sheetRead.judgeWantsByText(text, null, wants);
    ok(!r.failed && r.checks.length === 1 && r.checks[0].id === "W1" && r.checks[0].result === "ok", JSON.stringify(r));
    ok(deepseekBodies[0] === deepseekBodies[1], "読み直しの送信が違う");
    const b = JSON.parse(deepseekBodies[0]) as { temperature?: number; thinking?: { type: string }; messages: Array<{ content: string }> };
    ok(b.temperature === 0 && b.thinking?.type === "disabled", "温度0・推論なしでない");
    ok(b.messages[0].content.startsWith(sheetPrompt.WANTS_JUDGE_HEAD), "固定の頭が先頭でない");
  });

  await it("★ 前置きの固定: WANTS_JUDGE_HEAD のハッシュ（変えたらキャッシュが割れる＝ここを直す）", () => {
    const h = createHash("sha256").update(sheetPrompt.WANTS_JUDGE_HEAD).digest("hex").slice(0, 16);
    ok(h === "c6fee9a6ef8d738b" || process.env.PRINT_HASH === "1", `WANTS_JUDGE_HEAD のハッシュ ${h}`);
  });

  await it("返事の読み方: checks が配列でなければ null（読み直し）・知らない id は捨てる", () => {
    ok(sheetRead.parseWantsJudgeReply('{"x":1}', wants) === null, "checks なしは null");
    const r = sheetRead.parseWantsJudgeReply('{"checks":[{"id":"W9","result":"ok"},{"id":"W1","result":"たぶん"}]}', wants);
    ok(!!r && r.length === 1 && r[0].result === "unknown", JSON.stringify(r));
  });

  console.log("\n── ★ 読み取れなかった印（売上サポ「🔍 画像で分析」）──");

  await it("★ 希望の照合が読めなかった → その希望は unknown（点に入らない）・要確認・read_failed", () => {
    const t = { ...sheetFacts.parseSheetText(""), hasText: true, name: "テスト物件A", madori: "1K", areaSqm: 25 };
    const a = analysis.buildPickupAnalysis({ wants, text: t, image: null, summary: null, llmChecks: [], unread: { wantIds: ["W1"] } });
    ok(!!a, "null");
    const c = a!.checks.find((x) => x.id === "W1");
    ok(!!c && c.result === "unknown" && c.why.includes("読み取れなかった"), JSON.stringify(c));
    ok((a!.read_failed ?? []).includes("希望の照合"), JSON.stringify(a!.read_failed));
    ok(a!.concern.some((s) => s.includes("読み取れなかった")), JSON.stringify(a!.concern));
    ok(a!.match == null || a!.ok_count === 0, "読めなかった希望が点に入った");
  });

  await it("★ 間取り図が読めなかった → read_failed に「間取り図」・要確認の1行", () => {
    const t = { ...sheetFacts.parseSheetText(""), hasText: true, name: "テスト物件A", madori: "1K", areaSqm: 25 };
    const a = analysis.buildPickupAnalysis({ wants: [], text: t, image: null, summary: null, unread: { image: true } });
    ok(!!a && (a.read_failed ?? []).includes("間取り図") && a.concern.some((s) => s.includes("間取り図を読み取れなかった")), JSON.stringify(a));
  });

  await it("読めた時は read_failed を付けない（画面・保存の形を変えない）", () => {
    const t = { ...sheetFacts.parseSheetText(""), hasText: true, name: "テスト物件A", madori: "1K" };
    const a = analysis.buildPickupAnalysis({ wants: [], text: t, image: null, summary: null });
    ok(!!a && a.read_failed === undefined, JSON.stringify(a?.read_failed));
  });

  console.log("\n── ★ 条件の要約（読めない節だけ DeepSeek）──");
  const customer = { id: "test", customer_name: "テスト", preferences: "白基調のお部屋が良い", ng_points: null, other_requests: null, additional_conditions: null } as unknown as NonNullable<Parameters<typeof summaryServer.loadConditionSummary>[1]>["customer"];

  await it("★ 500 ×2 → readFailed・保存しない（DB への書き込み 0）・Claude 0回", async () => {
    reset([{ status: 500 }, { status: 500 }]);
    const s = await summaryServer.loadConditionSummary("test-id", { allowLlm: true, customer });
    ok(!!s, "null");
    if (s!.called) {
      ok(s!.readFailed === true && calls.deepseek === 2 && calls.anthropic === 0 && calls.other === 0, JSON.stringify({ rf: s!.readFailed, ...calls }));
    } else {
      // 決定論で全部読めた（読めない節が無い）時は DeepSeek を呼ばない
      ok(calls.deepseek === 0 && calls.anthropic === 0, JSON.stringify(calls));
    }
  });

  await it("★ 鍵なし → DeepSeek も Claude も呼ばない", async () => {
    reset([], null);
    await summaryServer.loadConditionSummary("test-id", { allowLlm: true, customer });
    ok(calls.deepseek === 0 && calls.anthropic === 0, JSON.stringify(calls));
  });

  await it("「条件は無い」という正しい答え（items: []）は読めた扱い（読み直さない）", () => {
    ok(summaryServer.summaryReplyWellFormed('{"items":[]}') === true, "items:[]");
    ok(summaryServer.summaryReplyWellFormed("すみません") === false && summaryServer.summaryReplyWellFormed('{"x":1}') === false, "崩れ");
  });

  console.log("\n── ★ fetch の包み（llm-alt-provider）: 物件の判断の名札は Claude に倒さない ──");

  await it("★ property_rank の名札で Anthropic 宛てに書かれても、DeepSeek が失敗したら Claude に行かず投げる", async () => {
    reset([{ status: 500 }]);
    const env = { LLM_ALT_PROVIDER: "deepseek", LLM_ALT_ACTIONS: "property_rank,reply_generate", DEEPSEEK_API_KEY: "dummy-deepseek" };
    globalThis.fetch = stub;
    alt.installAltProvider(env);
    let threw = false;
    try {
      await globalThis.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { [recorder.LLM_ACTION_HEADER]: "property_rank", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 100, messages: [{ role: "user", content: "x" }] }),
      });
    } catch { threw = true; }
    ok(threw, "投げなかった");
    ok(calls.anthropic === 0, `Claude が ${calls.anthropic} 回`);
    ok(calls.deepseek === 1, `DeepSeek ${calls.deepseek}`);
  });

  await it("お客様への返信（reply_generate）は今まで通り失敗したら Claude に戻る（対象外）", async () => {
    reset([{ status: 500 }]);
    const res = await globalThis.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { [recorder.LLM_ACTION_HEADER]: "reply_generate", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 100, messages: [{ role: "user", content: "x" }] }),
    });
    ok(res.status === 200 && calls.anthropic === 1, JSON.stringify(calls));
    globalThis.fetch = stub;
  });

  await it("★ 名札の一覧に返信・AIX の本文・ブレインが入っていない", () => {
    for (const a of ["reply_generate", "property_send", "property_recommendation", "brain_fresh", "brain_full", "brain"]) ok(!alt.NO_CLAUDE_FALLBACK_ACTIONS.has(a), a);
    for (const a of ["property_rank", "pickup_image_analysis", "condition_summary", "property_brain_image", "search_audit"]) ok(alt.NO_CLAUDE_FALLBACK_ACTIONS.has(a), a);
  });

  console.log("\n── ★ 物件の判断・読み取りのファイルに Claude の呼び出しが無い（静かに戻らない）──");
  const root = join(__dirname, "..", "..", "..");
  const files = [
    "app/lib/pickup-rank.ts", "app/lib/sheet-read-server.ts", "app/lib/pickup-analyze-server.ts", "app/lib/pickup-auto-analyze.ts",
    "app/lib/condition-summary-server.ts", "app/lib/image-wants-server.ts", "app/lib/property-brain-image.ts", "app/lib/pickup-image-analysis.ts",
    "app/lib/search-audit-diagnose.ts", "app/lib/search-audit-server.ts",
    "app/api/merge-pdfs/route.ts", "app/api/property-brain/judge/route.ts", "app/api/property-pickups/analyze/route.ts",
  ];
  await it("★ @anthropic-ai/sdk・api.anthropic.com・claude- のモデル名を使っていない", () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(root, f), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
      if (/@anthropic-ai\/sdk|api\.anthropic\.com|["'`]claude-/.test(src)) bad.push(f);
    }
    ok(bad.length === 0, bad.join(", "));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log(failures.join("\n")); process.exit(1); }
  process.exit(0);
})();
