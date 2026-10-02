// scripts/yuma-style-revision-probe.ts — 「文に間違いの無い文体」だけの指摘で書き直すと、本文の何が変わるか（DeepSeek・DB に書かない）
//
// 2026-10-02 竹内「文体だけの指摘とは文に間違いがないことかな？それなら大丈夫」→ 書き直しを止めた（final-check.ts）。
//   過去の記録には書き直し前の本文が残っていないので、「止めた書き直しが本当の誤りを直していなかったか」を直接は数えられない。
//   代わりに、過去に文体だけの指摘が出た下書き（送った例・本番）に、同じ指摘で本物の書き直しの関数（runGroundedRevision）を当て、
//   ①事実の語（金額・日時・物件・名前）が変わるか ②実送信に近づくか遠ざかるか を数える。名前は伏せ字（maskPII）・申込の書類の手前だけ。
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-style-revision-probe.ts [--limit=45]
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const LIMIT = Number((process.argv.find((a) => a.startsWith("--limit=")) ?? "--limit=45").split("=")[1]);
const MSG: Record<string, string> = {
  NANISOTSU_MISPLACED: "この場面で「何卒よろしくお願い致します」は冗長です",
  EXCLAMATION_OVERUSE: "「！！」が多すぎます（上限3回）",
  GRATITUDE_OPENING: "お礼で始まる開口語がこの場面に合っていません",
  NAME_OVERUSE: "お客様の名前の呼びかけが多すぎます",
  FILLER_GREETING: "条件の変更への返信の冒頭の「お世話になっております」は不要です",
  PASSIVE_ONLY: "受け身の文体だけで締まっています",
  HUMBLE_WAIT: "「〜いただけますと幸いです」の受け身のお願いになっています",
  PROMISE_ECHO_MISSING: "未履行の約束の復唱がありません",
  CONDITION_OPENING: "ご条件を受けた時の開口語が違います",
  SASETE_OVERUSE: "「させて頂きます」が多すぎます（上限3回）",
};
let h: LlmTestHarness | null = null;

async function main() {
  h = await setupLlmTest("yuma-style-revision-probe");
  h.assertYuma(YUMA);
  const { runGroundedRevision, isRevisable } = await import("../app/lib/final-check");
  const { isStyleOnlyNoError } = await import("../app/lib/final-check-scope");
  const { maskPII } = await import("../app/lib/pii-mask");
  const { classifyEdit, factTokensOf, bigramSim } = await import("../app/lib/edit-diff");
  const { applicationMaterialReason } = await import("../app/lib/test-pii-guard");

  const rows: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let p = 0; p < 10; p++) {
    const { data } = await sb.from("ai_reply_examples").select("id, conversation_id, ai_draft, sent_reply, customer_message, reply_context_snapshot").gte("created_at", "2026-09-10").order("created_at").range(p * 1000, p * 1000 + 999);
    rows.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  type Pick = { id: string; draft: string; sent: string; cust: string; codes: string[] };
  const picks: Pick[] = [];
  for (const e of rows) {
    const s = e.reply_context_snapshot; if (!s?.preRevisionCodes || e.conversation_id === YUMA) continue;
    const pre = (s.preRevisionCodes as string[]).filter((x) => { const [c, sev] = x.split(":"); return sev !== "info" && !c.startsWith("TYPO_") && isRevisable({ code: c, severity: sev } as never); });
    if (!pre.length || (s.preRevisionCodes as string[]).some((x) => x.endsWith(":block"))) continue;
    if (!isStyleOnlyNoError(pre.map((x) => ({ code: x.split(":")[0], severity: x.split(":")[1] })))) continue;
    const names = [s.address_name?.name, ...((s.address_name?.aliases ?? []) as string[])].filter(Boolean);
    const draft = maskPII(String(e.ai_draft ?? "").trim() || String(s.draftHead ?? ""), names);
    const sent = maskPII(String(e.sent_reply ?? ""), names), cust = maskPII(String(e.customer_message ?? ""), names);
    if (!draft || [draft, sent, cust].some((t) => applicationMaterialReason(t))) continue;
    picks.push({ id: String(e.id), draft, sent, cust, codes: pre.map((x) => x.split(":")[0]) });
  }
  console.log(`対象: 文に間違いの無い文体だけの指摘が出た下書き ${picks.length}件（うち ${Math.min(LIMIT, picks.length)}件を書き直す）`);
  h.assertSceneSafe(picks.flatMap((p) => [p.draft, p.cust]), "style-probe");
  let factChanged = 0, unchanged = 0, closer = 0, farther = 0, failed = 0;
  for (const p of picks.slice(0, LIMIT)) {
    const issues = [...new Set(p.codes)].map((code) => {
      const ev = code === "NANISOTSU_MISPLACED" ? (p.draft.split("\n").find((l) => /何卒/.test(l)) ?? "") : "";
      return { pass: "context_check" as const, severity: "warning" as const, code, message: MSG[code] ?? code, evidence: ev.trim(), suggestion: "" };
    });
    const out = await runGroundedRevision(p.draft, issues, { lastCustomerMessage: p.cust, recentMessages: [{ sender: "customer", text: p.cust }], customerName: "お客様" }, 20000);
    if (!out) { failed++; continue; }
    const ed = classifyEdit(p.draft, out);
    const fa = factTokensOf(p.draft), fb = factTokensOf(out);
    const diffKinds = (["money", "datetime", "property"] as const).filter((k) => [...fa[k]].some((x) => !fb[k].has(x)) || [...fb[k]].some((x) => !fa[k].has(x)));
    if (ed.amount === "none" || ed.amount === "tiny") unchanged++;
    if (diffKinds.length) factChanged++;
    const a = p.sent ? bigramSim(p.draft, p.sent) : NaN, b = p.sent ? bigramSim(out, p.sent) : NaN;
    if (b > a + 0.02) closer++; else if (a > b + 0.02) farther++;
    console.log(`\n── ${p.id.slice(0, 8)} [${p.codes.join(",")}] 変化=${ed.amount}${ed.kinds.length ? `(${ed.kinds.join(",")})` : ""}${diffKinds.length ? ` ⚠事実の語が変わった:${diffKinds.join(",")}` : ""} 実送信との近さ ${a.toFixed(2)}→${b.toFixed(2)}`);
    console.log(`   前: ${p.draft.replace(/\n/g, " / ").slice(0, 160)}`);
    console.log(`   後: ${out.replace(/\n/g, " / ").slice(0, 160)}`);
    if (diffKinds.length || farther) console.log(`   実: ${p.sent.replace(/\n/g, " / ").slice(0, 160)}`);
  }
  const n = Math.min(LIMIT, picks.length) - failed;
  console.log(`\n結果 ${n}件: ほぼ変わらない ${unchanged}・事実の語（金額・日時・物件）が変わった ${factChanged}・実送信に近づいた ${closer}・遠ざかった ${farther}・失敗 ${failed}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { if (h) await h.finish(); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
