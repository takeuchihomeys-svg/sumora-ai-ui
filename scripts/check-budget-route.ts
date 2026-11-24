// scripts/check-budget-route.ts — 予算の振り分け（LLM_BUDGET_ROUTE）の確かめ（作業員L・2026-11-24・台帳 #670）
//   本番の出口（installAltProvider の fetch の包み）を手元で入れ、ブレインの名札（brain_fresh）の小さい要求を1つずつ送る:
//     ① shadow … 決めた結果をログに出すだけ（Claude のまま）＝呼び先は Claude
//     ② on・線 $0 … 呼び先が OpenAI（応答の model と id を出す）
//     ③ on・OpenAI の鍵をわざと壊す … 失敗して Claude に戻る（下書きが出ない事が無い）
//   お客様の会話も LINE も使わない（会話の印なし・時刻の線は「全部渡してよい」の印）。要求は短い文（max_tokens 16）。
// 実行: npx tsx --env-file=.env.local scripts/check-budget-route.ts [--only=1,2,3]
const argv = process.argv.slice(2);
const only = (argv.find((a) => a.startsWith("--only="))?.slice(7) ?? "1,2,3").split(",");

async function one(label: string, env: Record<string, string>) {
  // 毎回包みを入れ直す（env を替えるため）
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const mod = await import("../app/lib/llm-alt-provider");
  const { resetBudgetCache } = await import("../app/lib/llm-budget-route-server");
  resetBudgetCache();
  const g = globalThis as unknown as { __origFetch?: typeof fetch };
  g.__origFetch ??= globalThis.fetch;
  globalThis.fetch = g.__origFetch;
  (mod as unknown as { resetAltBreakers: () => void }).resetAltBreakers();
  // installAltProvider は1度だけ入る作り（installed の印）。印を外すため module を読み直す代わりに、包みの印を外して呼ぶ
  delete (globalThis.fetch as unknown as Record<string, unknown>)["__sumoraAltFetch"];
  const ok = mod.installAltProvider(process.env);
  const started = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01", "x-sumora-llm-action": "brain_fresh", "x-sumora-llm-deepseek-cutoff": "all" },
    body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 16, system: "あなたは確かめ用の係です。", messages: [{ role: "user", content: "「はい」とだけ答えてください。" }] }),
  });
  const j = await res.json().catch(() => ({})) as { model?: string; id?: string; content?: Array<{ text?: string }> };
  console.log(JSON.stringify({ label, installed: ok, status: res.status, model: j.model ?? null, id: (j.id ?? "").slice(0, 16), text: (j.content?.[0]?.text ?? "").slice(0, 20), ms: Date.now() - started }));
}

(async () => {
  const base = { LLM_BUDGET_ROUTE: "shadow", CLAUDE_SWITCH_AT_USD: "0", CLAUDE_SPEND_BASE_USD: "1", CLAUDE_SPEND_BASE_AT: new Date(Date.now() - 60_000).toISOString(), LLM_ALT_FALLBACK: "on" };
  if (only.includes("1")) await one("① shadow（Claude のまま・決めた結果はログ）", base);
  if (only.includes("2")) await one("② on（OpenAI）", { ...base, LLM_BUDGET_ROUTE: "on" });
  if (only.includes("3")) { const key = process.env.OPENAI_API_KEY ?? ""; await one("③ on・OpenAI の鍵を壊す（Claude に戻る）", { ...base, LLM_BUDGET_ROUTE: "on", OPENAI_API_KEY: "sk-broken" }); process.env.OPENAI_API_KEY = key; }
})().catch((e) => { console.error(e); process.exit(1); });
