// yuma-material-plan-read-test.ts — 区切り3: 物件資料の間取り図をその場で読む（material-answer-server.readMaterialPlan）を実物の資料の画像で確かめる
// 画像はこちらが送った物件の資料だけ（sent_image_properties の画像・image_details の kind=property）。お客様の画像・本人確認書類は渡さない。
// 会話の記録は YUMA の名札で残す（本物の会話の ID で LLM を呼ばない）。保存はしない（MATERIAL_ANSWER_NO_SAVE=1）。
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-material-plan-read-test.ts [--url=<画像URL>]...
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
let h: LlmTestHarness | null = null;
// 既定: 055d4212（会話 22b2511e・エステムコート難波IVアトリ・竹内さんは「洗面台とトイレが同じ間取り…アメリカンセパレート」）の送った資料
const DEFAULT_URLS = [
  "https://wfwsmwxakhyxobytszoq.supabase.co/storage/v1/object/public/property-images/aix/22b2511e-034e-44f4-8c10-b737716a3284/1791537562664_0_bzmsp.jpeg",
];
async function main() {
  process.env.MATERIAL_ANSWER_NO_SAVE = "1";
  h = await setupLlmTest("yuma-material-plan-read-test");
  const { readMaterialPlan } = await import("../app/lib/material-answer-server");
  const { planReadLines } = await import("../app/lib/material-question");
  const urls = process.argv.filter((a) => a.startsWith("--url=")).map((a) => a.slice(6));
  const repeat = Number((process.argv.find((a) => a.startsWith("--repeat=")) ?? "--repeat=1").slice(9));
  for (const u of urls.length ? urls : DEFAULT_URLS) {
    for (let i = 0; i < repeat; i++) {
      const r = await readMaterialPlan(u, { conversationId: YUMA, timeoutMs: 20_000, allowRead: true });
      console.log(`${u.slice(-24)} #${i + 1} ${r.source} ${r.ms}ms`, r.read ? JSON.stringify(r.read) : "null");
      if (r.read) console.log("  →", planReadLines(r.read).join(" ／ "));
    }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { if (h) await h.finish(); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
