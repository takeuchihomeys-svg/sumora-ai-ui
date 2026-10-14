// scripts/yuma-staff-capture-test.ts — スタッフしか知らない事がブレインの判断に使われるか（DeepSeek・前後各1回）
//   2026-10-14 取りこぼしの無い設計（設計知見 37af1885・app/lib/staff-capture.ts）
//
// 場面A 物件確認した → 物件カードの「別の部屋」: お客様「〇〇302号室空いてますか？」→ AIX（302 募集終了・同じ建物の 502 募集中）
//        → お客様「そちら見に行けますか？」。ブレインの今の物件（current_property / current_properties）が 502 か（前＝STAFF_CAPTURE_ALTERNATIVE=off）
// 場面B 電話の結果: 電話をかけるボタン → お客様「先ほどはありがとうございました！いつ見に行けますか？」。電話で決まった事（お客様のメモ kind=call・
//        画面の保存と同じ形）を知っていれば「18日14時に決まった」を踏まえる（前＝STAFF_CAPTURE_CALL=off）。メモは DB に書かない（メモの差し替え＝テスト用の口）
// 書き込み: テスト専用の会話（YUMA4・LINE なし）に messages と aix_usage_logs を入れ、終わったら（失敗しても）消す。判断は保存しない（analyzeConversation だけ）
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-staff-capture-test.ts
import { createClient } from "@supabase/supabase-js";
import { setupLlmTest, type LlmTestHarness } from "./lib/llm-test-harness";
import { NO_LINE_TEST_CONVERSATIONS } from "../app/lib/test-conversations";
import { composeCallReport } from "../app/lib/staff-capture";
import { applyMemoOps, EMPTY_MEMO, type StoredMemo } from "../app/lib/customer-memo";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const CONV = NO_LINE_TEST_CONVERSATIONS.find((c) => c.name === "YUMA4")!.id;
let h: LlmTestHarness | null = null;
const msgIds: string[] = [];
const aixIds: string[] = [];

async function cleanup() {
  if (msgIds.length) await sb.from("messages").delete().in("id", msgIds);
  if (aixIds.length) await sb.from("aix_usage_logs").delete().in("id", aixIds);
  console.log(`  消した: messages ${msgIds.length}・aix_usage_logs ${aixIds.length}`);
  msgIds.length = 0; aixIds.length = 0;
}

async function insertMsgs(rows: Array<{ sender: string; text: string; at: string; aix?: boolean }>) {
  const ins = await sb.from("messages").insert(rows.map((m) => ({ conversation_id: CONV, sender: m.sender, text: m.text, created_at: m.at, is_aix_generated: !!m.aix }))).select("id");
  if (ins.error) throw new Error(ins.error.message);
  msgIds.push(...((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id));
}

async function brainOnce(label: string) {
  const { analyzeConversation } = await import("../app/lib/brain-core");
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  const meta = await runInDeepseekScope(async () => {
    setDeepseekScope({ conversationId: CONV, mark: { kind: "all" } });
    return analyzeConversation(CONV, true, "proposing", null, "brain", { autoSendEnabled: false, customerName: "YUMA", mode: "full", layer: "combined" });
  });
  const m = (meta ?? {}) as Record<string, unknown>;
  console.log(`  [${label}] ${JSON.stringify({ action: m.action ?? null, current_property: m.current_property ?? null, llm_cp: (m.llm_raw as { cp?: unknown } | undefined)?.cp ?? null, current_properties: m.current_properties ?? null, staff_note: String(m.staff_note ?? "").slice(0, 120), direction: String(m.reply_direction ?? "").slice(0, 200) })}`);
  return m;
}

async function main() {
  h = await setupLlmTest("yuma-staff-capture-test");
  h.assertTestConversation(CONV);
  await h.waitUntilYumaQuiet([], { conversationId: CONV });

  const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").split("=")[1] ?? "";
  // ── 場面A ──
  if (only !== "B") {
  console.log("\n=== 場面A 物件確認した → 別の部屋 ===");
  const ta = h.sceneTimes(3, { offsetMin: 3, stepSec: 60 });
  await insertMsgs([
    { sender: "customer", text: "プレサンス松屋町駅前デュオの302号室って空いてますか？", at: ta[0] },
    { sender: "staff", text: "YUMAさん\nお世話になっております！！\n\nプレサンス松屋町駅前デュオ302号室ですが確認しましたところ募集終了しておりましたが、同じ建物の別のお部屋で現在募集中のお部屋御座いましたので資料お送りさせて頂きました！！\nお手隙の際にご確認ください😌！！", at: ta[1], aix: true },
    { sender: "customer", text: "ありがとうございます！そちら見に行けますか？", at: ta[2] },
  ]);
  const ai = await sb.from("aix_usage_logs").insert({
    conversation_id: CONV, aix_type: "property_check_result", check_pattern: "available", sent_at: ta[1], created_at: ta[1],
    property_names: ["プレサンス松屋町駅前デュオ 302号室", "プレサンス松屋町駅前デュオ 502号室"], prop_statuses: ["unavailable", "alternative"],
    generated_text: "プレサンス松屋町駅前デュオ302号室ですが確認しましたところ募集終了…別のお部屋で現在募集中",
  }).select("id");
  if (ai.error) throw new Error(ai.error.message);
  aixIds.push(...((ai.data ?? []) as Array<{ id: string }>).map((r) => r.id));
  process.env.STAFF_CAPTURE_ALTERNATIVE = "off";
  await brainOnce("前 STAFF_CAPTURE_ALTERNATIVE=off");
  delete process.env.STAFF_CAPTURE_ALTERNATIVE;
  await brainOnce("後");
  await cleanup();
  }

  // ── 場面B ──
  if (only === "A") return;
  console.log("\n=== 場面B 電話の結果 ===");
  const tb = h.sceneTimes(2, { offsetMin: 3, stepSec: 60 });
  await insertMsgs([
    { sender: "staff", text: "[通話リクエスト] 電話をかけるボタン", at: tb[0], aix: true },
    { sender: "customer", text: "先ほどはお電話ありがとうございました！当日はどこに行けばいいですか？", at: tb[1] },
  ]);
  const report = composeCallReport(["内覧の日程が決まった"], "10/18(土) 14時 ルミエール天満橋 805号室 内覧\n車で来るので駐車場の空きを気にしている\n契約者はお父様");
  const memo: StoredMemo = applyMemoOps(EMPTY_MEMO, [{ op: "add", kind: "call", text: report, at: tb[0], by: "staff", certainty: "sure", ttlDays: null }],
    { origin: "staff", nowIso: tb[0], newId: () => "call-test" }).memo;
  (globalThis as { __customerMemoOverride?: Map<string, StoredMemo> }).__customerMemoOverride = new Map([[CONV, memo]]);
  process.env.STAFF_CAPTURE_CALL = "off";
  await brainOnce("前 STAFF_CAPTURE_CALL=off");
  delete process.env.STAFF_CAPTURE_CALL;
  await brainOnce("後");
  await cleanup();
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(async () => { await cleanup().catch(() => {}); if (h) await h.finish().catch((e) => console.warn("finish:", String(e))); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
