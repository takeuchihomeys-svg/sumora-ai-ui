// scripts/yuma-r8-property-memory-test.ts — 8巡目（記録の続き・10/08 竹内「オススメした物件と、お客さんが送ってきた物件をちゃんと保管できていればできる」）
// 「前にオススメした物件」「お客様が送ってきた物件」について名前無しで聞かれた番で、ブレインがどの物件の話か分かるかを
// PROPERTY_THREAD_ORIGIN=off（前＝7巡目の台帳）と on（後）で比べる。
//   rec     … 🌟オズレジデンス天王寺WEST 702号室をオススメ → 「前にオススメしてもらった物件ってまだ空いてますか？」
//   brought … お客様がポータルの画面（グランメール弁天 0503号室）→ 物件確認した（募集中・フリーレント1ヶ月）→ 「最初に送った物件ってフリーレント付いてますか？」
// 書くのは YUMA の messages・aix_usage_logs・recommendation_snapshots の自分の行だけ（id を控えて消す）。YUMA の会話の状態は前後で控えて戻す。
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-r8-property-memory-test.ts [回数=1] [rec,brought]
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const own = { msg: [] as string[], aix: [] as string[], snap: [] as number[] };
const CONV_COLS = "status, ai_draft, ai_draft_check, suggested_aix_meta, last_brain_meta, brain_analyzed_at, brain_strategy, draft_pending_at, draft_attempted_at, last_message, last_sender, property_customer_id";
let convBackup: Record<string, unknown> | null = null;

type Row = { s: "staff" | "customer"; t: string; sec: number; aix?: boolean };
type Scene = { rows: Row[]; aix: Array<{ sec: number; type: string; names: string[]; sts?: string[]; text: string }>; snap?: { sec: number; name: string; room: string; text: string }; expect: RegExp; other?: RegExp };
const STAR = "🌟オズレジデンス天王寺WEST 702号室\n\n（オススメポイント）\n・敷金礼金なしのため初期費用をかなり抑えてご入居頂けます！！\n・御堂筋線「動物園前」駅徒歩6分\n\nお手隙の際にご査収ください😊！！";
function scene(name: string): Scene {
  if (name === "rec") return {
    rows: [
      { s: "staff", t: "YUMAさん\nお世話になっております！！\n\n天王寺エリアからオススメ出来るお部屋ピックアップさせて頂きました！！\nお手隙の際にご査収ください😌！！", sec: 0, aix: true },
      { s: "staff", t: STAR, sec: 20, aix: true },
      { s: "customer", t: "ありがとうございます！少し検討します", sec: 60 },
      { s: "staff", t: "かしこまりました！！\nご不明点等ございましたらお気軽にご連絡ください😌！！", sec: 80 },
      { s: "customer", t: "前にオススメしてもらった物件ってまだ空いてますか？", sec: 140 },
    ],
    aix: [{ sec: 21, type: "property_recommendation", names: ["オズレジデンス天王寺WEST 702号室"], text: STAR }],
    snap: { sec: 20, name: "オズレジデンス天王寺WEST", room: "702", text: STAR },
    expect: /オズレジデンス/,
  };
  return {
    rows: [
      { s: "customer", t: "[画像] 【物件の画面（ポータル）】\nグランメール弁天 0503号室\n7.3万円\n1LDK\n大阪環状線 弁天町駅 徒歩6分", sec: 0 },
      { s: "customer", t: "ここって空いてますか？", sec: 5 },
      { s: "staff", t: "YUMAさん\nお世話になっております！！\n\n確認させていただきました！！\nグランメール弁天 503号室現在募集中となります！！\nこちらフリーレント1ヶ月（家賃1ヶ月分免除）のお部屋となります！！", sec: 40, aix: true },
      { s: "staff", t: "🌟アーバネックス弁天町 801号室\n\n（オススメポイント）\n・弁天町駅徒歩3分\n\nお手隙の際にご査収ください😊！！", sec: 60, aix: true },
      { s: "customer", t: "最初に送った物件ってフリーレント付いてますか？", sec: 120 },
    ],
    aix: [
      { sec: 41, type: "property_check_result", names: ["グランメール弁天 503号室"], sts: ["available"], text: "確認させていただきました！！\nグランメール弁天 503号室現在募集中となります！！" },
      { sec: 61, type: "property_recommendation", names: ["アーバネックス弁天町 801号室"], text: "🌟アーバネックス弁天町 801号室" },
    ],
    expect: /グランメール弁天/, other: /アーバネックス弁天町/,
  };
}

let h: LlmTestHarness | null = null;
async function cleanup() {
  if (own.msg.length) await sb.from("messages").delete().in("id", own.msg);
  if (own.aix.length) await sb.from("aix_usage_logs").delete().in("id", own.aix);
  if (own.snap.length) await sb.from("recommendation_snapshots").delete().in("id", own.snap);
  console.log(`片付け: messages ${own.msg.length}・aix_usage_logs ${own.aix.length}・recommendation_snapshots ${own.snap.length}`);
  own.msg = []; own.aix = []; own.snap = [];
  if (convBackup) { const { error } = await sb.from("conversations").update(convBackup).eq("id", YUMA); console.log(`YUMA の状態を戻した${error ? `（失敗: ${error.message}）` : ""}`); convBackup = null; }
}

async function main() {
  const reps = Math.max(1, Number(process.argv[2] ?? 1));
  const which = (process.argv[3] ?? "rec,brought").split(",");
  h = await setupLlmTest("yuma-r8-property-memory-test");
  h.assertYuma(YUMA);
  const { data: cb } = await sb.from("conversations").select(CONV_COLS).eq("id", YUMA).maybeSingle();
  convBackup = (cb ?? null) as Record<string, unknown> | null;
  const { analyzeConversation } = await import("../app/lib/brain-core");
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  const { propertyThreadNoteFor } = await import("../app/lib/property-thread-server");
  const tally: Record<string, { hit: number; n: number }> = {};
  for (const name of which) {
    const sc = scene(name);
    h.assertSceneSafe(sc.rows.map((r) => r.t), name);
    await h.waitUntilYumaQuiet([]);
    const t0 = Date.now() + 60_000;
    const at = (sec: number) => new Date(t0 + sec * 1000).toISOString();
    const runId = randomUUID().slice(0, 8);
    const ins = await sb.from("messages").insert(sc.rows.map((r, i) => ({ conversation_id: YUMA, sender: r.s, text: r.t, is_aix_generated: !!r.aix, created_at: at(r.sec), line_message_id: `r8pm-${runId}-${i}` }))).select("id");
    if (ins.error) throw new Error(ins.error.message);
    own.msg.push(...(ins.data ?? []).map((x) => x.id as string));
    const ax = await sb.from("aix_usage_logs").insert(sc.aix.map((a) => ({ conversation_id: YUMA, aix_type: a.type, check_pattern: a.type === "property_check_result" ? "available" : null, property_names: a.names, prop_statuses: a.sts ?? null, generated_text: a.text, created_at: at(a.sec), sent_at: at(a.sec) }))).select("id");
    if (ax.error) throw new Error(ax.error.message);
    own.aix.push(...(ax.data ?? []).map((x) => x.id as string));
    if (sc.snap) {
      const sn = await sb.from("recommendation_snapshots").insert({ conversation_id: YUMA, sent_at: at(sc.snap.sec), star_name: sc.snap.name, star_room: sc.snap.room, star_text: sc.snap.text, source: "test" }).select("id");
      if (sn.error) throw new Error(sn.error.message);
      own.snap.push(...(sn.data ?? []).map((x) => x.id as number));
    }
    for (const mode of ["off", "on"]) {
      process.env.PROPERTY_THREAD_ORIGIN = mode;
      const note = await propertyThreadNoteFor(YUMA, { asOf: at(300) });
      console.log(`\n===== ${name} [${mode}] 台帳の文 =====\n${note || "（なし）"}`);
    }
    for (let k = 0; k < reps; k++) {
      for (const mode of ["off", "on"]) {
        process.env.PROPERTY_THREAD_ORIGIN = mode;
        const meta = await runInDeepseekScope(async () => {
          setDeepseekScope({ conversationId: YUMA, mark: { kind: "all" } });
          return analyzeConversation(YUMA, true, "proposing", null, "brain", { autoSendEnabled: true, customerName: "YUMA", prevPhase: null, prevAix: null, mode: "full" });
        }) as unknown as Record<string, unknown> | null;
        const pick = (key: string) => { const v = meta?.[key]; return typeof v === "string" ? v : v ? JSON.stringify(v) : ""; };
        const dir = ["reply_direction", "current_property", "note", "key_topics", "customer_questions", "reasoning"].map(pick).filter(Boolean).join(" ｜ ").replace(/\n/g, " ");
        const ok = sc.expect.test(dir) && !(sc.other && sc.other.test(pick("reply_direction")) && !sc.expect.test(pick("reply_direction")));
        const key = `${name}:${mode}`;
        tally[key] ??= { hit: 0, n: 0 }; tally[key].n++; if (ok) tally[key].hit++;
        console.log(`[${name} ${k + 1} ${mode}] action=${meta?.action ?? "-"}${meta?.check_pattern ? `/${meta.check_pattern}` : ""} 正しい物件=${ok}${name === "brought" ? ` フリーレント=${/フリーレント/.test(dir)}` : ""}\n   方向: ${dir.slice(0, 700)}`);
      }
    }
    delete process.env.PROPERTY_THREAD_ORIGIN;
    await cleanup();
    const { data: cb2 } = await sb.from("conversations").select(CONV_COLS).eq("id", YUMA).maybeSingle();
    convBackup = (cb2 ?? null) as Record<string, unknown> | null;
  }
  console.log("\n== まとめ（ブレインが正しい物件の話と分かった回）==");
  for (const [k, v] of Object.entries(tally)) console.log(`${k}: ${v.hit}/${v.n}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { try { await cleanup(); } catch (e) { console.error("片付け失敗", e); } if (h) await h.finish(); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
