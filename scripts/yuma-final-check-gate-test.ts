// scripts/yuma-final-check-gate-test.ts — 最終チェックの要否（runFinalCheckGated）を本物の検査で確かめる（YUMA の場面・DB に書かない）
//
// 2026-10-02 竹内「ファイナルチェックが必要かどうかの監査をつけたらAPIも節約できるし、無駄がなくなる」
//   ① 影の運用（既定）: skip と判定しても今までどおり3パスが走り、下書きは今までと同じ扱い（判定は gate に記録されるだけ）
//   ② FINAL_CHECK_GATE=on: skip の時は LLM を1回も呼ばず、下書きはそのまま・passes_completed は空
//   ③ on でも中身のある下書き・センシティブは今までどおり
// 手順書 memory/test_protocol_brain.md: 試行錯誤は LLM_TEST_MODE=deepseek-all（最終チェックも DeepSeek）
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-final-check-gate-test.ts
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";

let h: LlmTestHarness | null = null;
async function main() {
  h = await setupLlmTest("yuma-final-check-gate-test");
  h.assertYuma(YUMA);
  const { runFinalCheckGated } = await import("../app/lib/final-check-gated"); // 包みの後に読む
  const staffSend = "YUMAさんお世話になっております！！\n天王寺周辺からオススメのお部屋ピックアップさせて頂きました！！\nお手隙の際にご査収ください😌！！";
  const times = h.sceneTimes(2);
  const ctxOf = (customer: string) => ({
    lastCustomerMessage: customer, customerName: "YUMA",
    recentMessages: [
      { sender: "staff", text: staffSend, createdAt: times[0] },
      { sender: "customer", text: customer, createdAt: times[1] },
    ],
    isAix: true,
  });
  h.assertSceneSafe([staffSend, "ありがとうございます！確認してみます！", "わかりました！", "審査落ちてしまいました"], "fc-gate");
  const cases: Array<{ label: string; draft: string; customer: string; env: Record<string, string>; sensitive?: boolean; want: { run: string; applied: boolean; passes: number | "any" } }> = [
    { label: "① 影の運用・決まり文句×お礼", draft: "はい😊！！\nごゆっくりご確認ください！！", customer: "ありがとうございます！確認してみます！", env: {}, want: { run: "skip", applied: false, passes: 3 } },
    { label: "② on・決まり文句×お礼（省く）", draft: "はい😊！！\nごゆっくりご確認ください！！", customer: "ありがとうございます！確認してみます！", env: { FINAL_CHECK_GATE: "on" }, want: { run: "skip", applied: true, passes: 0 } },
    { label: "③ on・日時の宣言（省かない）", draft: "はい😊！！\n本日16時お部屋ご案内させて頂きます！！", customer: "わかりました！", env: { FINAL_CHECK_GATE: "on" }, want: { run: "full", applied: false, passes: 3 } },
    { label: "④ on・センシティブ（今までどおり）", draft: "はい😊！！\n何卒よろしくお願い致します！！", customer: "ありがとうございます", env: { FINAL_CHECK_GATE: "on" }, sensitive: true, want: { run: "full", applied: false, passes: 3 } },
  ];
  let ng = 0;
  for (const c of cases) {
    const before = (await h.summary()).rows;
    const t = Date.now();
    const r = await runFinalCheckGated(c.draft, ctxOf(c.customer), { sensitive: !!c.sensitive, autoSendConversation: false, budgetMs: 90000, conversationId: YUMA, env: c.env });
    const after = (await h.summary()).rows;
    const passes = r.finalCheck.passes_completed.length;
    const ok = r.gate.run === c.want.run && r.gate.applied === c.want.applied && (c.want.passes === "any" || passes === c.want.passes)
      && (!c.want.applied || (r.finalDraft === c.draft && after === before));
    if (!ok) ng++;
    console.log(`\n${ok ? "✅" : "❌"} ${c.label}: run=${r.gate.run} applied=${r.gate.applied} mode=${r.gate.mode} reasons=${r.gate.reasons.join(",")} passes=${passes} LLM行+${after - before} ${Date.now() - t}ms`);
    console.log(`   指摘: ${r.finalCheck.issues.map((i) => `${i.code}:${i.severity}`).join(",") || "なし"} ／ 修正前: ${(r.finalCheck.pre_revision_issues ?? []).join(",") || "なし"}`);
    console.log(`   案→: ${r.finalDraft.replace(/\n/g, " ／ ")}${r.finalDraft === c.draft ? "（そのまま）" : "（書き直し）"}`);
    console.log(`   記録: ai_draft_check.gate=${JSON.stringify((r.finalCheck as { gate?: unknown }).gate)}`);
  }
  console.log(`\n結果: ${cases.length - ng}/${cases.length}`);
  if (ng) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { if (h) await h.finish(); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
