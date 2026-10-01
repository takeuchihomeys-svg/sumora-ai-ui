// YUMA で「ブレインの AIX 判断」と「材料を渡した Jev（影）の答え」を並べて見る（手元のコード＝この作業ツリーのブレインで回す）
//
// 2026-09-29 竹内「材料は渡す・答えは渡さない」（memory feedback_jev_brain_materials）。
//   お客様役の発言を YUMA に1通ずつ入れ → analyzeConversation（本番と同じ関数・YUMA の物件顧客つき）→ 影が jev_shadow_logs に書いた行を読む。
//   JEV_SHADOW_AIX_FULL=1 をこのプロセスだけで立てて「全ボタンから1つ」も聞く（本番の既定はピッカーだけ）。
//   ブレインは Claude（判断が揺れないように DeepSeek にしない＝テストの3段の②）。本文の生成はしない（AIX 要対応の通知・下書きは作らない）。
//   ⚠ 書き込み: YUMA に場面の発言を入れ、場面ごとに消す。jev_shadow_logs の YUMA の行は残す（audit-jev-shadow は YUMA を除く）。
//   YUMA は戦略（brain_strategy）ありなので今回の発言の層＝お客様の要約は書き換えない。
// 実行: npx tsx --env-file=.env.local scripts/yuma-jev-materials-test.ts [場面の番号をカンマで]
process.env.JEV_SHADOW_AIX_FULL = "1";
import { createClient } from "@supabase/supabase-js";
// 2026-10-01 ブレインは共通の入口（scripts/lib/llm-test-harness.ts）の後に読む（静的 import だと包む前の fetch を握り Claude が記録0）。
//   起動の印: LLM_TEST_MODE=deepseek-all か LLM_TEST_FINAL_CLAUDE=1（手順書 memory/test_protocol_brain.md）
import { setupLlmTest, type LlmTestHarness } from "./lib/llm-test-harness";
let h: LlmTestHarness | null = null;
import { buildAixJevMaterials } from "../app/lib/aix-jev-materials";
import { loadCustomerStateInput } from "../app/lib/customer-state-server";
import { resolveCustomerState } from "../app/lib/customer-state";
import { buildActionLedger } from "../app/lib/action-ledger";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const PC = "509cd061-60cc-49a9-8c5a-4f356c4a5f88";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Scene = { id: string; staff?: string; customer: string; expect: string };
const SCENES: Scene[] = [
  { id: "①内覧したい", staff: "YUMAさんにオススメのお部屋2件お送りさせて頂きました！！", customer: "2件目のお部屋、内覧したいです！", expect: "内覧日調整（viewing_invite）" },
  { id: "②初期費用知りたい", staff: "YUMAさんにオススメのお部屋2件お送りさせて頂きました！！", customer: "1件目のお部屋の初期費用知りたいです", expect: "見積書送る（estimate_sheet）" },
  { id: "③家賃を上げて", customer: "家賃10万まで上げてもいいので、他のお部屋も見たいです", expect: "物件ピックアップした＋条件を広げた（材料: 登録の上限 9万）" },
  { id: "④条件の言い直し", customer: "やっぱりエリアは福島区だけで探してほしいです", expect: "物件ピックアップした（材料: 切り替えの語）" },
  { id: "⑤今回だけ", customer: "今回だけ1階のお部屋も見てみたいです", expect: "物件ピックアップした（材料: 今回だけの語）" },
  { id: "⑥室内写真", staff: "YUMAさんにオススメのお部屋2件お送りさせて頂きました！！", customer: "1件目のお部屋の室内の写真ありますか？", expect: "物件確認した→室内写真（interior_photo）" },
  { id: "⑦入居日", staff: "YUMAさんにオススメのお部屋2件お送りさせて頂きました！！", customer: "2件目のお部屋いつから入居できますか？", expect: "物件確認した→入居可能日（mgmt_move_in）" },
  { id: "⑧内覧の日時を決めた", staff: "内覧のご案内可能なお日にちお送りさせて頂きます！！ご都合いかがでしょうか！！", customer: "土曜の14時でお願いします！", expect: "待ち合わせ（meeting_place）か内覧日調整" },
];

async function materialsNow() {
  const input = await loadCustomerStateInput(Y);
  if (!input) return null;
  const state = resolveCustomerState({ ...input, brainPhase: null, brainSituation: null });
  const msgs = input.messages.slice(-15);
  const lastStaffIdx = input.messages.map((m) => m.sender).lastIndexOf("staff");
  const unreplied = input.messages.slice(lastStaffIdx + 1).filter((m) => m.sender === "customer").map((m) => m.text ?? "").join("\n");
  const ledger = buildActionLedger({
    recentAixRows: [...input.aixRows].reverse().slice(0, 30),
    messages: msgs.map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.createdAt, isAix: !!m.isAix })),
    lineTasks: input.lineTasks, lastCustomerAt: [...msgs].reverse().find((m) => m.sender === "customer")?.createdAt ?? null, recordedFacts: input.recordedFacts,
  });
  const { data: pc } = await sb.from("property_customers").select("desired_area, area_mode, floor_plan, rent_min, rent_max, floor_area_min, floor_area_max, walk_minutes, commute_station, commute_minutes, move_in_time, pet, initial_cost_limit, building_age, preferences, ng_points, other_requests, ai_summary_json").eq("id", PC).maybeSingle();
  return buildAixJevMaterials({
    customer: pc as never, state, ledger: ledger.facts, latestCustomerText: unreplied, mask: (s) => s.replace(/YUMA/g, "〇〇"),
    recentAix: [...input.aixRows].reverse().map((r) => ({ aix_type: r.aix_type, check_pattern: r.check_pattern ?? null, created_at: r.created_at ?? "", sent_at: r.sent_at ?? null })),
  });
}

async function main() {
  h = await setupLlmTest("yuma-jev-materials-test");
  const { analyzeConversation } = await import("../app/lib/brain-core");
  const pick =(process.argv[2] ?? "").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
  const scenes = pick.length ? SCENES.filter((_, i) => pick.includes(i + 1)) : SCENES;
  const { data: c } = await sb.from("conversations").select("status, brain_strategy, conversation_direction").eq("id", Y).maybeSingle();
  const cc = (c ?? {}) as Record<string, unknown>;
  const strategy = (cc.brain_strategy ?? null) as never;
  const dir = (cc.conversation_direction ?? null) as Record<string, unknown> | null;
  const status = (cc.status as string) ?? "proposing";
  console.log(`YUMA status=${status} strategy=${!!strategy}`);

  for (const s of scenes) {
    const t0 = new Date().toISOString();
    const now = Date.now();
    const rows = [
      ...(s.staff ? [{ conversation_id: Y, sender: "staff", text: s.staff, created_at: new Date(now - 10 * 60_000).toISOString() }] : []),
      { conversation_id: Y, sender: "customer", text: s.customer, created_at: new Date(now - 60_000).toISOString() },
    ];
    const ins = await sb.from("messages").insert(rows).select("id");
    if (ins.error) { console.log(`【${s.id}】場面を作れず: ${ins.error.message}`); continue; }
    const ids = (ins.data ?? []).map((r) => (r as { id: string }).id);
    try {
      const mat = await materialsNow();
      const meta = await analyzeConversation(Y, true, status, PC, "brain", {
        autoSendEnabled: false, customerName: "YUMA",
        prevPhase: typeof dir?.current_phase === "string" ? dir.current_phase : null,
        prevAix: typeof dir?.suggested_aix_button === "string" ? dir.suggested_aix_button : null,
        mode: strategy ? "incremental" : "full", layer: strategy ? "fresh" : "combined", strategy: strategy ?? null,
      });
      let shadow: Record<string, unknown> | null = null;
      for (let i = 0; i < 15 && !shadow; i++) {
        await sleep(2000);
        const { data } = await sb.from("jev_shadow_logs").select("kind, brain_action, brain_check_pattern, jev_action, jev_action_prob, jev_check_topic, jev_picker_field, jev_picker, jev_picker_value, jev_picker_prob, jev_ms, created_at")
          .eq("conversation_id", Y).gte("created_at", t0).in("kind", ["aix_full", "aix_picker"]).order("created_at", { ascending: false }).limit(1);
        shadow = ((data ?? [])[0] as Record<string, unknown>) ?? null;
      }
      const m = meta as unknown as Record<string, unknown> | null;
      console.log(`\n【${s.id}】客「${s.customer}」 期待: ${s.expect}`);
      console.log(`  ブレイン: action=${m?.action || "(なし)"} check_pattern=${m?.check_pattern ?? "-"} send_mode=${(m as { send_mode?: string } | null)?.send_mode ?? "-"} reply_mode=${m?.reply_mode ?? "-"}`);
      console.log(shadow
        ? `  Jev（影）: kind=${shadow.kind} aix=${shadow.jev_action ?? "-"}(${Number(shadow.jev_action_prob ?? 0).toFixed(2)}) picker=${shadow.jev_picker ?? "-"}→${shadow.jev_picker_value ?? "-"}(${Number(shadow.jev_picker_prob ?? 0).toFixed(2)}) ${shadow.jev_ms}ms`
        : "  Jev（影）: 行が無い");
      console.log(`  材料（同じ部品で組んだ物）: ${JSON.stringify(mat)}`);
    } finally {
      if (ids.length) await sb.from("messages").delete().in("id", ids);
    }
  }
  await h.finish();
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
}
main().catch(async (e) => { console.error(e); if (h) await h.finish().catch(() => {}); process.exit(1); });
