// scripts/yuma-final-check-viewing-offer-test.ts — 最終チェックが「オンライン内見や、室内の撮影もご対応させて頂きます😊！！」を落とすかの前後（DB に書かない・1回目のチェックだけ）
//   2026-10-08 竹内さん①: 出張中で日付の無い「内覧したい」には、返信で「お部屋を抑えた状態でのご内覧」＋オンライン内見・撮影の申し出（竹内さんの実際の言い回し）。
//   final-check-viewing-offer.ts の直しの前（FINAL_CHECK_VIEWING_OFFER=off）と後で、申し出の文に付く指摘（決定論＋LLM の3パス）を比べる。
//   場面は実物（d367d1b9 7/29 出張中・c1d57c97 8/30 広島在住）＋対照（事情なしの「内覧したい」に撮影で置き換える文＝止めるべき）。名前は YUMA。
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-final-check-viewing-offer-test.ts [回数=1]
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";

const ONLINE = "オンライン内見や、室内の撮影もご対応させて頂きます😊！！";
const STAR = "🌟エスリード難波レジデンス 1406号室\n\nYUMAさんにかなりオススメ出来るお部屋となります！！\n\nお手隙の際にご査収ください😌！！";
const CASES: Array<{ id: string; customer: string; draft: string; expectKeep: boolean }> = [
  { id: "出張中（d367d1b9 の形）", customer: "内覧したいのですが、現在出張中のため、そちらへ伺うことができません",
    draft: `YUMAさんお世話になっております！！\nかしこまりました！！\nご内覧前にお部屋が埋まってしまう可能性もございますので、お気に召されましたらお申込しお部屋抑えた状態でご内覧頂く事も出来ます！！\n${ONLINE}`, expectKeep: true },
  { id: "広島在住（c1d57c97 の形）", customer: "ここ気になります！今広島に住んでいて、内見が難しい状況なのですが大丈夫でしょうか？",
    draft: `YUMAさんお世話になっております！！\nはい！！広島にお住まいでもご契約可能です！！\n${ONLINE}`, expectKeep: true },
  { id: "対照: 事情なしの内覧したい→撮影で置き換え", customer: "こちら内見したいです",
    draft: "YUMAさんお世話になっております！！\nかしこまりました！！\n室内撮影しお送りさせて頂きます！！", expectKeep: false },
];
const OFFER_EVID = /オンライン内見|撮影/;

let h: LlmTestHarness | null = null;
async function main() {
  const reps = Math.max(1, Number(process.argv[2] ?? 1));
  h = await setupLlmTest("yuma-final-check-viewing-offer-test");
  h.assertYuma(YUMA);
  h.assertSceneSafe(CASES.flatMap((c) => [c.customer, c.draft]), "fc-viewing-offer");
  const { runFinalCheck } = await import("../app/lib/final-check");
  const { fetchPromptRules } = await import("../app/lib/prompt-rules");
  const rules = await fetchPromptRules("generate_reply");
  const tally: Record<string, { hit: number; n: number }> = {};
  for (let k = 0; k < reps; k++) {
    for (const c of CASES) {
      for (const mode of ["off", "on"] as const) {
        process.env.FINAL_CHECK_VIEWING_OFFER = mode;
        const ctx = { lastCustomerMessage: c.customer, customerName: "YUMA", isAix: true, isAutoSend: false,
          recentMessages: [{ sender: "staff", text: STAR }, { sender: "customer", text: c.customer }],
          dbRules: mode === "on" ? rules + "\n" : rules };
        const r = await runFinalCheck(c.draft, ctx, { timeoutMs: 40000 });
        const onOffer = r.issues.filter((i) => OFFER_EVID.test(i.evidence ?? ""));
        const t = (tally[`${c.id}|${mode}`] ??= { hit: 0, n: 0 });
        t.n++; if (onOffer.some((i) => i.severity === "block" || i.severity === "warning")) t.hit++;
        console.log(`[${k + 1}] ${c.id} ${mode}: 全指摘 ${r.issues.map((i) => `${i.code}:${i.severity}`).join(",") || "なし"}`);
        for (const i of onOffer) console.log(`    申し出の文に: ${i.code}(${i.severity}) ／ ${String(i.evidence).slice(0, 60)}`);
      }
    }
  }
  delete process.env.FINAL_CHECK_VIEWING_OFFER;
  console.log("\n=== 申し出の文（撮影・オンライン内見）に指摘が付いた回（前 off → 後 on）===");
  for (const c of CASES) {
    const a = tally[`${c.id}|off`], b = tally[`${c.id}|on`];
    console.log(`${c.id}: ${a.hit}/${a.n} → ${b.hit}/${b.n}（期待: ${c.expectKeep ? "後は 0（落とさない）" : "後も付く（止める）"}）`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { if (h) await h.finish(); setTimeout(() => process.exit(process.exitCode ?? 0), 800); });
