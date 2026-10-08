// scripts/yuma-r9-aix-negotiation.ts — 9巡目（10/08）: AIX【物件確認した→管理会社に確認した（初期費用・交渉）】の交渉が難しかった時の締めを前後で見る。
//   旧（NEGOTIATION_CLOSE_R9=off）＝「引き続き最大限サポートさせて頂きます！！で締める」／新＝結果と理由だけ・「お手隙の際にご確認ください！！」か締めなし。
//   人の実送信（交渉の結果の報告で難しかった 16通・うち AIX 4）は「引き続き最大限サポート」0通・「お手隙の際にご確認」4通。
//   aix/action の POST を同じプロセスで呼ぶ（開発サーバを立てない）。after()（記録の書き込み）は呼ばれても何もしない箱で包む＝YUMA に記録を残さない。
//   手順書 memory/test_protocol_brain.md どおり（YUMA だけ・共通の入口・DeepSeek で試行錯誤・最後の Claude は1〜2回）。
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-r9-aix-negotiation.ts [回数=1] [--versions=old,new] [--rules-r9=off|on]
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").slice(k.length + 3) || d;
const VERSIONS = arg("versions", "old,new").split(",");
const RULES_R9 = arg("rules-r9", "off");
const REPS = Math.max(1, Number(process.argv.slice(2).filter((a) => !a.startsWith("--"))[0] ?? 1));
const CASES = [
  { id: "reikin_ng", input: "礼金 減額不可\n理由: 最近募集に出たお部屋のため", customer: "礼金ってもう少し下げられたりしますか？" },
  { id: "cleaning_ng", input: "ハウスクリーニング代 初期費用から外すのは不可（必須）", customer: "クリーニング代って外せたりしますか？" },
  { id: "reikin_ok", input: "礼金1ヶ月→0ヶ月 交渉成功", customer: "礼金ってもう少し下げられたりしますか？" },
];
const PROP = "🌟アバンティオアネーロ 202号室\n\n1件新着でYUMAさんにかなりオススメ出来るお部屋が募集に出ました！！\n\nお手隙の際にご査収ください😌！！";
let h: LlmTestHarness | null = null;

async function main() {
  h = await setupLlmTest("yuma-r9-aix-negotiation");
  h.assertYuma(YUMA);
  // Next の箱は globalThis.AsyncLocalStorage を使う（next の実行環境の外＝tsx では自分で置く）
  (globalThis as unknown as Record<string, unknown>).AsyncLocalStorage ??= (await import("node:async_hooks")).AsyncLocalStorage;
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external");
  const { POST } = await import("../app/api/aix/action/route");
  const out: string[] = [];
  for (const c of CASES) for (let k = 0; k < REPS; k++) for (const v of VERSIONS) {
    if (v === "old") process.env.NEGOTIATION_CLOSE_R9 = "off"; else delete process.env.NEGOTIATION_CLOSE_R9;
    h.assertSceneSafe([c.customer, c.input], c.id);
    const now = Date.now();
    const body = {
      action: "property_check_result", check_pattern: "mgmt_initial_cost", mgmt_cost_type: "negotiation", extra_input: c.input,
      conversation_id: YUMA, customer_name: "YUMA", property_name: "アバンティオアネーロ 202号室",
      recent_messages: [
        { sender: "staff", text: PROP, createdAt: new Date(now - 7200_000).toISOString() },
        { sender: "customer", text: c.customer, createdAt: new Date(now - 3600_000).toISOString() },
      ],
      testFlags: { rules_r9: RULES_R9 },
    };
    const store = { afterContext: { after: () => {} }, route: "/api/aix/action", isStaticGeneration: false } as never;
    let text = "";
    try {
      const res = await workAsyncStorage.run(store, () => POST(new Request("http://localhost/api/aix/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never)) as Response;
      const j = await res.json().catch(() => ({})) as Record<string, unknown>;
      text = String(j.message ?? j.message_text ?? j.error ?? JSON.stringify(j).slice(0, 200));
    } catch (e) { text = `失敗: ${e instanceof Error ? e.message : String(e)}`; }
    const line = `[${c.id} ${v} ${k + 1}] ${text.replace(/\n+/g, "／")}`;
    console.log(line); out.push(line);
  }
  console.log("\n=== まとめ ===\n" + out.join("\n"));
}
main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { delete process.env.NEGOTIATION_CLOSE_R9; if (h) await h.finish(); setTimeout(() => process.exit(process.exitCode ?? 0), 800); });
