// scripts/lib/llm-test-harness.ts — テスト（YUMA・ブレイン・返信・AIX）のスクリプトが**最初に**呼ぶ共通の入口
//
// 2026-10-01 竹内「テスト行う際必ずこのやりかた（ブレインのぶぶん）読むようにしたらいける。1～4すべて改善する。設計知見と協力して改善する」
//   手順書: memory/test_protocol_brain.md（テストの前に必ず読む）
//   10/01 の実測（llm_usage_logs・env=local*）: deepseek-all のつもりの回で Claude 46回（ブレインの戦略・セーブデータ・取り直し・見積書の画像の読み取り・
//   印の無い YUMA のブレイン）／記録の無い Claude（コンソールとの差 約$1.8）／和樹さんの会話で LLM 3回、が起きた。
//   スクリプトごとに包み（fetch）を入れていたので、入れ忘れ・入れる順の違い・process.exit で記録が落ちる、がばらばらに起きていた。
//   → このファイル1つを通す:
//     ① どちらのテストかを必ず明示させる（LLM_TEST_MODE=deepseek-all＝試行錯誤／LLM_TEST_FINAL_CLAUDE=1＝最後の確かめ）。どちらも無ければ止める
//     ② 開発サーバと同じ包み（絵文字の片割れ除去→使用量の記録→別クラウド）を、LLM を呼ぶモジュールを読む前に入れる
//     ③ deepseek-all の間は ANTHROPIC_API_KEY を偽の値にする＝包みを通らない Claude は 401 で必ず落ちる（黙って払わない）
//     ④ 行の route を "script:<名前>" にする（同時に走る他の担当の行と分けて数える）
//     ⑤ YUMA 以外の会話を断る（assertYuma）・場面の材料から申込の書類を落とす（test-pii-guard）
//     ⑥ 終わる時に記録の書き込みを待ち、この回の行（model・回数・費用）を出す。deepseek-all で Claude が1回でもあれば失敗で終わる
//
// 使い方（LLM を呼ぶモジュールは必ず setupLlmTest の後に dynamic import する。Anthropic SDK は作られた時点の fetch を握る）:
//   import { setupLlmTest } from "./lib/llm-test-harness";
//   const h = await setupLlmTest("yuma-xxx-test");
//   const { analyzeConversation } = await import("../app/lib/brain-core");
//   ...
//   await h.finish();   // 最後に必ず（失敗しても finally で）
import { createClient } from "@supabase/supabase-js";
import { readTestRun, readTestMode, readFinalClaude, readAllowClaude, testBlockedLog, isTestModeAllowed, applyFinalClaudeProductionModels, type LlmTestRun } from "../../app/lib/llm-test-mode";
import { YUMA_CONVERSATION_ID, isTestOnlyConversation } from "../../app/lib/test-conversations";
import { claudeUsageUsd, altUsageUsd } from "../../app/lib/llm-price";
import { cutBeforeApplicationMaterial, applicationMaterialReason } from "../../app/lib/test-pii-guard";

export const YUMA = YUMA_CONVERSATION_ID;

export type UsageSummary = {
  rows: number; claudeCalls: number; claudeUsd: number; altCalls: number; altUsd: number; blocked: number;
  byKey: Array<{ key: string; calls: number; usd: number }>;
};

export type LlmTestHarness = {
  name: string;
  run: LlmTestRun;
  /** この回の開始時刻（ISO・llm_usage_logs をこの時刻以降で数える） */
  t0: string;
  /** llm_usage_logs.route に入る値 */
  routeLabel: string;
  /** llm_usage_logs.env に入る値 */
  envLabel: string;
  /** YUMA 以外なら止める（LLM の呼び出し・書き込みの前に呼ぶ） */
  assertYuma: (conversationId: string | null | undefined, what?: string) => void;
  /** 2026-10-09: YUMA かテスト専用の会話（YUMA2〜・LINE につながっていない）でなければ止める。--conv で別の会話を使うスクリプトはこちら */
  assertTestConversation: (conversationId: string | null | undefined, what?: string) => void;
  /** 場面の材料（1通ずつ）に申込の書類・本人確認書類・収入の書類・個人の値があれば止める */
  assertSceneSafe: (texts: ReadonlyArray<string | null | undefined>, sceneId?: string) => void;
  /** 本番の会話から写す材料を、最初の書類の手前で切る（切った理由を出す） */
  cutBeforeApplicationMaterial: typeof cutBeforeApplicationMaterial;
  /** 場面の時刻（他の実行より新しく・重ならないように、今＋offsetMin 分を最後の通にして stepSec 秒ずつ前へ） */
  sceneTimes: (count: number, opts?: { offsetMin?: number; stepSec?: number }) => string[];
  /** YUMA に自分以外の新しい行（今から recentMin 分以内・未来の時刻）があるか。ownIds は自分が入れた行の id */
  foreignYumaRows: (ownIds: ReadonlyArray<string>, recentMin?: number, conversationId?: string) => Promise<Array<{ id: string; created_at: string; sender: string; text: string }>>;
  /** 他の実行の行が無くなるまで待つ（最大 maxWaitMin 分・過ぎたら止める）。conversationId でテスト専用の会話（YUMA2〜）を見る（既定 YUMA） */
  waitUntilYumaQuiet: (ownIds: ReadonlyArray<string>, opts?: { maxWaitMin?: number; recentMin?: number; conversationId?: string }) => Promise<void>;
  /** この回の llm_usage_logs を数える（書き込みを待ってから） */
  summary: () => Promise<UsageSummary>;
  /** 終わり: 書き込みを待ち、数を出し、deepseek-all で Claude があれば・止めた呼び出しがあれば exitCode=1 */
  finish: () => Promise<UsageSummary>;
};

const sb = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

function fail(msg: string): never {
  console.error(`\n⛔ ${msg}\n  手順書: memory/test_protocol_brain.md\n`);
  throw new Error(msg.split("\n")[0]);
}

export async function setupLlmTest(name: string): Promise<LlmTestHarness> {
  const env = process.env;
  if (!isTestModeAllowed(env)) fail("本番の環境（VERCEL・NODE_ENV=production）ではテストの入口を使えません");
  const strict = readTestMode(env) === "deepseek-all";
  const final = readFinalClaude(env);
  if (strict && final) fail("LLM_TEST_MODE=deepseek-all と LLM_TEST_FINAL_CLAUDE=1 が両方付いています。試行錯誤なら前だけ・最後の確かめなら後ろだけを付けて起動し直してください");
  const run = readTestRun(env);
  if (!run) fail("テストの種類が付いていません。試行錯誤（ブレインも返信も DeepSeek）なら `LLM_TEST_MODE=deepseek-all`、最後の Claude の確かめなら `LLM_TEST_FINAL_CLAUDE=1` を起動コマンドの先頭に付けてください（.env.local には書かない）");
  if (env.LLM_USAGE_RECORD === "off" || !env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) fail("使用量の記録（llm_usage_logs）が使えません。LLM_USAGE_RECORD=off を外し、--env-file=.env.local で起動してください");

  // 最後の確かめは本番と同じモデル（Sonnet 5.5）に（.env.local に無いと Sonnet 5 で走る）
  const modelNote = applyFinalClaudeProductionModels(env);
  if (modelNote) console.log(modelNote);
  // ② 開発サーバと同じ順（instrumentation.ts）: 絵文字の片割れ除去 → 使用量の記録 → 別クラウド
  const san = await import("../../app/lib/llm-request-sanitize");
  san.installLlmFetchSanitizer();
  const rec = await import("../../app/lib/llm-usage-recorder");
  const recorded = await rec.installLlmUsageRecorder();
  if (!recorded && !(globalThis.fetch as unknown as Record<symbol, unknown>)[Symbol.for("sumora.llmUsageRecorder")]) fail("使用量の記録の包みを入れられませんでした");
  rec.setScriptRouteLabel(`script:${name}`);
  const alt = await import("../../app/lib/llm-alt-provider");
  const altOn = alt.installAltProvider();
  if (strict && !altOn) fail("deepseek-all なのに DeepSeek の包みが入りません（DEEPSEEK_API_KEY／LLM_ALT_DEEPSEEK_KEY が .env.local にあるか）");

  // ③ deepseek-all の間は Claude の鍵を偽の値に（包みを通らない呼び出しを 401 で落とす）。LLM_TEST_ALLOW_CLAUDE の名札だけ包みの中で本物に戻す
  if (strict) {
    const real = (env.ANTHROPIC_API_KEY ?? "").trim();
    if (real && real !== rec.TEST_API_KEY_SENTINEL) rec.stashRealAnthropicKeyForTest(real);
    env.ANTHROPIC_API_KEY = rec.TEST_API_KEY_SENTINEL;
  }

  const t0 = new Date().toISOString();
  const { usageEnvLabel } = await import("../../app/lib/llm-test-mode");
  const envLabel = usageEnvLabel(env);
  const routeLabel = `script:${name}`;
  const allow = [...readAllowClaude(env)];
  console.log(`\n=== テスト「${name}」 ${run === "deepseek-all" ? "試行錯誤（全部 DeepSeek・Claude は止める）" : "最後の確かめ（本番と同じ組み合わせ・Claude を使う）"} ===`);
  console.log(`  env=${envLabel} route=${routeLabel} 開始=${t0}${allow.length ? ` LLM_TEST_ALLOW_CLAUDE=${allow.join(",")}` : ""}`);
  if (run === "final-claude") console.log("  ⚠ 最後の確かめは場面ごとに1〜2回まで。費用は終わりに出ます");

  const assertYuma = (conversationId: string | null | undefined, what = "LLM の呼び出し・書き込み") => {
    if (String(conversationId ?? "").trim() !== YUMA) fail(`テストは YUMA（${YUMA}）だけ。${conversationId ?? "(なし)"} で${what}をしません。お客様の会話は scripts/replay-brain-readonly.ts --copy-to-yuma で伏せ字にして写してから`);
  };
  const assertTestConversation = (conversationId: string | null | undefined, what = "LLM の呼び出し・書き込み") => {
    if (!isTestOnlyConversation(conversationId)) fail(`テストは YUMA かテスト専用の会話（YUMA2〜・app/lib/test-conversations.ts）だけ。${conversationId ?? "(なし)"} で${what}をしません`);
  };
  const assertSceneSafe = (texts: ReadonlyArray<string | null | undefined>, sceneId = "") => {
    for (const t of texts) {
      const r = applicationMaterialReason(t ?? "");
      if (r) fail(`場面${sceneId ? `「${sceneId}」` : ""}に ${r} が入っています。申込の書類・本人確認書類・収入の書類・個人の値より前で切ってください（cutBeforeApplicationMaterial）`);
    }
  };
  const sceneTimes = (count: number, opts: { offsetMin?: number; stepSec?: number } = {}) => {
    const end = Date.now() + (opts.offsetMin ?? 2) * 60_000;
    const step = (opts.stepSec ?? 20) * 1000;
    return Array.from({ length: count }, (_, i) => new Date(end - (count - 1 - i) * step).toISOString());
  };
  const foreignYumaRows = async (ownIds: ReadonlyArray<string>, recentMin = 10, conversationId: string = YUMA) => {
    assertTestConversation(conversationId, "行の確かめ");
    const since = new Date(Date.now() - recentMin * 60_000).toISOString();
    const { data } = await sb().from("messages").select("id, created_at, sender, text").eq("conversation_id", conversationId).gte("created_at", since).order("created_at", { ascending: true }).limit(200);
    const own = new Set(ownIds);
    // 2026-10-01: 未来の時刻の行（他の実行が「自分の場面を一番新しくする」ために置いた物）も他人の物として数える（⑤の行が⑦の3巡目に混ざった）
    return ((data ?? []) as Array<{ id: string; created_at: string; sender: string; text: string | null }>).filter((r) => !own.has(r.id)).map((r) => ({ ...r, text: String(r.text ?? "") }));
  };
  const waitUntilYumaQuiet = async (ownIds: ReadonlyArray<string>, opts: { maxWaitMin?: number; recentMin?: number; conversationId?: string } = {}) => {
    const conv = opts.conversationId ?? YUMA;
    const convName = conv === YUMA ? "YUMA" : `テストの会話 ${conv.slice(0, 8)}`;
    const deadline = Date.now() + (opts.maxWaitMin ?? 10) * 60_000;
    for (;;) {
      const f = await foreignYumaRows(ownIds, opts.recentMin ?? 10, conv);
      if (f.length === 0) return;
      if (Date.now() > deadline) fail(`${convName} に他の実行の行が ${f.length} 件あります（最新 ${f[f.length - 1].created_at}）。他の担当のテストが終わるのを待つか、相手に片付けを頼んでから流してください`);
      console.warn(`  … ${convName} に他の実行の行 ${f.length} 件（未来の時刻 ${f.filter((r) => Date.parse(r.created_at) > Date.now()).length} 件）→ 30秒待ちます`);
      await new Promise((r) => setTimeout(r, 30_000));
    }
  };

  const summary = async (): Promise<UsageSummary> => {
    await rec.flushLlmUsage();
    await new Promise((r) => setTimeout(r, 800));
    const { data } = await sb().from("llm_usage_logs")
      .select("created_at, action, model, status, error_type, input_uncached, cache_read, cache_write_5m, cache_write_1h, cache_write, output_tokens")
      .eq("route", routeLabel).gte("created_at", t0).order("created_at").limit(5000);
    const rows = (data ?? []) as Array<Record<string, unknown> & { model: string | null; action: string | null; status: number; error_type: string | null; created_at: string }>;
    const by = new Map<string, { calls: number; usd: number }>();
    let claudeCalls = 0, claudeUsd = 0, altCalls = 0, altUsd = 0, blocked = 0;
    for (const r of rows) {
      const isClaude = /claude/.test(r.model ?? "");
      if (r.error_type === "test_blocked") { blocked++; continue; }
      const usd = isClaude ? claudeUsageUsd(r) : altUsageUsd(r);
      if (isClaude && r.status < 400) { claudeCalls++; claudeUsd += usd; } else if (!isClaude) { altCalls++; altUsd += usd; }
      const k = `${r.action ?? "(名札なし)"} ${r.model}${r.status >= 400 || r.status === 0 ? ` status=${r.status}` : ""}`;
      const v = by.get(k) ?? { calls: 0, usd: 0 };
      v.calls++; v.usd += usd; by.set(k, v);
    }
    return { rows: rows.length, claudeCalls, claudeUsd, altCalls, altUsd, blocked, byKey: [...by].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.usd - a.usd) };
  };

  const finish = async () => {
    const s = await summary();
    const blockedLog = testBlockedLog();
    console.log(`\n=== llm_usage_logs（route=${routeLabel}・この回）: ${s.rows}行 ===`);
    for (const b of s.byKey) console.log(`  ${String(b.calls).padStart(3)}回 $${b.usd.toFixed(4)}  ${b.key}`);
    console.log(`  Claude ${s.claudeCalls}回 $${s.claudeUsd.toFixed(4)}／DeepSeek・Jev 等 ${s.altCalls}回 $${s.altUsd.toFixed(4)}／止めた ${Math.max(s.blocked, blockedLog.length)}回`);
    console.log("  ※ 開発サーバ経由（/api/...）の呼び出しはこの数に入らない。scripts/test-llm-usage.ts --since=" + t0 + " で YUMA・env 全体を数える");
    if (blockedLog.length) { console.error(`\n⛔ テストの歯止めで止めた呼び出し ${blockedLog.length}回（上のログの理由を読んで直す）:`); for (const b of blockedLog.slice(0, 10)) console.error(`  ${b}`); process.exitCode = 1; }
    if (run === "deepseek-all" && s.claudeCalls > 0 && readAllowClaude(env).size === 0) { console.error(`\n⛔ deepseek-all なのに Claude が ${s.claudeCalls}回記録されています（漏れ）。手順書の「漏れの見つけ方」を見てください`); process.exitCode = 1; }
    return s;
  };

  return { name, run: run as LlmTestRun, t0, routeLabel, envLabel, assertYuma, assertTestConversation, assertSceneSafe, cutBeforeApplicationMaterial, sceneTimes, foreignYumaRows, waitUntilYumaQuiet, summary, finish };
}
