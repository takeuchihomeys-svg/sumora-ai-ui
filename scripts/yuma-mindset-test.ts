// scripts/yuma-mindset-test.ts — お客様の状態（mindset 12種＋不安の向き・迷いの中身・決め手の残り）を YUMA で確かめる（2026-10-09）
//   手順書 memory/test_protocol_brain.md どおり: YUMA だけ・共通の入口・未来の時刻・自分の行だけ消す・同時1本（waitUntilYumaQuiet）。
//   お客様の言葉は実物（scripts/audit-customer-mindset.ts で読んだ竹内さんの番・名前と物件名は伏せた／物件は架空）。
//   見る物: ブレインの mindset（state・anxiety・hesitation・decide_gap）・customer_emotion・action・check_pattern・注記【決め手の残り】が渡ったか
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-mindset-test.ts [回数=2] [場面id,...]
//       最後の確かめ: LLM_TEST_FINAL_CLAUDE=1 … [回数=1]
import { createClient } from "@supabase/supabase-js";
import { setupLlmTest, type LlmTestHarness } from "./lib/llm-test-harness";

let h: LlmTestHarness | null = null;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
let cleanup: string[] = [];

type Turn = { s: "staff" | "customer"; t: string; aix?: boolean };
type Scene = { id: string; note: string; turns: Turn[]; wantState: string[]; wantAix?: string[]; wantGap?: string; wantAnxDir?: "前向き" | "後ろ向き"; wantHes?: string };

const CARD_A = "🌟サンプルレジデンス南森町 503号室\n\nYUMAさんにかなりオススメ出来るお部屋となります！！\n\n家賃68,000円・管理費7,000円（合計75,000円）の1LDKで、谷町線「南森町」徒歩5分と好立地です！！\n敷地内駐車場あり（月額15,000円）\n\nお手隙の際にご査収ください😌！！";
const CARD_B = "🌟サンプルコート天満 802号室\n\n2023年築で築年数浅く、家賃72,000円（管理費込み）の1LDKとなります！！\n天満駅徒歩4分です！！\n\nお手隙の際にご査収ください😌！！";
const SCENES: Scene[] = [
  { id: "parking_cond", note: "条件つきの決める（実物「空いてましたら契約進みたく」の形）", turns: [{ s: "staff", t: CARD_A, aix: true }, { s: "customer", t: "ここ気になります！\n駐車場って空いてますか？空いてたら決めたいです" }],
    wantState: ["刺さっている", "抑えたい", "普通の依頼"], wantAix: ["acknowledge_check", "property_check_result"], wantGap: "駐車場・駐輪場:a" },
  { id: "multi_hes", note: "複数物件で迷う（竹内さんの決定: 1件を推す・抑える提案）", turns: [{ s: "staff", t: CARD_A, aix: true }, { s: "staff", t: CARD_B, aix: true }, { s: "customer", t: "どちらも良さそうで、どっちにするか迷ってます…" }],
    wantState: ["迷い"], wantHes: "複数物件で迷う" },
  { id: "screening", note: "審査の不安（実物「審査がとおるかが不安です…過去に色々ありまして」）＝前向きな不安", turns: [{ s: "staff", t: CARD_A, aix: true }, { s: "customer", t: "ここいいなと思ってるんですが、審査がとおるかが不安です…\n過去に支払いが遅れたことがありまして" }],
    wantState: ["審査の不安"], wantAnxDir: "前向き" },
  { id: "take_first", note: "内覧が先になる＋埋まるか不安（実物「都合つくのが9月13日以降…埋まる可能性高いですかね」）", turns: [{ s: "staff", t: CARD_A, aix: true }, { s: "customer", t: "ありがとうございます！\n内覧したいんですが都合つくのが来週の土曜以降で、今見てる物件埋まる可能性高いですかね" }],
    wantState: ["先に取られる不安", "時間が無い"], wantAnxDir: "前向き" },
  { id: "estimate_ask", note: "見積の依頼（実物「初期費用はいくら位になりますかね」）", turns: [{ s: "staff", t: CARD_A, aix: true }, { s: "customer", t: "初期費用はいくら位になりますかね" }],
    wantState: ["安くしたい", "普通の依頼", "刺さっている"], wantAix: ["estimate_sheet"], wantGap: "初期費用:b" },
  { id: "hold", note: "保留（実物「検討させていただきます！」）", turns: [{ s: "staff", t: CARD_A, aix: true }, { s: "customer", t: "ありがとうございます。\n検討させていただきます！" }],
    wantState: ["迷い"], wantAix: ["(なし)"] },
];

async function insertScene(sc: Scene) {
  h!.assertSceneSafe(sc.turns.map((t) => t.t), sc.id);
  const times = h!.sceneTimes(sc.turns.length);
  const ins = await sb.from("messages").insert(sc.turns.map((t, i) => ({ conversation_id: YUMA, sender: t.s, text: t.t, is_aix_generated: !!t.aix, created_at: times[i] }))).select("id");
  if (ins.error) throw new Error(`場面を作れず: ${ins.error.message}`);
  cleanup.push(...((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id));
}
async function removeScene() { if (!cleanup.length) return; await sb.from("messages").delete().in("id", cleanup); cleanup = []; }

async function main() {
  h = await setupLlmTest("yuma-mindset-test");
  const { analyzeConversation } = await import("../app/lib/brain-core");
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  const pos = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const reps = Math.max(1, Math.min(6, Number(pos[0] ?? 2)));
  const only = (pos[1] ?? "").split(",").filter(Boolean);
  const { data: c } = await sb.from("conversations").select("status, brain_strategy, conversation_direction").eq("id", YUMA).maybeSingle();
  const cc = (c ?? {}) as Record<string, unknown>;
  const strategy = (cc.brain_strategy ?? null) as never;
  const prevDir = (cc.conversation_direction ?? null) as Record<string, unknown> | null;
  const summary: string[] = [];
  for (const sc of SCENES.filter((s) => !only.length || only.includes(s.id))) {
    let okState = 0, okAix = 0, okGap = 0, okAnx = 0, okHes = 0;
    for (let k = 0; k < reps; k++) {
      await h.waitUntilYumaQuiet(cleanup);
      await insertScene(sc);
      try {
        h.assertYuma(YUMA, "brain");
        const meta = await runInDeepseekScope(async () => {
          setDeepseekScope({ conversationId: YUMA, mark: { kind: "all" } });
          return analyzeConversation(YUMA, true, (cc.status as string) ?? "proposing", null, "brain", {
            autoSendEnabled: false, customerName: "YUMA",
            prevPhase: typeof prevDir?.current_phase === "string" ? prevDir.current_phase : null, prevAix: null,
            mode: strategy ? "incremental" : "full", layer: strategy ? "fresh" : "combined", strategy: strategy ?? null,
          });
        });
        const m = (meta ?? {}) as Record<string, unknown>;
        const ms = (m.customer_mindset ?? null) as { state?: string; anxiety?: { target: string; direction: string } | null; hesitation?: string | null; decideGap?: { point: string; solve: string; property: string | null; quote: string } | null } | null;
        const a = (m.action as string) || "(なし)";
        const gap = ms?.decideGap ? `${ms.decideGap.point}:${ms.decideGap.solve}` : null;
        const okS = !!ms?.state && sc.wantState.includes(ms.state); if (okS) okState++;
        const okA = !sc.wantAix || sc.wantAix.includes(a); if (okA) okAix++;
        const okG = !sc.wantGap || gap === sc.wantGap; if (okG) okGap++;
        const okX = !sc.wantAnxDir || ms?.anxiety?.direction === sc.wantAnxDir; if (okX) okAnx++;
        const okH = !sc.wantHes || ms?.hesitation === sc.wantHes; if (okH) okHes++;
        console.log(`【${sc.id}】[${k + 1}] 状態=${ms?.state ?? "（無し）"}${okS ? "✓" : "✗"} 不安=${ms?.anxiety ? `${ms.anxiety.target}:${ms.anxiety.direction}` : "-"}${okX ? "" : "✗"} 迷い=${ms?.hesitation ?? "-"}${okH ? "" : "✗"} 残り=${gap ?? "-"}${okG ? "" : "✗"}（${ms?.decideGap?.property ?? ""}「${ms?.decideGap?.quote ?? ""}」）気持ち=${String(m.customer_emotion ?? "-")} AIX=${a}${m.check_pattern ? `/${m.check_pattern}` : ""}${okA ? "✓" : "✗"}\n   方向「${String(m.reply_direction ?? "").replace(/\n/g, " ").slice(0, 110)}」 提案=${JSON.stringify((m.turn_contract as { proposals?: unknown } | undefined)?.proposals ?? null)}`);
      } catch (e) { console.warn(`【${sc.id}】[${k + 1}] 失敗:`, e instanceof Error ? e.message : String(e)); }
      finally { await removeScene(); }
    }
    summary.push(`${sc.id}: 状態 ${okState}/${reps}・AIX ${okAix}/${reps}・残り ${okGap}/${reps}・不安の向き ${okAnx}/${reps}・迷い ${okHes}/${reps}  ※${sc.note}`);
  }
  console.log("\n=== まとめ ===");
  for (const s of summary) console.log(s);
}
main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await removeScene(); if (h) await h.finish().catch((e) => console.warn("finish:", String(e))); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
