// app/lib/__tests__/llm-alt-batch-default.test.ts — 夜の一括の読みの既定の名札（reply_anatomy）
import { batchAltDefaultActions, readAltConfig, shouldRouteAlt } from "../llm-alt-provider";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
t("既定は reply_anatomy", batchAltDefaultActions({}).join() === "reply_anatomy");
t("全部外す・一部外す", batchAltDefaultActions({ LLM_ALT_BATCH_DEFAULT: "off" }).length === 0 && batchAltDefaultActions({ LLM_ALT_BATCH_EXCLUDE: "reply_anatomy" }).length === 0);
t("別クラウドの設定が無い時は今までどおり null", readAltConfig({}) === null);
const cfg = readAltConfig({ LLM_ALT_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "x", LLM_ALT_ACTIONS: "reply_generate" });
t("設定がある時は解剖が回る・返信の他の名札は増えない", !!cfg && shouldRouteAlt(cfg, "reply_anatomy") && !shouldRouteAlt(cfg, "reply_compose_intent"), cfg ? [...cfg.actions] : null);
t("off なら回らない", !shouldRouteAlt(readAltConfig({ LLM_ALT_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "x", LLM_ALT_ACTIONS: "reply_generate", LLM_ALT_BATCH_DEFAULT: "off" }), "reply_anatomy"));
console.log(`llm-alt-batch-default: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
