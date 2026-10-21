// 2026-10-21 書く役の flash（場面ごと・既定 off）
// 実行: npx tsx app/lib/__tests__/writer-flash-scenes.test.ts
import { writerFlashScenes, writerFlashDecision, WRITER_FLASH_ACTION, WRITER_FLASH_DEFAULT_SCENES, type WriterFlashInput } from "../writer-flash-scenes";
import { shouldRouteAlt, targetConfigFor, isAltRouteDenied, readAltConfig, DEEPSEEK_FLASH_MODEL } from "../llm-alt-provider";
import { cacheGroupOf } from "../claude-model-map";

let passed = 0, failed = 0; const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") { if (cond) passed++; else { failed++; failures.push(`${name} ${detail}`); } }

// スイッチ
ok("既定 off", writerFlashScenes({}) === null && writerFlashScenes({ WRITER_FLASH_SCENES: "off" }) === null);
ok("on は既定の場面", [...(writerFlashScenes({ WRITER_FLASH_SCENES: "on" }) ?? [])].join(",") === WRITER_FLASH_DEFAULT_SCENES.join(","));
ok("場面の指定・知らない場面と apply は捨てる", [...(writerFlashScenes({ WRITER_FLASH_SCENES: "ack, apply ,bogus" }) ?? [])].join(",") === "ack");
ok("apply だけなら off", writerFlashScenes({ WRITER_FLASH_SCENES: "apply" }) === null);
ok("既定の場面に apply・ack は無い", !WRITER_FLASH_DEFAULT_SCENES.includes("apply") && !WRITER_FLASH_DEFAULT_SCENES.includes("ack"));

// 決め
const on = { WRITER_FLASH_SCENES: "on" };
const base: WriterFlashInput = { scene: "property_share", deepseekModel: "deepseek-v4-pro", cutMarkKind: "all", autoSend: false, followUp: false, templateOptimize: false };
ok("許した場面は flash", writerFlashDecision(base, on).on);
ok("スイッチ off は pro のまま", !writerFlashDecision(base, {}).on && writerFlashDecision(base, {}).why === "switch_off");
ok("許していない場面", !writerFlashDecision({ ...base, scene: "ack" }, on).on);
ok("場面が無い", !writerFlashDecision({ ...base, scene: null }, on).on);
ok("DeepSeek に回らない（Claude の会話）", !writerFlashDecision({ ...base, deepseekModel: null }, on).on);
ok("線を引いた会話（cut）は pro", !writerFlashDecision({ ...base, cutMarkKind: "cut" }, on).on);
ok("並行の申込（masked）は pro", !writerFlashDecision({ ...base, cutMarkKind: "masked" }, on).on);
ok("blocked", !writerFlashDecision({ ...base, cutMarkKind: "blocked" }, on).on);
ok("自動返信は pro", !writerFlashDecision({ ...base, autoSend: true }, on).on);
ok("続きの番・テンプレ最適化", !writerFlashDecision({ ...base, followUp: true }, on).on && !writerFlashDecision({ ...base, templateOptimize: true }, on).on);

// 出口（llm-alt-provider）
const env = { LLM_ALT_PROVIDER: "deepseek", LLM_ALT_ACTIONS: "reply_generate", DEEPSEEK_API_KEY: "x", DEEPSEEK_REPLY_API_KEY: "x" };
const cfg = readAltConfig(env);
ok("設定が読める", !!cfg && cfg.provider === "deepseek", JSON.stringify(cfg?.provider));
if (cfg) {
  ok("flash の名札は回る", shouldRouteAlt(cfg, WRITER_FLASH_ACTION));
  ok("flash の名札は flash のモデル", targetConfigFor(cfg, WRITER_FLASH_ACTION).model === DEEPSEEK_FLASH_MODEL);
  ok("返信生成は今のまま", targetConfigFor(cfg, "reply_generate").model === cfg.model && cfg.model !== DEEPSEEK_FLASH_MODEL);
  const cfg2 = readAltConfig({ ...env, LLM_ALT_ACTIONS: "aix_template" });
  ok("返信生成を回していない構成では flash の名札も回らない", !!cfg2 && !shouldRouteAlt(cfg2, WRITER_FLASH_ACTION));
}
ok("LLM_ALT_ROUTES に書けない", isAltRouteDenied(WRITER_FLASH_ACTION));
ok("Claude に戻る時は返信生成と同じモデルの組", cacheGroupOf(WRITER_FLASH_ACTION).includes("reply_generate"));

console.log(`writer-flash-scenes: ${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log("  ✗", f); process.exit(1); }
