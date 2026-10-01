// Next.js がサーバー起動時に1回だけ呼ぶ（リクエストを受ける前）
// LLM API への出口（globalThis.fetch）に2つの処理を入れる。SDK・LangChain・直接 fetch の全経路が通る
//   内側: 絵文字の片割れを取り除く（app/lib/llm-request-sanitize.ts・2026-09-14 400 no low surrogate）
//   外側: Anthropic の使用量を llm_usage_logs に1行ずつ残す（app/lib/llm-usage-recorder.ts・2026-09-14）
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // 2026-10-01: 包む前の素の fetch（開発サーバの見張りが「素の fetch に戻された」を見分けるため）
    const nativeFetch = globalThis.fetch;
    // 2026-10-01: 開発サーバの最後の確かめ（LLM_TEST_FINAL_CLAUDE=1）は本番と同じ Sonnet 5.5 に（本番・普段の手元は何もしない）
    if (process.env.NODE_ENV !== "production") {
      try { const note = (await import("./app/lib/llm-test-mode")).applyFinalClaudeProductionModels(process.env); if (note) console.log(note); } catch { /* 起動は止めない */ }
    }
    const { installLlmFetchSanitizer } = await import("./app/lib/llm-request-sanitize");
    installLlmFetchSanitizer();
    try {
      const { installLlmUsageRecorder } = await import("./app/lib/llm-usage-recorder");
      await installLlmUsageRecorder();
    } catch (e) {
      console.warn("[instrumentation] llm usage recorder install failed:", String(e));
    }
    // 2026-09-19 竹内「この方向性でいく」: 指定した経路だけ別のクラウド（Azure の DeepSeek V4 / Bedrock）へ回す。
    //   環境変数が揃っていない時は何もしない＝今までどおり Anthropic（fail-closed）
    try {
      const { installAltProvider } = await import("./app/lib/llm-alt-provider");
      installAltProvider();
    } catch (e) {
      console.warn("[instrumentation] alt provider install failed:", String(e));
    }
    // 2026-10-01 竹内「1～4すべて改善する」: 開発サーバだけ、Next の resetFetch（HMR）で素の fetch に戻された瞬間に同じ順で包み直す
    //   （包みの付け直しを持たない入口の Claude が記録0・テスト用の切り替えも外れていた）。本番（NODE_ENV=production・Vercel）では何もしない
    if (process.env.NODE_ENV !== "production") {
      try {
        const [rec, san, alt] = await Promise.all([import("./app/lib/llm-usage-recorder"), import("./app/lib/llm-request-sanitize"), import("./app/lib/llm-alt-provider")]);
        rec.installDevFetchGuard(nativeFetch, () => {
          san.installLlmFetchSanitizer();
          rec.reinstallLlmUsageRecorderSync();
          alt.installAltProvider();
        });
      } catch (e) {
        console.warn("[instrumentation] dev fetch guard install failed:", String(e));
      }
    }
  }
}
