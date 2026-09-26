// 「DeepSeek に渡す時刻の線」の経路ごとのテスト（出口の二重の鍵・派生データの切り方・各経路の配線）
// 実行: npx tsx app/lib/__tests__/deepseek-cutoff-routes.test.ts
// 2026-09-26 竹内「申込の間の部分は DeepSeek に渡さず、申込落ちてステータスを切り替えたら、切り替えたところ以降渡せば個人情報防げる」
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as alt from "../llm-alt-provider";
import * as recorder from "../llm-usage-recorder";
import { cutBrainGate, keepIfMadeAfter, keepBrainMeta, keepConversationDirection } from "../deepseek-cut";
import { runInDeepseekScope, setDeepseekScope, currentDeepseekScope, onceAsync } from "../deepseek-scope";
import { NO_CUTOFF, preCutoffChunks, formatCutoffMark } from "../post-apply";

let passed = 0, failed = 0; const failures: string[] = [];
async function it(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(name); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function ok(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
const LINE = "2026-09-16T00:00:00.000Z";

// ── fetch の差し替え（Anthropic / DeepSeek のどちらに行ったかを数える） ──
const calls = { deepseek: 0, anthropic: 0 };
const stub = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  if (url.includes("api.deepseek.com")) {
    calls.deepseek++;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } }), { status: 200 });
  }
  if (!url.includes("api.anthropic.com")) return new Response("{}", { status: 200 }); // 記録の書き込み等は数えない
  calls.anthropic++;
  return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 1 } }), { status: 200 });
}) as typeof fetch;
const reset = () => { calls.deepseek = 0; calls.anthropic = 0; };
const send = (headers: Record<string, string>, text = "お客様: 別のお部屋も見てみたいです") => globalThis.fetch("https://api.anthropic.com/v1/messages", {
  method: "POST", headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 50, system: "ハードゲート: テスト", messages: [{ role: "user", content: text }] }),
});

async function main() {
  console.log("── 出口の判定（純関数 cutoffGateDecision）");
  await it("blocked は回さない", () => ok(alt.cutoffGateDecision({ conversationId: "c", inScope: true, mark: { kind: "blocked" } }) === "claude:blocked", "blocked"));
  await it("会話の呼び出しで印が無ければ回さない（会話 ID のヘッダ・箱のどちらでも）", () => {
    ok(alt.cutoffGateDecision({ conversationId: "c", inScope: false, mark: null }) === "claude:no_mark", "header");
    ok(alt.cutoffGateDecision({ conversationId: null, inScope: true, mark: null }) === "claude:no_mark", "scope");
  });
  await it("会話の無い呼び出し（物件の読み取り等）は今までどおり", () => ok(alt.cutoffGateDecision({ conversationId: null, inScope: false, mark: null }) === "route", "none"));
  await it("all / cut は回す", () => {
    ok(alt.cutoffGateDecision({ conversationId: "c", inScope: true, mark: { kind: "all" } }) === "route", "all");
    ok(alt.cutoffGateDecision({ conversationId: "c", inScope: true, mark: { kind: "cut", at: LINE } }) === "route", "cut");
  });

  console.log("\n── 出口の包み（llm-alt-provider を実際に入れて通す）");
  globalThis.fetch = stub;
  alt.installAltProvider({ LLM_ALT_PROVIDER: "deepseek", LLM_ALT_ACTIONS: "reply_generate", DEEPSEEK_API_KEY: "dummy", LLM_ALT_FALLBACK: "on" });
  const CONV = { [recorder.LLM_CONVERSATION_HEADER]: "conv-test" };
  await it("★ 会話 ID があって印が無い → Claude（線を引かずに来た呼び出し）", async () => {
    reset(); await send({ ...CONV });
    ok(calls.anthropic === 1 && calls.deepseek === 0, JSON.stringify(calls));
  });
  await it("★ 印 blocked → Claude", async () => {
    reset(); await send({ ...CONV, [recorder.LLM_CUTOFF_HEADER]: formatCutoffMark({ kind: "blocked" }) });
    ok(calls.anthropic === 1 && calls.deepseek === 0, JSON.stringify(calls));
  });
  await it("印 all → DeepSeek", async () => {
    reset(); await send({ ...CONV, [recorder.LLM_CUTOFF_HEADER]: "all" });
    ok(calls.deepseek === 1 && calls.anthropic === 0, JSON.stringify(calls));
  });
  await it("読めない印（知らない値）は blocked 扱い → Claude", async () => {
    reset(); await send({ ...CONV, [recorder.LLM_CUTOFF_HEADER]: "yes-please" });
    ok(calls.anthropic === 1 && calls.deepseek === 0, JSON.stringify(calls));
  });
  await it("会話の無い呼び出し（印も箱も無い）は今までどおり DeepSeek", async () => {
    reset(); await send({});
    ok(calls.deepseek === 1, JSON.stringify(calls));
  });
  await it("★ 箱の中で印がまだ無い（線を引く前・名札の無い中の呼び出し）→ Claude", async () => {
    reset(); await runInDeepseekScope(() => send({}));
    ok(calls.anthropic === 1 && calls.deepseek === 0, JSON.stringify(calls));
  });
  const before = preCutoffChunks(["勤務先は大阪市内の株式会社サンプルで勤続三年です。年収は四百万円ほどです"]);
  await it("★ 箱の印 cut・本文に線より前のお客様の発言が残っている → Claude（出口の網）", async () => {
    reset();
    await runInDeepseekScope(async () => {
      setDeepseekScope({ conversationId: "conv-test", mark: { kind: "cut", at: LINE }, netChunks: onceAsync(async () => before) });
      await send({}, "【会話履歴】\nお客様: 勤務先は大阪市内の株式会社サンプルで勤続三年です\nお客様: 別のお部屋も見たいです");
    });
    ok(calls.anthropic === 1 && calls.deepseek === 0, JSON.stringify(calls));
  });
  await it("箱の印 cut・線より後だけの本文 → DeepSeek", async () => {
    reset();
    await runInDeepseekScope(async () => {
      setDeepseekScope({ conversationId: "conv-test", mark: { kind: "cut", at: LINE }, netChunks: onceAsync(async () => before) });
      await send({});
    });
    ok(calls.deepseek === 1 && calls.anthropic === 0, JSON.stringify(calls));
  });
  await it("★ 網の材料が読めない（例外）→ Claude（fail-closed）", async () => {
    reset();
    await runInDeepseekScope(async () => {
      setDeepseekScope({ conversationId: "conv-test", mark: { kind: "cut", at: LINE }, netChunks: onceAsync(async () => { throw new Error("db down"); }) });
      await send({});
    });
    ok(calls.anthropic === 1 && calls.deepseek === 0, JSON.stringify(calls));
  });
  await it("ヘッダの印が箱の印より優先（AIX はヘッダで持つ）", async () => {
    reset();
    await runInDeepseekScope(async () => {
      setDeepseekScope({ conversationId: "conv-test", mark: { kind: "all" } });
      await send({ ...CONV, [recorder.LLM_CUTOFF_HEADER]: "blocked" });
    });
    ok(calls.anthropic === 1 && calls.deepseek === 0, JSON.stringify(calls));
  });
  await it("箱は並行するリクエストで混ざらない（AsyncLocalStorage）", async () => {
    const seen: string[] = [];
    await Promise.all(["a", "b"].map((id) => runInDeepseekScope(async () => {
      setDeepseekScope({ conversationId: id });
      await new Promise((r) => setTimeout(r, id === "a" ? 20 : 5));
      seen.push(`${id}:${currentDeepseekScope()?.conversationId}`);
    })));
    ok(seen.sort().join(",") === "a:a,b:b", seen.join(","));
  });
  await it("★ 印のヘッダは Anthropic に送らない（記録器が取り除く）", () => {
    const m = recorder.extractSumoraMarks({ headers: { [recorder.LLM_CUTOFF_HEADER]: "all", "x-other": "1" } });
    const h = m.init?.headers as Record<string, string>;
    ok(!(recorder.LLM_CUTOFF_HEADER in h) && h["x-other"] === "1", JSON.stringify(h));
  });

  console.log("\n── 派生データの切り方（deepseek-cut.ts）");
  await it("ブレインの判断は見た最後のお客様発言が線より後だけ残る", () => {
    ok(keepBrainMeta({ action: "x", analyzed_msg_ts: "2026-09-20T00:00:00Z" }, LINE) !== null, "後");
    ok(keepBrainMeta({ action: "x", analyzed_msg_ts: "2026-09-10T00:00:00Z" }, LINE) === null, "前");
    ok(keepBrainMeta({ action: "x" }, LINE) === null, "時刻なし");
    ok(keepBrainMeta({ action: "x" }, NO_CUTOFF) !== null, "線なし");
    ok(keepBrainMeta({ action: "x", analyzed_msg_ts: "2030-01-01T00:00:00Z" }, null) === null, "申込中");
  });
  await it("会話の方向は updated_at で", () => {
    ok(keepConversationDirection({ current_phase: "p", updated_at: "2026-09-20T00:00:00Z" }, LINE) !== null, "後");
    ok(keepConversationDirection({ current_phase: "p", updated_at: "2026-09-01T00:00:00Z" }, LINE) === null, "前");
  });
  await it("要約（作った時刻つき）", () => {
    ok(keepIfMadeAfter({ s: 1 }, "2026-09-20T00:00:00Z", LINE) !== null, "後");
    ok(keepIfMadeAfter({ s: 1 }, null, LINE) === null, "時刻なし");
  });
  await it("cutBrainGate は3つをまとめて切り、他の項目は残す", () => {
    const g = cutBrainGate({ meta: { analyzed_msg_ts: "2026-09-10T00:00:00Z" }, lastMeta: { analyzed_msg_ts: "2026-09-20T00:00:00Z" }, conversationDirection: null, customerName: "x", brainAnalyzedAt: "t" }, LINE)!;
    ok(g.meta === null && g.lastMeta !== null && g.customerName === "x" && g.brainAnalyzedAt === "t", JSON.stringify(g));
  });

  console.log("\n── 経路の配線（実ファイルの形）");
  const root = join(__dirname, "..", "..", "..");
  const src = (p: string) => readFileSync(join(root, p), "utf8");
  const gen = src("app/api/generate-reply/route.ts");
  const aix = src("app/api/aix/action/route.ts");
  await it("返信生成: リクエストごとに箱を開ける", () => ok(/return runInDeepseekScope\(\(\) => handleGenerateReply\(req\)\)/.test(gen), "POST"));
  await it("返信生成: 戻した会話を丸ごと Claude にする旧の歯止め（movedBack）を線に置き換えた", () =>
    ok(!/postApplyConversation = r\.postApply \|\| r\.movedBack/.test(gen) && /deepseekCutoff = deepseekSafeCutoff\(facts\)/.test(gen), "movedBack"));
  await it("返信生成: 線より前の発言への返信は blocked（Claude）", () => ok(/isAfterCutoff\(latestCustomerAtForCut, deepseekCutoff\)/.test(gen) && /else deepseekBlocked = true/.test(gen), "blocked"));
  await it("返信生成: 履歴・台帳・AIX の履歴・送った事実・内覧の報告・ブレインの判断・要約・セーブデータ・引用を線で切る", () => {
    for (const re of [
      /recentMessages = filterAfterCutoff\(recentMessages/, /ledgerTasks = filterAfterCutoff\(ledgerTasks/, /recentAixRows = filterAfterCutoff\(recentAixRows/,
      /recordedFacts = filterAfterCutoff\(recordedFacts/, /viewingReports = filterAfterCutoff\(viewingReports/, /cutBrainGate\(brainGateRaw, deepseekCutoff\)/,
      /fetchSummaryJsonByConversation\(conversationId, deepseekCutActive/, /fetchGroundTruth\(conversationId, deepseekCutActive/, /fetchQuotedContext\(conversationId, deepseekCutActive/,
      /customerSummary = "";/, /\[LLM_CUTOFF_HEADER\]: formatCutoffMark\(replyCutMark\)/,
    ]) ok(re.test(gen), re.source);
  });
  await it("AIX: 両方の入口で箱を開け、本文を読む前に線を引いて履歴を切る", () => {
    ok((aix.match(/runInDeepseekScope\(\(\) => aixRequestCtx\.run/g) ?? []).length === 2, "run x2");
    ok(/body\.recent_messages = filterAfterCutoff\(/.test(aix), "history");
    ok(/ctx\.postApply = r\.postApply;/.test(aix) && !/r\.postApply \|\| r\.movedBack/.test(aix), "movedBack");
    ok(/if \(store\?\.cutMark\) h\[LLM_CUTOFF_HEADER\]/.test(aix), "header");
    ok(/keepBrainMeta\(metaRaw/.test(aix), "brain");
    ok(/visionCutMark\.kind !== "blocked"/.test(aix), "vision");
  });
  await it("物件の評価・画像の読み取り（送った時・引用）も同じ線", () => {
    ok(/loadDeepseekCutoff\(supabase, convIdForCut\)/.test(src("app/api/evaluate-property/route.ts")), "evaluate");
    ok(/loadDeepseekCutoff\(supabase, conversationId\)/.test(src("app/lib/image-detail-store.ts")), "image-detail");
    ok(/loadDeepseekCutoff\(supabase, conversationId\)\) === null/.test(src("app/lib/sent-image-record.ts")), "sent-image");
    ok(/sentAt: quoted\.created_at/.test(src("app/lib/quoted-context.ts")), "quoted");
  });
  await it("線を書くのは DB のトリガー（migrate-schema と本番反映スクリプトが同じ文）", () => {
    const mig = src("app/api/migrate-schema/route.ts"), app = src("scripts/apply-deepseek-cutoff.ts");
    for (const s of ["ADD COLUMN IF NOT EXISTS deepseek_cutoff_at", "CREATE OR REPLACE FUNCTION stamp_deepseek_cutoff()", "BEFORE UPDATE OF status, is_post_apply, status_manual_back_at ON conversations", "IF was_post THEN NEW.deepseek_cutoff_at := now(); END IF;"]) {
      ok(mig.includes(s) && app.includes(s), s);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log(failures.map((f) => `- ${f}`).join("\n")); process.exit(1); }
  process.exit(0);
}
main();
