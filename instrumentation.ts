// Next.js がサーバー起動時に1回だけ呼ぶ（リクエストを受ける前）
// LLM API への出口（globalThis.fetch）に2つの処理を入れる。SDK・LangChain・直接 fetch の全経路が通る
//   内側: 絵文字の片割れを取り除く（app/lib/llm-request-sanitize.ts・2026-09-14 400 no low surrogate）
//   外側: Anthropic の使用量を llm_usage_logs に1行ずつ残す（app/lib/llm-usage-recorder.ts・2026-09-14）
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installLlmFetchSanitizer } = await import("./app/lib/llm-request-sanitize");
    installLlmFetchSanitizer();
    try {
      const { installLlmUsageRecorder } = await import("./app/lib/llm-usage-recorder");
      await installLlmUsageRecorder();
    } catch (e) {
      console.warn("[instrumentation] llm usage recorder install failed:", String(e));
    }
    // 2026-09-19 竹内「AWSのクラウド経由する」: 指定した経路だけ Bedrock（DeepSeek）へ回す。
    //   環境変数が揃っていない時は何もしない＝今までどおり Anthropic（fail-closed）
    try {
      const { installBedrockRouter } = await import("./app/lib/bedrock-router");
      installBedrockRouter();
    } catch (e) {
      console.warn("[instrumentation] bedrock router install failed:", String(e));
    }
  }
}
