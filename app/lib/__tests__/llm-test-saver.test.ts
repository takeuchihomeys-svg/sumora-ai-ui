// app/lib/__tests__/llm-test-saver.test.ts
// 2026-10-15 竹内「テストの時 API 使いすぎてる。もっと質高く重点的に API も節約してテストを回す」の調べで見つけた穴の歯止め:
//   (a) 最後の Claude の1日の上限 (b) 最終チェックは選んだ物だけ Claude (d) 共通の入口を通らないテストの LLM 呼び出しを止める。本番（Vercel）では全部「何もしない」。
// 実行: npx tsx app/lib/__tests__/llm-test-saver.test.ts（自己完結・LLM も DB も使わない。全 PASS で exit 0）
import {
  finalClaudeDailyMax, finalClaudeDailyCapReason, jstDayStartIso, finalCheckToDeepseek, finalCheckSelective,
  outsideHarnessRefusal, isScriptProcess, markLlmTestHarness, underLlmTestHarness, FINAL_CLAUDE_DAILY_MAX_DEFAULT,
} from "../llm-test-mode";
import { readAltConfig, shouldRouteAlt } from "../llm-alt-provider";
import { YUMA_CONVERSATION_ID } from "../test-conversations";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }
const FINAL = { LLM_TEST_FINAL_CLAUDE: "1" };
const PROD = { LLM_TEST_FINAL_CLAUDE: "1", VERCEL: "1", VERCEL_ENV: "production" };

// (a) 1日の上限
ok("既定の上限", finalClaudeDailyMax(FINAL) === FINAL_CLAUDE_DAILY_MAX_DEFAULT);
ok("上限の指定", finalClaudeDailyMax({ ...FINAL, LLM_TEST_FINAL_CLAUDE_DAILY_MAX: "12" }) === 12);
ok("off で上限なし", finalClaudeDailyMax({ ...FINAL, LLM_TEST_FINAL_CLAUDE_DAILY_MAX: "off" }) === null);
ok("余る間は通す", finalClaudeDailyCapReason(FINAL, FINAL_CLAUDE_DAILY_MAX_DEFAULT - 1, "brain_full") === null);
ok("上限で止める", /上限 60回/.test(finalClaudeDailyCapReason(FINAL, 60, "brain_full") ?? ""));
ok("final-claude でなければ数えない", finalClaudeDailyCapReason({ LLM_TEST_MODE: "deepseek-all" }, 999, null) === null && finalClaudeDailyCapReason({}, 999, null) === null);
ok("本番（Vercel）では止めない", finalClaudeDailyCapReason(PROD, 999, null) === null);
ok("JST の 0時", jstDayStartIso(Date.parse("2026-10-15T14:59:00Z")) === "2026-10-14T15:00:00.000Z" && jstDayStartIso(Date.parse("2026-10-15T15:00:00Z")) === "2026-10-15T15:00:00.000Z");

// (b) 最終チェックは選んだ物だけ Claude
const SEL = { ...FINAL, LLM_TEST_FINAL_CHECK_CLAUDE: "final_check_rule_check,final_check_verify", DEEPSEEK_API_KEY: "k" };
ok("選んでいない最終チェックは DeepSeek", finalCheckToDeepseek(SEL, "final_check_anomaly_scan") && finalCheckToDeepseek(SEL, "final_check_revision"));
ok("選んだ最終チェックは Claude", !finalCheckToDeepseek(SEL, "final_check_rule_check") && !finalCheckToDeepseek(SEL, "final_check_verify"));
ok("ブレイン・返信の本文は Claude のまま", !finalCheckToDeepseek(SEL, "brain_full") && !finalCheckToDeepseek(SEL, "reply_generate"));
ok("none は最終チェックを全部 DeepSeek", finalCheckToDeepseek({ ...FINAL, LLM_TEST_FINAL_CHECK_CLAUDE: "none" }, "final_check_rule_check"));
ok("無い・all は今までどおり", !finalCheckSelective(FINAL) && !finalCheckSelective({ ...FINAL, LLM_TEST_FINAL_CHECK_CLAUDE: "all" }));
ok("deepseek-all・本番では効かない", !finalCheckToDeepseek({ ...SEL, LLM_TEST_FINAL_CLAUDE: "", LLM_TEST_MODE: "deepseek-all" }, "final_check_x") && !finalCheckToDeepseek({ ...SEL, VERCEL: "1" }, "final_check_anomaly_scan"));
{
  const saved = { ...process.env };
  Object.assign(process.env, SEL);
  const cfg = readAltConfig(SEL);
  ok("別クラウドの設定ができる（DeepSeek）", !!cfg && cfg.provider === "deepseek", JSON.stringify(cfg?.provider));
  ok("包みが選んでいない最終チェックを回す", shouldRouteAlt(cfg, "final_check_anomaly_scan") && !shouldRouteAlt(cfg, "final_check_rule_check") && !shouldRouteAlt(cfg, "brain_fresh"));
  for (const k of Object.keys(SEL)) if (!(k in saved)) delete process.env[k]; else process.env[k] = saved[k];
  ok("切り替えが無ければ設定は今までどおり null", readAltConfig(FINAL) === null);
}

// (d) 共通の入口を通らないテストの呼び出し
ok("スクリプトの process", isScriptProcess({}) && !isScriptProcess({ NEXT_RUNTIME: "nodejs" }) && !isScriptProcess({ VERCEL: "1" }));
ok("テストの印があり入口を通っていない → 止める", /共通の入口/.test(outsideHarnessRefusal({ LLM_TEST_MODE: "deepseek-all" }, null) ?? ""));
ok("YUMA の呼び出しで入口を通っていない → 止める", !!outsideHarnessRefusal({}, YUMA_CONVERSATION_ID));
ok("テストでない呼び出し（印も YUMA も無い）は通す", outsideHarnessRefusal({}, "3db9db75-309a-4c2b-8827-284f53e68753") === null && outsideHarnessRefusal({}, null) === null);
ok("開発サーバ（Next の中）は通す", outsideHarnessRefusal({ LLM_TEST_MODE: "deepseek-all", NEXT_RUNTIME: "nodejs" }, YUMA_CONVERSATION_ID) === null);
ok("LLM_TEST_HARNESS_GUARD=off で外す", outsideHarnessRefusal({ LLM_TEST_MODE: "deepseek-all", LLM_TEST_HARNESS_GUARD: "off" }, null) === null);
ok("入口の印の前", !underLlmTestHarness());
markLlmTestHarness("unit");
ok("入口を通った後は通す", underLlmTestHarness() && outsideHarnessRefusal({ LLM_TEST_MODE: "deepseek-all" }, YUMA_CONVERSATION_ID) === null);

console.log(`llm-test-saver: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
