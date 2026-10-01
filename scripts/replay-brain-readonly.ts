// scripts/replay-brain-readonly.ts
// ブレインの「今」の判断を、判断を保存せずに取り直す（AIX要対応・カレンダー・判断ログは作らない）。
//
// 2026-10-01 竹内「1～4すべて改善する」（③ テストは YUMA だけ）: 旧版は本番の会話 ID をそのまま渡して analyzeConversation を呼び、
//   10/01 に和樹さんの会話（fecda03f）で LLM を3回呼んでいた（ブレインの行は記録も無く、Jev の行だけ残った）。テストの材料にお客様の会話を
//   そのまま LLM に渡さない。→ 2つの形だけにした（手順書 memory/test_protocol_brain.md）:
//     ① YUMA の今の判断を取り直す:   <起動の印> npx tsx --env-file=.env.local scripts/replay-brain-readonly.ts [回数]
//     ② お客様の会話を YUMA に写して試す（読むだけ・伏せ字・申込の書類より前まで）:
//        <起動の印> npx tsx --env-file=.env.local scripts/replay-brain-readonly.ts --copy-to-yuma=<conversation_id> [--last=12] [回数]
//        元の会話は読むだけ（書かない）。申込以降の状態の会話は写さない。最初の申込の書類・本人確認書類・収入の書類・個人の値の手前で切る
//        （test-pii-guard・10/01 再生の場面に記入済みの申込フォームが混ざった事故）。お客様の名前は「YUMA」、他の名前・番号は maskPII で伏せる。
//        写した通は YUMA の未来の時刻に置き、終わったら（失敗しても）消す。
//   <起動の印> は LLM_TEST_MODE=deepseek-all（試行錯誤）か LLM_TEST_FINAL_CLAUDE=1（最後の確かめ）。どちらも無ければ止まる。
//   書かないための約束: analyzeConversation だけを呼ぶ（保存は analyzeAndSaveBrainMeta の仕事）・property_customer_id を渡さない
//   （渡すと全項目の層でお客様の要約を property_customers に書く）。llm_usage_logs には使用量の記録だけが残る（route=script:replay-brain-readonly）
import { createClient } from "@supabase/supabase-js";
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
let h: LlmTestHarness | null = null;
let cleanup: string[] = [];

async function copyToYuma(source: string, last: number): Promise<number> {
  const { DRAFT_SKIP_STATUSES } = await import("../app/lib/conversation-status");
  const { maskPII } = await import("../app/lib/pii-mask");
  const { loadKnownCustomerNames, loadPartyAliases } = await import("../app/lib/pii-known-names");
  const { data: conv } = await sb.from("conversations").select("status, customer_name").eq("id", source).maybeSingle();
  if (!conv) throw new Error(`会話 ${source} が見つかりません`);
  if (DRAFT_SKIP_STATUSES.has(String(conv.status ?? ""))) throw new Error(`会話 ${source} は申込以降（${conv.status}）なので写しません（個人情報が集中・テストの対象外）`);
  const { data: msgs } = await sb.from("messages").select("sender, text, is_aix_generated, created_at").eq("conversation_id", source).order("created_at", { ascending: false }).limit(last);
  const ordered = ((msgs ?? []) as Array<{ sender: string; text: string | null; is_aix_generated: boolean | null }>).reverse();
  // 申込の書類・本人確認書類・収入の書類・個人の値の手前で切る（書類より後の流れは使わない）
  const cut = h!.cutBeforeApplicationMaterial(ordered);
  if (cut.cutAt != null) console.warn(`  ✂ ${cut.cutAt + 1}通目に ${cut.reason} → その手前の ${cut.kept.length}通だけ写します`);
  if (cut.kept.length === 0) throw new Error("写せる通がありません（最初の通から書類・個人の値）");
  const names = [String(conv.customer_name ?? ""), ...(await loadPartyAliases(source).catch(() => [] as string[]))].map((s) => s.trim()).filter((s) => s.length >= 2);
  const known = (await loadKnownCustomerNames().catch(() => [] as string[])).filter((s) => (s ?? "").trim().length >= 3);
  const anon = (t: string) => {
    let s = t;
    for (const n of names) s = s.split(n).join("YUMA");
    return maskPII(s, known);
  };
  const texts = cut.kept.map((m) => anon(String(m.text ?? "")));
  h!.assertSceneSafe(texts, `copy:${source.slice(0, 8)}`);
  const times = h!.sceneTimes(texts.length, { offsetMin: 3, stepSec: 30 });
  const rows = cut.kept.map((m, i) => ({ conversation_id: YUMA, sender: m.sender === "customer" ? "customer" : "staff", text: texts[i], is_aix_generated: !!m.is_aix_generated, created_at: times[i] }));
  const ins = await sb.from("messages").insert(rows).select("id");
  if (ins.error) throw new Error(`YUMA に写せず: ${ins.error.message}`);
  cleanup = ((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id);
  console.log(`  YUMA に ${rows.length}通を写しました（元 ${source.slice(0, 8)}・伏せ字・${times[0]}〜）`);
  return rows.length;
}

async function main() {
  h = await setupLlmTest("replay-brain-readonly");
  const { analyzeConversation } = await import("../app/lib/brain-core");
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  const pos = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (pos[0] && /^[0-9a-f-]{36}$/.test(pos[0]) && pos[0] !== YUMA) {
    throw new Error(`お客様の会話（${pos[0]}）を直接は流しません。--copy-to-yuma=${pos[0]} で伏せ字にして YUMA に写してから（手順書 memory/test_protocol_brain.md）`);
  }
  const times = Math.max(1, Math.min(6, Number(pos.find((a) => /^\d+$/.test(a)) ?? 1)));
  const source = arg("copy-to-yuma");
  if (source) {
    await h.waitUntilYumaQuiet([]);
    await copyToYuma(source, Math.max(2, Math.min(40, Number(arg("last") ?? 12))));
  }
  h.assertYuma(YUMA);
  const { data: c } = await sb.from("conversations").select("status, brain_strategy, conversation_direction").eq("id", YUMA).maybeSingle();
  const cc = (c ?? {}) as Record<string, unknown>;
  const strategy = (cc.brain_strategy ?? null) as never;
  const prevDir = (cc.conversation_direction ?? null) as Record<string, unknown> | null;
  console.log(`YUMA status=${String(cc.status ?? "-")} layer=${strategy ? "fresh" : "combined"} 回数=${times}${source ? `（写し元 ${source.slice(0, 8)}）` : ""}`);
  for (let i = 0; i < times; i++) {
    if (cleanup.length) {
      const foreign = await h.foreignYumaRows(cleanup);
      if (foreign.length) console.warn(`  ⚠ YUMA に他の実行の行 ${foreign.length}件（混ざっている・この回の判断は参考に留める）`);
    }
    const meta = await runInDeepseekScope(async () => {
      // YUMA は竹内さん本人のテスト用の会話＝時刻の線は全部（kind=all）
      setDeepseekScope({ conversationId: YUMA, mark: { kind: "all" } });
      return analyzeConversation(YUMA, true, (cc.status as string) ?? "proposing", null, "brain", {
        autoSendEnabled: false, customerName: "YUMA",
        prevPhase: typeof prevDir?.current_phase === "string" ? prevDir.current_phase : null,
        prevAix: source ? null : (typeof prevDir?.suggested_aix_button === "string" ? prevDir.suggested_aix_button : null),
        mode: strategy ? "incremental" : "full", layer: strategy ? "fresh" : "combined", strategy: strategy ?? null,
      });
    });
    const m = (meta ?? {}) as Record<string, unknown>;
    console.log(JSON.stringify({ run: i + 1, action: m.action ?? null, decision_source: m.decision_source ?? null, check_pattern: m.check_pattern ?? null, reply_mode: m.reply_mode ?? null, scene: (m.scene_evidence as Record<string, unknown> | undefined)?.scene ?? null, direction: String(m.reply_direction ?? "").slice(0, 120) }));
  }
}

async function removeCopied() {
  if (!cleanup.length) return;
  await sb.from("messages").delete().in("id", cleanup);
  console.log(`  YUMA に写した ${cleanup.length}通を消しました`);
  cleanup = [];
}
main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(async () => { await removeCopied(); if (h) await h.finish().catch((e) => console.warn("finish:", String(e))); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
