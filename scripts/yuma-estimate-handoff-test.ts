// scripts/yuma-estimate-handoff-test.ts
// YUMA（テスト用の会話・竹内さん本人）に実物の場面を入れて、①ブレインの AIX ②LINE の入口（見積書を作る／同封）
// ③見積書作成に渡るお部屋・資料・AD・割引の目安 ④資料の AI 読み取り（見積書ツールの自動の読み取りと同じ route）を通しで見る。場面は毎回消す。
//
// 2026-10-01 竹内「見積書きかれたら LINE のところに見積書のがでて押したら見積書のツールのところに連携…送った物件がセットされた状態で」
//
// 実行（試行錯誤＝ブレインも DeepSeek・起動コマンドにだけ付ける）:
//   LLM_TEST_MODE=deepseek-all LLM_ALT_ACTIONS=reply_generate,brain_fresh,brain_full npx tsx --env-file=.env.local scripts/yuma-estimate-handoff-test.ts [場面id,...] [--extract]
// 最終の確かめ（本番と同じ＝ブレインは Claude・読み取りは画像つき Sonnet）: 先頭の2つを付けずに
// 書くもの: YUMA の messages（場面の数通）だけ。ブレインは analyzeConversation を直接呼ぶ（判断の保存・AIX要対応・通知は作らない）
import { createClient } from "@supabase/supabase-js";

type Analyze = typeof import("../app/lib/brain-core").analyzeConversation;
import { setupLlmTest, type LlmTestHarness } from "./lib/llm-test-harness";
let h: LlmTestHarness | null = null;
async function loadBrain(): Promise<Analyze> {
  // 2026-10-01 共通の入口（scripts/lib/llm-test-harness.ts・手順書 memory/test_protocol_brain.md）: テストの種類の明示（deepseek-all／LLM_TEST_FINAL_CLAUDE=1）・包みの順・記録の待ち・Claude の歯止め・YUMA だけ
  h = await setupLlmTest("yuma-estimate-handoff-test");
  return (await import("../app/lib/brain-core")).analyzeConversation;
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
let cleanup: string[] = [];

type Turn = { s: "staff" | "customer"; t: string; aix?: boolean; lineId?: string; quote?: string };
type Scene = { id: string; note: string; turns: Turn[]; wantAix: string[]; wantEntry: string | null; wantTarget: RegExp | null };

// YUMA に売上サポで送った実物の行（#2675 プレサンス梅田北ザ・ライブ 305・AD 65,000円・資料の文字あり）を 🌟 で推した形
const REC = "🌟プレサンス梅田北ザ・ライブ 305号室\n\n築浅で梅田へも出やすい、YUMAさんにかなりオススメ出来るお部屋となります！！\n\n家賃65,000円の1Kで、中津駅徒歩7分となります！！";
const SCENES: Scene[] = [
  {
    id: "estimate", note: "c024b7b9 実物「初期費用はいくら位になりますかね」（スタッフ: 見積書送る）",
    turns: [{ s: "staff", t: REC, aix: true }, { s: "customer", t: "初期費用はいくら位になりますかね" }],
    wantAix: ["estimate_sheet"], wantEntry: "estimate", wantTarget: /プレサンス梅田北/,
  },
  {
    id: "quote", note: "fb8ab8d5 実物「こちらの物件は初期費用どのくらいですか？？」（🌟 を引用）",
    turns: [
      { s: "staff", t: REC, aix: true, lineId: "TEST-EST-Q1" },
      { s: "staff", t: "引き続き新着でYUMAさんにオススメ出来るお部屋お送りさせて頂きます！！" },
      { s: "customer", t: "こちらの物件は初期費用どのくらいですか？？", quote: "TEST-EST-Q1" },
    ],
    wantAix: ["estimate_sheet"], wantEntry: "estimate", wantTarget: /プレサンス梅田北/,
  },
  {
    id: "with_property", note: "初期費用を抑えたいお客様が他のお部屋も見たい（物件オススメ＋同封の場面か・強制しない）",
    turns: [
      { s: "staff", t: REC, aix: true },
      { s: "customer", t: "ありがとうございます！初期費用はなるべく抑えたいので、敷金礼金なしで他にもいいお部屋あれば見たいです" },
    ],
    wantAix: ["property_recommendation", "property_send"], wantEntry: null, wantTarget: null,
  },
  // 物件が無い費用の質問（ゆうこ事例）は YUMA では作れない（YUMA には送った物件の記録がある＝物件ありの会話）。純関数のテストで確かめる
];

async function insertScene(sc: Scene) {
  // 2026-10-01: 同じ時間に別の作業（⑦）も YUMA を使う → 30分先の時刻で入れて重ならないようにする（終わったら消す）
  const now = Date.now() + 30 * 60_000;
  const rows = sc.turns.map((t, i) => ({
    conversation_id: YUMA, sender: t.s, text: t.t, is_aix_generated: !!t.aix,
    line_message_id: t.lineId ?? null, quoted_message_id: t.quote ?? null,
    created_at: new Date(now - (sc.turns.length - i) * 4 * 60_000).toISOString(),
  }));
  const ins = await sb.from("messages").insert(rows).select("id");
  if (ins.error) throw new Error(`場面を作れず: ${ins.error.message}`);
  cleanup.push(...((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id));
}
/**
 * 2026-10-01: 同じ時間に別の作業（⑦）が YUMA に場面を入れると、ブレインがその発言を読んで別の判断になる（ヴィレ堺湊・メゾン本庄東の判断が混じった）。
 * 自分の行以外で「今より30分前より新しい」行の数（他の作業の場面）。0 でない回は数えない（汚れた回）
 */
async function foreignRows(): Promise<number> {
  const { data } = await sb.from("messages").select("id").eq("conversation_id", YUMA).gt("created_at", new Date(Date.now() - 30 * 60_000).toISOString());
  return ((data ?? []) as Array<{ id: string }>).filter((r) => !cleanup.includes(r.id)).length;
}
/** 他の作業の場面が無くなるまで待つ（最大 maxMs） */
async function waitYumaIdle(maxMs: number): Promise<boolean> {
  const t0 = Date.now();
  let idle = 0;
  while (Date.now() - t0 < maxMs) {
    if ((await foreignRows()) === 0) { if (++idle >= 2) return true; } else idle = 0;
    await new Promise((r) => setTimeout(r, 15_000));
  }
  return false;
}
async function removeScene() {
  if (!cleanup.length) return;
  await sb.from("messages").delete().in("id", cleanup);
  cleanup = [];
}

async function main() {
  const analyzeConversation = await loadBrain();
  const { loadEstimateHandoff } = await import("../app/lib/estimate-handoff-server");
  const { resolveEstimateEntry } = await import("../app/lib/estimate-handoff");
  const args = process.argv.slice(2);
  const extract = args.includes("--extract");
  const reps = Math.max(1, Number((args.find((a) => a.startsWith("--reps=")) ?? "").split("=")[1] || 1));
  const only = (args.find((a) => !a.startsWith("--")) ?? "").split(",").filter(Boolean);
  const started = new Date().toISOString();
  const { data: c } = await sb.from("conversations").select("status, brain_strategy, conversation_direction").eq("id", YUMA).maybeSingle();
  const cc = (c ?? {}) as Record<string, unknown>;
  const strategy = (cc.brain_strategy ?? null) as never;
  const prevDir = (cc.conversation_direction ?? null) as Record<string, unknown> | null;
  console.log(`=== YUMA 見積書の引き継ぎ test-mode=${process.env.LLM_TEST_MODE ?? "（なし＝本番と同じ）"} alt=${process.env.LLM_ALT_ACTIONS ?? "-"} ===`);
  const summary: string[] = [];
  for (const sc of SCENES.filter((s) => !only.length || only.includes(s.id))) for (let k = 0; k < reps; k++) {
    if (!(await waitYumaIdle(Number(process.env.IDLE_WAIT_MIN ?? 10) * 60_000))) console.log("  （YUMA が空かなかった）");
    await insertScene(sc);
    const foreignBefore = await foreignRows();
    // 入れた直後に他の作業の場面があれば、ブレイン（費用のかかる呼び出し）を回さずに飛ばす
    if (foreignBefore > 0) { console.log(`  ⚠ 他の作業の場面が YUMA にあるので飛ばした（${sc.id}）`); await removeScene(); summary.push(`（飛ばし）${sc.id}`); continue; }
    try {
      const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
      const meta = await runInDeepseekScope(async () => {
        setDeepseekScope({ conversationId: YUMA, mark: { kind: "all" } });
        return analyzeConversation(YUMA, true, (cc.status as string) ?? "proposing", null, "brain", {
          autoSendEnabled: false, customerName: "YUMA",
          prevPhase: typeof prevDir?.current_phase === "string" ? prevDir.current_phase : null,
          prevAix: null,
          mode: strategy ? "incremental" : "full", layer: strategy ? "fresh" : "combined", strategy: strategy ?? null,
        });
      });
      const m = (meta ?? {}) as Record<string, unknown>;
      const dirty = foreignBefore + (await foreignRows()) > 0;
      if (dirty) console.log(`  ⚠ この回は他の作業の場面が YUMA に入っていた（数えない）`);
      const action = (m.action as string) || "(なし)";
      const h = await loadEstimateHandoff(YUMA);
      // 画面と同じ: 入口はブレインの判断（保存しないので今回の meta）＋初期費用を抑えたい
      const entry = resolveEstimateEntry({ brainAction: action === "(なし)" ? null : action, lowInitialCost: h?.watch.lowInitialCost ?? false });
      const t = h?.choice.target ?? null;
      const okAix = sc.wantAix.includes(action);
      const okEntry = (entry.show ? entry.mode : null) === sc.wantEntry || (sc.id === "with_property" && (entry.mode === "with_property" || !entry.show));
      const okTarget = sc.wantTarget ? !!t && sc.wantTarget.test(t.name) : true;
      console.log(`\n【${sc.id}】ブレイン=${action}（${String(m.decision_source ?? "-")}）${okAix ? "✓" : "✗"}  入口=${entry.show ? entry.mode : "なし"} ${okEntry ? "✓" : "✗"}`);
      console.log(`  方向「${String(m.reply_direction ?? "").replace(/\s+/g, " ").slice(0, 120)}」 note「${String(m.note ?? "").replace(/\s+/g, " ").slice(0, 160)}」`);
      console.log(`  お部屋: ${t ? `${t.name} ${t.room ?? ""}（${t.sourceLabel}）資料${t.materials.length}枚${t.materialText ? "＋文字" : ""} 家賃=${t.rent ?? "?"} AD=${t.adYen ?? "?"}円` : "なし"} ${okTarget ? "✓" : "✗"}`);
      console.log(`  割引の目安: ${h?.discount ? `${h.discount.yen.toLocaleString()}円（${h.discount.basis}）利益=${h.discount.profitYen ?? "?"}` : "なし"}  自動読み取り=${h?.choice.autoExtract ? "○" : "×"}`);
      for (const w of h?.choice.warnings ?? []) console.log(`  ⚠ ${w}`);
      if (extract && t && h?.choice.autoExtract) {
        // 見積書ツールの自動の読み取りと同じ route（試行錯誤は資料の文字だけ＝DeepSeek・最終は画像も＝Sonnet）
        const { NextRequest } = await import("next/server");
        const { POST } = await import("../app/api/extract-estimate-info/route");
        const images: Array<{ base64: string; mimeType: string }> = [];
        if (!process.env.LLM_TEST_MODE && t.materials[0]) {
          const blob = await (await fetch(t.materials[0].url)).blob();
          images.push({ base64: Buffer.from(await blob.arrayBuffer()).toString("base64"), mimeType: blob.type || "image/png" });
        }
        const supp = [`物件名: ${t.name}`, t.room ? `号室: ${t.room}` : "", t.materialText ? `【売上サポの資料の文字】\n${t.materialText.slice(0, 4000)}` : ""].filter(Boolean).join("\n");
        const res = await POST(new NextRequest("http://localhost/api/extract-estimate-info", { method: "POST", body: JSON.stringify({ images, supplementaryText: supp }), headers: { "Content-Type": "application/json" } }));
        const j = await res.json() as { ok?: boolean; extracted?: Record<string, unknown>; error?: string };
        const e = j.extracted ?? {};
        console.log(`  読み取り（画像${images.length}枚）: ${j.ok ? "ok" : `NG ${j.error}`} 物件名=${e.propertyName} 号室=${e.roomNumber} 家賃=${e.rent} 管理費=${e.managementFee} 敷=${e.shikikin} 礼=${e.reikin} 保証料率=${e.guaranteeRate} 火災=${e.insurance} 鍵=${e.keyExchange}`);
      }
      summary.push(`${dirty ? "（汚れ）" : ""}${sc.id}: ブレイン ${action} ${okAix ? "✓" : "✗"}／入口 ${entry.show ? entry.mode : "なし"} ${okEntry ? "✓" : "✗"}／お部屋 ${t?.name ?? "なし"} ${okTarget ? "✓" : "✗"}  ※${sc.note}`);
    } finally {
      await removeScene();
    }
  }
  console.log("\n=== まとめ ===");
  for (const s of summary) console.log(s);
  // 使ったモデル（YUMA の会話で絞れない読み取りも含め、この実行の時間帯の env=local を数える）
  const { data: logs } = await sb.from("llm_usage_logs").select("model, route, action, env").gte("created_at", started).like("env", "local%");
  const tally = new Map<string, number>();
  for (const l of (logs ?? []) as Array<{ model: string; route: string | null; action: string | null; env: string }>) {
    const k = `${l.env} ${l.model} ${l.action ?? l.route ?? "-"}`; tally.set(k, (tally.get(k) ?? 0) + 1);
  }
  console.log("\n=== 使ったモデル（llm_usage_logs・この実行の間・env=local*）===");
  for (const [k, v] of tally) console.log(`  ${k} × ${v}`);
}
main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await removeScene(); if (h) await h.finish().catch((e) => console.warn("finish:", String(e))); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
