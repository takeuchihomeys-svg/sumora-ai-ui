// Next.js がサーバー起動時に1回だけ呼ぶ（リクエストを受ける前）
// 2026-09-14: LLM API への送信から絵文字の片割れを取り除く出口の処理を入れる（app/lib/llm-request-sanitize.ts）
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installLlmFetchSanitizer } = await import("./app/lib/llm-request-sanitize");
    installLlmFetchSanitizer();
  }
}
