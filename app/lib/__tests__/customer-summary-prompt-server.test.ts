// app/lib/__tests__/customer-summary-prompt-server.test.ts — 要約の前置きの材料の読み（2026-11-14 作業員F: ilike → like）
//   実行: npx tsx app/lib/__tests__/customer-summary-prompt-server.test.ts（DB には繋がない・fetch を差し替えて URL を見る）
//   確かめる事: 変えたのは title の ilike → like だけで、他の絞り・並び・件数・結果の組み立ては前と同じ
//   （本番の DB では 11/14 朝に「ilike と like で 871行・上位8件の id が同じ」を SQL で確かめた）
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase.test";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
delete process.env.REPLAY_FLOOR_FILE;

let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };

const urls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const u = decodeURIComponent(String(input instanceof Request ? input.url : input));
  urls.push(u);
  const body = u.includes("/ai_prompts") ? "null" : JSON.stringify([{ content: "ルールA" }, { content: null }, { content: "ルールB" }]);
  const single = u.includes("/ai_prompts");
  return new Response(single ? "{}" : body, { status: single ? 406 : 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

(async () => {
  const { loadCustomerSummaryPrefixInputs } = await import("../customer-summary-prompt-server");
  const { CUSTOMER_SUMMARY_SYSTEM } = await import("../customer-summary-prompt");
  const r = await loadCustomerSummaryPrefixInputs();
  const k = urls.find((u) => u.includes("/ai_reply_knowledge")) ?? "";
  t("ai_reply_knowledge を読んだ", !!k, urls);
  t("題は like（索引が効く形）", k.includes("title=like.next_action_rule_") && !k.includes("ilike"), k);
  t("category=pattern のまま", k.includes("category=eq.pattern"), k);
  t("rejected を除くのはそのまま", k.includes("hypothesis_status=neq.rejected"), k);
  t("並びはそのまま（apply_count 降順・id 昇順）", k.includes("order=apply_count.desc,id.asc"), k);
  t("8件のまま", k.includes("limit=8"), k);
  t("中身の組み立ては前と同じ（null は空の文字）", JSON.stringify(r.nextActionRuleContents) === JSON.stringify(["ルールA", "", "ルールB"]), r.nextActionRuleContents);
  t("プロンプトが無い時はコードの定数", r.systemPrompt === CUSTOMER_SUMMARY_SYSTEM);
  console.log(`customer-summary-prompt-server: ${pass} pass / ${fail} fail`);
  if (fail) process.exit(1);
})();
