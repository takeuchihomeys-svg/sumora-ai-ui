// app/lib/__tests__/llm-test-strict.test.ts
// 2026-10-01 竹内「テスト行う際必ずこのやりかた（ブレインのぶぶん）読むようにしたらいける。1～4すべて改善する」:
//   テストの3つの歯止め（deepseek-all の間は Claude を止める・最後の Claude は LLM_TEST_FINAL_CLAUDE=1・YUMA 以外を断る）と
//   個人の値の網・スクリプトの鍵の差し替え・開発サーバの包み直しの見張りを固定する。本番（Vercel）では全部「何もしない」も固定。
// 実行: npx tsx app/lib/__tests__/llm-test-strict.test.ts（全 PASS で exit 0）
import { readFileSync } from "node:fs";
import {
  readTestRun, readFinalClaude, readAllowClaude, strictClaudeBlockReason, applyFinalClaudeProductionModels, testConversationRefusal, usageEnvLabel, LlmTestBlockedError, testBlockedLog,
} from "../llm-test-mode";
import { YUMA_CONVERSATION_ID } from "../test-conversations";
import { piiValueSignal, applicationMaterialReason, cutBeforeApplicationMaterial, testPiiRefusal } from "../test-pii-guard";
import {
  wrapFetchWithLlmUsageRecorder, testClaudeExitBlock, TEST_API_KEY_SENTINEL, stashRealAnthropicKeyForTest, installDevFetchGuard,
  LLM_ACTION_HEADER, LLM_CONVERSATION_HEADER, LLM_POST_APPLY_HEADER, type LlmUsageRow,
} from "../llm-usage-recorder";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const OTHER = "fecda03f-05f5-473d-8db0-c273740224ea"; // 10/01 にテストで LLM を呼んでしまった本番の会話（和樹さん）
const STRICT = { LLM_TEST_MODE: "deepseek-all", DEEPSEEK_API_KEY: "k" };
const FINAL = { LLM_TEST_FINAL_CLAUDE: "1" };
const PROD = { LLM_TEST_MODE: "deepseek-all", LLM_TEST_FINAL_CLAUDE: "1", VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production" };

async function main() {
  console.log("── ★ 本番（Vercel・NODE_ENV=production）では全部「何もしない」");
  {
    t("readTestRun は null", readTestRun(PROD) === null);
    t("最後の Claude の印も効かない", readFinalClaude(PROD) === false);
    t("Claude を止めない", strictClaudeBlockReason(PROD, { action: "brain_fresh", why: "x" }) === null);
    t("他のお客様の会話も断らない（本番はお客様の会話が仕事）", testConversationRefusal(PROD, OTHER) === null);
    t("個人の値の網も掛けない", testPiiRefusal(PROD, "090-1234-5678", "DeepSeek") === null);
    t("出口の網も null", testClaudeExitBlock({ body: "{}" }, { action: "brain_fresh", conversationId: OTHER }, PROD) === null);
    t("env 列は production のまま", usageEnvLabel(PROD) === "production");
  }

  console.log("── ★ テストの種類");
  {
    t("deepseek-all", readTestRun(STRICT) === "deepseek-all");
    t("LLM_TEST_FINAL_CLAUDE=1 → final-claude", readTestRun(FINAL) === "final-claude");
    t("両方付いていたら安い方（deepseek-all）", readTestRun({ ...STRICT, ...FINAL }) === "deepseek-all");
    t("何も無ければ null（普段の手元は今までどおり）", readTestRun({}) === null);
    t("env 列: local:final-claude", usageEnvLabel(FINAL) === "local:final-claude");
    t("env 列: local:deepseek-all", usageEnvLabel(STRICT) === "local:deepseek-all");
    const fe: Record<string, string | undefined> = { ...FINAL };
    t("最後の確かめは本番と同じ Sonnet 5.5 に（.env.local に無い時だけ）", !!applyFinalClaudeProductionModels(fe) && fe.CLAUDE_SONNET_MODEL === "claude-sonnet-5-5" && fe.CLAUDE_SONNET55_ACTIONS === "*");
    const fe2: Record<string, string | undefined> = { ...FINAL, CLAUDE_SONNET55_ACTIONS: "brain_fresh" };
    t("…書いてあれば触らない", applyFinalClaudeProductionModels(fe2) === null && fe2.CLAUDE_SONNET_MODEL === undefined);
    t("…deepseek-all・本番では何もしない", applyFinalClaudeProductionModels({ ...STRICT }) === null && applyFinalClaudeProductionModels({ ...PROD }) === null);
    t("LLM_TEST_ALLOW_CLAUDE は名札ごと・* と all は受け付けない", [...readAllowClaude({ LLM_TEST_ALLOW_CLAUDE: "extract_estimate, *,all,brain_fresh" })].join(",") === "extract_estimate,brain_fresh");
  }

  console.log("── ★ deepseek-all の間は Claude を止める（10/01 の漏れ46回: brain_fresh 33・extract_estimate 7・brain_fresh_claude 3・戦略/セーブデータ/全体 各1）");
  {
    for (const a of ["brain_fresh", "brain_fresh_claude", "brain_strategy", "brain_checkpoint", "brain_full", "extract_estimate", "aix_template", "final_check_revision"]) {
      const m = strictClaudeBlockReason(STRICT, { action: a, why: "テスト" });
      t(`${a} は止める（名札と理由と手順書を日本語で出す）`, !!m && m.includes(a) && m.includes("LLM_TEST_ALLOW_CLAUDE") && m.includes("test_protocol_brain.md"));
    }
    t("LLM_TEST_ALLOW_CLAUDE=extract_estimate なら画像の読み取りだけ通す", strictClaudeBlockReason({ ...STRICT, LLM_TEST_ALLOW_CLAUDE: "extract_estimate" }, { action: "extract_estimate", why: "画像" }) === null);
    t("…他の名札は止めたまま", strictClaudeBlockReason({ ...STRICT, LLM_TEST_ALLOW_CLAUDE: "extract_estimate" }, { action: "brain_fresh", why: "x" }) !== null);
    t("最後の確かめ（final-claude）は止めない", strictClaudeBlockReason(FINAL, { action: "brain_fresh", why: "x" }) === null);
  }

  console.log("── ★ YUMA だけ（10/01 和樹さんの会話でテストの LLM 3回）");
  {
    t("YUMA の id は test-conversations と同じ", readFileSync("app/lib/llm-test-mode.ts", "utf8").includes(`const YUMA_ID = "${YUMA_CONVERSATION_ID}"`));
    t("deepseek-all: YUMA は通す", testConversationRefusal(STRICT, YUMA_CONVERSATION_ID) === null);
    t("deepseek-all: 他の会話は断る", (testConversationRefusal(STRICT, OTHER) ?? "").includes("YUMA"));
    t("final-claude: 他の会話は断る", testConversationRefusal(FINAL, OTHER) !== null);
    t("会話の無い呼び出し（物件の読み取り等）は通す", testConversationRefusal(STRICT, null) === null);
    t("テストでない手元は断らない", testConversationRefusal({}, OTHER) === null);
  }

  console.log("── ★ 個人の値（10/01 記入済みの申込フォームが再生の場面で DeepSeek に渡った・会話 ae321772）");
  {
    const blankForm = "【お申込者様記入欄】\n・入居希望日\n・氏名、フリガナ\n・生年月日\n・現住所 〒（住民票記載）\n・携帯番号\n・メールアドレス\n・勤務先名\n・勤務先電話\n・年収";
    const filled = "【お申込者様記入欄】\n・氏名 山田太郎\n・生年月日 1998年4月12日\n・携帯番号 090-1234-5678\n・勤務先電話 06-6123-4567\n・年収 350万";
    t("空の申込フォーマット（スタッフが送る形・YUMA にある1通）は出口で止めない", piiValueSignal(blankForm) === null);
    t("記入済みのフォームは止める", piiValueSignal(filled) === "記入済みの申込フォーム");
    t("携帯番号だけでも止める", piiValueSignal("連絡は 080 1111 2222 まで") === "携帯電話の番号");
    t("会社の番号（06-）は止めない", piiValueSignal("店舗 06-6123-4567") === null);
    t("今の日付（2026年10月1日）は生年月日にしない", piiValueSignal("内覧は2026年10月4日 13:30") === null);
    t("平成の年月は生年月日の値", piiValueSignal("平成10年4月生まれ") === "生年月日の値");
    t("場面の材料（1通）: 空のフォームでも申込の欄なので切る", applicationMaterialReason(blankForm) === "申込フォームの欄");
    t("場面の材料: 保存済みの見出し（本人確認書類）", applicationMaterialReason("[画像] 本人確認書類") === "本人確認書類");
    t("場面の材料: 普通の質問は通す", applicationMaterialReason("審査通るまでどのくらいの期間見といたらいいですか？") === null);
    const cut = cutBeforeApplicationMaterial([{ text: "内覧したいです" }, { text: "かしこまりました" }, { text: filled }, { text: "よろしくお願いします" }]);
    t("書類の手前で切る（書類より後の流れも使わない）", cut.kept.length === 2 && cut.cutAt === 2 && !!cut.reason);
    t("テストの間だけ網を掛ける", testPiiRefusal(STRICT, filled, "DeepSeek") !== null && testPiiRefusal({}, filled, "DeepSeek") === null);
  }

  console.log("── ★ Claude の出口の網（記録の包み）: 別クラウドの包みが外れても止める");
  {
    const saved = { ...process.env };
    const inserted: LlmUsageRow[] = [];
    let sent: { url: string; key: string | null } | null = null;
    const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent = { url: String(input), key: new Headers(init?.headers).get("x-api-key") };
      return new Response(JSON.stringify({ model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const wrapped = wrapFetchWithLlmUsageRecorder(fake, { insert: async (r) => { inserted.push(r); }, keepAlive: () => {}, route: () => "script:test", env: "local:deepseek-all", modelEnv: () => ({}) });
    const call = (headers: Record<string, string>) => wrapped("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": TEST_API_KEY_SENTINEL, ...headers },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 10, system: "あなたはスモラAI。", messages: [{ role: "user", content: "x" }] }),
    });
    try {
      Object.assign(process.env, STRICT); delete process.env.LLM_TEST_FINAL_CLAUDE; delete process.env.LLM_TEST_ALLOW_CLAUDE;
      let err: unknown = null;
      try { await call({ [LLM_ACTION_HEADER]: "brain_strategy", [LLM_CONVERSATION_HEADER]: YUMA_CONVERSATION_ID }); } catch (e) { err = e; }
      t("deepseek-all: Claude に出る前に止める（例外）", err instanceof LlmTestBlockedError && sent === null);
      t("止めた事を1行残す（error_type=test_blocked・費用0）", inserted.length === 1 && inserted[0].error_type === "test_blocked" && inserted[0].action === "brain_strategy");
      t("止めた事を控える（スクリプトが最後に数える）", testBlockedLog().length >= 1);
      process.env.LLM_TEST_ALLOW_CLAUDE = "brain_strategy";
      stashRealAnthropicKeyForTest("sk-real");
      await call({ [LLM_ACTION_HEADER]: "brain_strategy", [LLM_CONVERSATION_HEADER]: YUMA_CONVERSATION_ID });
      t("LLM_TEST_ALLOW_CLAUDE の名札は通し、偽の鍵を本物に戻して送る", sent !== null && (sent as { key: string | null }).key === "sk-real");
      delete process.env.LLM_TEST_MODE; process.env.LLM_TEST_FINAL_CLAUDE = "1"; sent = null;
      err = null;
      try { await call({ [LLM_ACTION_HEADER]: "brain_fresh", [LLM_CONVERSATION_HEADER]: OTHER }); } catch (e) { err = e; }
      t("final-claude: YUMA 以外の会話は Claude にも出さない", err instanceof LlmTestBlockedError && sent === null);
      await call({ [LLM_ACTION_HEADER]: "brain_fresh", [LLM_CONVERSATION_HEADER]: YUMA_CONVERSATION_ID });
      t("final-claude: YUMA は Claude に出す（最後の確かめ）", sent !== null);
      delete process.env.LLM_TEST_FINAL_CLAUDE; sent = null;
      await call({ [LLM_ACTION_HEADER]: "brain_fresh", [LLM_CONVERSATION_HEADER]: OTHER, [LLM_POST_APPLY_HEADER]: "1" });
      t("テストでない時は今までどおり（他の会話・申込以降も Claude へ）", sent !== null);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  }

  console.log("── ★ deepseek-all の包み（llm-alt-provider）: 画像つき・申込以降・他の会話は止め、YUMA の印なしは DeepSeek へ");
  {
    const saved = { ...process.env };
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input); seen.push(url);
      if (url.includes("deepseek")) return new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      Object.assign(process.env, STRICT, { LLM_USAGE_RECORD: "off" });
      const { installAltProvider } = await import("../llm-alt-provider");
      t("包みが入る", installAltProvider(process.env) === true);
      const send = (headers: Record<string, string>, content: unknown = "こんにちは") => fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 10, system: "あなたはスモラAI。与えられた会話履歴を読んで", messages: [{ role: "user", content }] }),
      });
      const blocked = async (p: Promise<unknown>) => { try { await p; return false; } catch (e) { return e instanceof LlmTestBlockedError; } };
      seen.length = 0;
      await send({ [LLM_ACTION_HEADER]: "brain_strategy", [LLM_CONVERSATION_HEADER]: YUMA_CONVERSATION_ID });
      t("YUMA の戦略の整理（印なし）は DeepSeek へ（10/01 は Claude に漏れていた）", seen.length === 1 && seen[0].includes("deepseek"));
      seen.length = 0;
      t("画像つき（extract_estimate）は止める", await blocked(send({ [LLM_ACTION_HEADER]: "extract_estimate" }, [{ type: "image", source: {} }, { type: "text", text: "読んで" }])) && seen.length === 0);
      t("申込以降の YUMA は止める（status_manual_back_at を最新に）", await blocked(send({ [LLM_ACTION_HEADER]: "brain_fresh", [LLM_CONVERSATION_HEADER]: YUMA_CONVERSATION_ID, [LLM_POST_APPLY_HEADER]: "1" })) && seen.length === 0);
      t("他の会話は DeepSeek にも出さない", await blocked(send({ [LLM_ACTION_HEADER]: "brain_fresh", [LLM_CONVERSATION_HEADER]: OTHER })) && seen.length === 0);
      t("個人の値の入った本文は DeepSeek に出さない", await blocked(send({ [LLM_ACTION_HEADER]: "brain_fresh", [LLM_CONVERSATION_HEADER]: YUMA_CONVERSATION_ID }, "【お申込者様記入欄】 氏名 山田 携帯 090-1234-5678")) && seen.length === 0);
      process.env.LLM_TEST_ALLOW_CLAUDE = "extract_estimate";
      await send({ [LLM_ACTION_HEADER]: "extract_estimate" }, [{ type: "image", source: {} }, { type: "text", text: "読んで" }]);
      t("LLM_TEST_ALLOW_CLAUDE=extract_estimate なら画像は Claude へ通す", seen.length === 1 && seen[0].includes("anthropic"));
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  }

  console.log("── ★ 開発サーバの見張り: 素の fetch に戻されたら同じ順で包み直す（10/01 テンプレート生成 約27回が記録0）");
  {
    const native = (async () => new Response("native")) as unknown as typeof fetch;
    globalThis.fetch = native;
    const wrapperOf = (inner: typeof fetch) => { const w = (async (i: RequestInfo | URL, n?: RequestInit) => inner(i, n)) as typeof fetch; (w as unknown as Record<string, boolean>).wrapped = true; return w; };
    let rebuilt = 0;
    const ok = installDevFetchGuard(native, () => { rebuilt++; globalThis.fetch = wrapperOf(globalThis.fetch); }, {});
    t("手元では入る", ok === true);
    globalThis.fetch = wrapperOf(native);
    t("素の fetch 以外の代入（Next の patch-fetch 等）はそのまま", rebuilt === 0 && (globalThis.fetch as unknown as Record<string, boolean>).wrapped === true);
    globalThis.fetch = native; // Next の resetFetch と同じ形
    t("素の fetch に戻されたらその場で包み直す", rebuilt === 1 && (globalThis.fetch as unknown as Record<string, boolean>).wrapped === true);
    t("本番では入らない", installDevFetchGuard(native, () => {}, { NODE_ENV: "production" }) === false);
  }

  console.log(`\n${pass} passed / ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
