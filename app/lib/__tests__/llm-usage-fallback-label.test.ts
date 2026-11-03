// app/lib/__tests__/llm-usage-fallback-label.test.ts — 名札の無い呼び出しの記録の上だけの名札
import { fallbackActionLabel } from "../llm-usage-recorder";
const ok = fallbackActionLabel("/api/generate-reply", "【指示の優先順位（競合時は…", {}) === "reply_generate_claude_writer"
  && fallbackActionLabel("/api/generate-reply", "別の指示", {}) === null
  && fallbackActionLabel("/api/aix/action", "【指示の優先順位", {}) === null
  && fallbackActionLabel("/api/generate-reply", "【指示の優先順位", { LLM_USAGE_FALLBACK_LABEL: "off" }) === null;
console.log(ok ? "llm-usage-fallback-label: pass" : "llm-usage-fallback-label: FAIL");
if (!ok) process.exit(1);
