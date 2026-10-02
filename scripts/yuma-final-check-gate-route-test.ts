// scripts/yuma-final-check-gate-route-test.ts — generate-reply の本物の経路で、最終チェックの要否の記録（影の運用）が載るか（YUMA）
//
// 2026-10-02 竹内「ファイナルチェックが必要かどうかの監査」: 開発サーバ（.next の鍵）が他の担当に使われていて立てられない時の代わり。
//   route.ts の POST をこのプロセスで直接呼ぶ（包み＝DeepSeek・記録はテストの入口 setupLlmTest が入れる）。書かない呼び方（shadowNoWrite）。
//   確かめる事: ①トレーラーの FINAL_CHECK に gate と tpo_debug.finalCheckGate が載る ②影の運用なので passes_completed は今までどおり3
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-final-check-gate-route-test.ts
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const MSG_SEP = "\n⁣\n";
let h: LlmTestHarness | null = null;
const made: string[] = [];

async function main() {
  h = await setupLlmTest("yuma-final-check-gate-route-test");
  h.assertYuma(YUMA);
  await h.waitUntilYumaQuiet([]);
  const scenes: Array<{ label: string; staff: string; customer: string }> = [
    { label: "A お礼だけ（skip 候補）", staff: "YUMAさんお世話になっております！！\n天王寺周辺からオススメのお部屋ピックアップさせて頂きました！！\nお手隙の際にご査収ください😌！！", customer: "ありがとうございます！確認してみます！" },
    { label: "B 質問（full）", staff: "YUMAさんお世話になっております！！\n天王寺周辺からオススメのお部屋ピックアップさせて頂きました！！\nお手隙の際にご査収ください😌！！", customer: "こちら2年ごとに更新料かかりますか？" },
  ];
  const { POST } = await import("../app/api/generate-reply/route"); // 包みの後に読む
  let ng = 0;
  for (const sc of scenes) {
    h.assertSceneSafe([sc.staff, sc.customer], sc.label);
    const times = h.sceneTimes(2);
    const ins = await sb.from("messages").insert([
      { conversation_id: YUMA, sender: "staff", text: sc.staff, created_at: times[0] },
      { conversation_id: YUMA, sender: "customer", text: sc.customer, created_at: times[1] },
    ]).select("id");
    if (ins.error) throw new Error(ins.error.message);
    const ids = ((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id);
    made.push(...ids);
    try {
      const meta = { action: null, reply_mode: "reply", enforcement_level: "recommended", reply_direction: "お礼に短く受けて、ご確認をお待ちする", key_topics: [], avoid_topics: [], analyzed_msg_ts: times[1] };
      const body = {
        message: sc.customer, customerMessages: [sc.customer], state: "proposing", conversationId: YUMA, customerName: "YUMA",
        hasViewed: false, activeTaskTypes: [], hasStaffReplied: true,
        recentMessages: [
          { sender: "staff", text: sc.staff, createdAt: times[0], isAix: false },
          { sender: "customer", text: sc.customer, createdAt: times[1], isAix: false },
        ],
        brainMetaDirect: { meta, customerName: "YUMA", conversationDirection: null, brainAnalyzedAt: new Date().toISOString() },
        shadowNoWrite: true,
      };
      const res = await POST(new Request("http://localhost/api/generate-reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never);
      const raw = await (res as Response).text();
      const m = raw.match(/<<<FINAL_CHECK:([\s\S]*?)>>>/);
      const fc = m ? JSON.parse(m[1]) as Record<string, any> : null; // eslint-disable-line @typescript-eslint/no-explicit-any
      const text = raw.slice(raw.indexOf("\n") + 1).replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
      const gate = fc?.tpo_debug?.finalCheckGate;
      const ok = !!fc && !!gate && gate.mode === "shadow" && gate.applied === false && (fc.passes_completed ?? []).length === 3;
      if (!ok) ng++;
      console.log(`\n${ok ? "✅" : "❌"} ${sc.label}: 判定 run=${gate?.run} reasons=${(gate?.reasons ?? []).join(",")} mode=${gate?.mode} applied=${gate?.applied} ／ passes=${(fc?.passes_completed ?? []).length} ／ gate(直下)=${fc?.gate ? "あり" : "なし（作り直しで置き換わった）"}`);
      console.log(`   案: ${text.replace(/\n/g, " ／ ").slice(0, 200)}`);
      console.log(`   修正前: ${(fc?.pre_revision_issues ?? []).join(",") || "なし"} ／ 指摘: ${(fc?.issues ?? []).map((i: { code: string; severity: string }) => `${i.code}:${i.severity}`).join(",") || "なし"}`);
    } finally {
      await sb.from("messages").delete().in("id", ids);
    }
  }
  console.log(`\n結果: ${scenes.length - ng}/${scenes.length}`);
  if (ng) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    if (made.length) { await sb.from("messages").delete().in("id", made); console.log(`後片付け: 場面の通 ${made.length}件を id で削除`); }
    if (h) await h.finish();
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  });
