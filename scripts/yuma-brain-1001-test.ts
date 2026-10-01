// scripts/yuma-brain-1001-test.ts
// 2026-10-01 竹内さんの決定（確認しますを出さない・家賃込みは返信）を YUMA でブレインに通す。
//   仕組みは scripts/yuma-aix-scene-brain-test.ts と同じ（場面を YUMA の messages に入れ、analyzeConversation を直接呼ぶ・
//   判断の保存/AIX要対応/カレンダー/通知なし・場面は毎回消す）。
//   GEN=1 で「AIX なし」になった場面の返信の下書きも作る（BASE_URL の開発サーバの /api/generate-reply・本文は DeepSeek）。
// 実行（試行錯誤＝ブレインも DeepSeek）:
//   LLM_TEST_MODE=deepseek-all LLM_ALT_ACTIONS=reply_generate,brain_fresh,brain_full npx tsx --env-file=.env.local scripts/yuma-brain-1001-test.ts [回数=3] [場面id,...]
// 最終（本番と同じ＝ブレインは Claude）: 先頭の2つを付けずに 回数=1
import { createClient } from "@supabase/supabase-js";
type Analyze = typeof import("../app/lib/brain-core").analyzeConversation;
async function loadBrain(): Promise<Analyze> {
  try { const { installLlmUsageRecorder } = await import("../app/lib/llm-usage-recorder"); await installLlmUsageRecorder(); } catch (e) { console.warn("usage recorder:", String(e)); }
  const { installAltProvider } = await import("../app/lib/llm-alt-provider");
  const alt = installAltProvider();
  console.log(`[alt] ${alt ? "差し替え有効（LLM_ALT_ACTIONS の経路は DeepSeek）" : "差し替えなし（Claude）"}`);
  return (await import("../app/lib/brain-core")).analyzeConversation;
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3141";
const GEN = process.env.GEN === "1";
let cleanup: string[] = [];

type Turn = { s: "staff" | "customer"; t: string; aix?: boolean };
type Scene = { id: string; note: string; turns: Turn[]; want: string[] };

const PROP_SEND = "🌟ジーメゾン石津町東アビテ 0201号室\n\n新着で募集に出た、敷金礼金なし・ペット飼育可（小型犬2匹まで）のお部屋で、YUMAさんにかなりオススメ出来るお部屋となります！！\n\n家賃70,000円・管理費5,000円（合計75,000円）の1LDKで、南海本線「諏訪ノ森」徒歩10分と好立地です！！\n\nお手隙の際にご査収ください😌！！";
const EST_SENT = "YUMAさん\n確認させていただきました！！\nジーメゾン石津町東アビテ 0201号室現在募集中となります！！\n最大限割引しました御見積書同封させて頂きました！！\n\n【ジーメゾン石津町東アビテ 0201号室】\n初期費用：158,400円\n\nお手隙の際にご査収ください😌！！";
const NO_ACK = ["property_check_result", "estimate_sheet"];
const SCENES: Scene[] = [
  // ── 決定1: 物件の問い合わせは いきなり 物件確認した（確認します を出さない）──
  { id: "kazuki", note: "和樹 10/1 12:45（新着待ちの約束の後に SUUMO の持ち込み）", want: ["property_check_result"], turns: [
    { s: "staff", t: PROP_SEND, aix: true },
    { s: "staff", t: "YUMAさん\nご査収いただきありがとうございます😊！！\n引き続き新着でオススメできるお部屋ピックアップしお送りさせていただきます😌！！" },
    { s: "customer", t: "わかりました！\nわざわざありがとうございます！" },
    { s: "customer", t: "ＭＡＩＳＯＮ　ＬＵＮＡ 1階\nhttps://suumo.jp/chintai/bc_100500564435/\nby SUUMO" },
    { s: "customer", t: "ここはどうでしょうか？" },
  ] },
  { id: "suumo_share", note: "みこと 8a77820b 9/26（言葉なしの SUUMO の共有・旧は場面なしで 確認します）", want: NO_ACK, turns: [
    { s: "staff", t: PROP_SEND, aix: true },
    { s: "customer", t: "レジュールアッシュ淡路駅前 1階\nhttps://suumo.jp/chintai/bc_100524898255/\nby SUUMO" },
  ] },
  { id: "homes_share", note: "3f36dfa6 9/24（HOMES の共有＋相づち・旧は信号4で 確認します）", want: NO_ACK, turns: [
    { s: "staff", t: PROP_SEND, aix: true },
    { s: "customer", t: "そうなんですね！ ありがとうございます🙇" },
    { s: "customer", t: "【ホームズ】ピュアハイツ2[2LDK/賃料10.4万円/1階/55.19㎡]の賃貸アパート住宅情報 https://www.homes.co.jp/chintai/room/8d7a1c2b3e4f/" },
  ] },
  { id: "vacancy_word", note: "0133b787 9/17「エスリード難波ザ.ブライト募集中が出ているかの確認をお願い致します。」（旧は 確認します）", want: ["property_check_result"], turns: [
    { s: "staff", t: PROP_SEND, aix: true },
    { s: "customer", t: "エスリード難波ザ.ブライト募集中が出ているかの確認をお願い致します。" },
  ] },
  { id: "portal_image", note: "画像の持ち込み（ポータルの画面の見出し）＋「このマンションも空いてますか？」", want: NO_ACK, turns: [
    { s: "staff", t: PROP_SEND, aix: true },
    { s: "customer", t: "[画像] 【物件の画面（ポータル）】\nIBCレジデンスウエスト 5階 2LDK 59.59㎡ 18.4万" },
    { s: "customer", t: "このマンションも空いてますか？" },
  ] },
  // ── 決定3: 家賃込みかだけ → AIX なし（返信）／中身の質問は 初期費用について のまま ──
  { id: "rent_included", note: "ひまり f2196d11 9/26「家賃込の価格でしょうか？」（旧: 初期費用について・下書き「家賃は含まれておりません」）", want: ["(なし)"], turns: [
    { s: "staff", t: EST_SENT, aix: true },
    { s: "customer", t: "家賃込の価格でしょうか？" },
  ] },
  { id: "rent_included_s9", note: "8b260f7e 7/14「そこから9月末までの家賃は初期費用に含まれているってことですよね！」（スタッフは手打ち）", want: ["(なし)"], turns: [
    { s: "staff", t: EST_SENT, aix: true },
    { s: "customer", t: "8月末から入居したとして、そこから9月末までの家賃は初期費用に含まれているってことですよね！" },
  ] },
  { id: "breakdown_ctrl", note: "対照: ゆうこ「家賃だけ払ったら住めるんですか？」（AIX 初期費用について のまま）", want: ["cost_breakdown"], turns: [
    { s: "staff", t: EST_SENT, aix: true },
    { s: "customer", t: "家賃だけ払ったら住めるんですか？" },
  ] },
  { id: "estimate_ctrl", note: "対照: c024b7b9「初期費用はいくら位になりますかね」（見積書送る のまま）", want: ["estimate_sheet"], turns: [
    { s: "staff", t: PROP_SEND, aix: true },
    { s: "customer", t: "初期費用はいくら位になりますかね" },
  ] },
];

async function insertScene(sc: Scene) {
  const now = Date.now();
  const rows = sc.turns.map((t, i) => ({
    conversation_id: YUMA, sender: t.s, text: t.t, is_aix_generated: !!t.aix,
    // 2026-10-01: 他のテストも YUMA に場面を入れる（同時に走る）ので、自分の場面が一番新しくなるよう少し先の時刻に置く
    created_at: new Date(now + 2 * 60_000 - (sc.turns.length - i) * 20_000).toISOString(),
  }));
  const ins = await sb.from("messages").insert(rows).select("id");
  if (ins.error) throw new Error(`場面を作れず: ${ins.error.message}`);
  cleanup.push(...((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id));
}
async function removeScene() {
  if (!cleanup.length) return;
  await sb.from("messages").delete().in("id", cleanup);
  cleanup = [];
}

async function generate(sc: Scene, meta: Record<string, unknown>, cc: Record<string, unknown>): Promise<string> {
  const { data: msgs } = await sb.from("messages").select("sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(20);
  const recentMessages = ((msgs ?? []) as Array<Record<string, unknown>>).reverse().map((m) => ({ sender: String(m.sender), text: String(m.text ?? ""), imageUrl: (m.image_url as string | null) ?? undefined, createdAt: String(m.created_at), isAix: !!m.is_aix_generated }));
  const msg = sc.turns.filter((t) => t.s === "customer").slice(-1)[0]?.t ?? "";
  const res = await fetch(`${BASE}/api/generate-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    message: msg, customerMessages: [msg], state: String(cc.status ?? "proposing"), conversationId: YUMA, customerName: "YUMA",
    hasViewed: !!cc.has_viewed, activeTaskTypes: [], recentMessages, brainMeta: meta,
  }) });
  const raw = await res.text(); const nl = raw.indexOf("\n");
  return (nl >= 0 ? raw.slice(nl + 1) : raw).replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
}

async function main() {
  const analyzeConversation = await loadBrain();
  const reps = Math.max(1, Math.min(6, Number(process.argv[2] ?? 3)));
  const only = (process.argv[3] ?? "").split(",").filter(Boolean);
  const { data: c } = await sb.from("conversations").select("status, has_viewed, brain_strategy, conversation_direction").eq("id", YUMA).maybeSingle();
  const cc = (c ?? {}) as Record<string, unknown>;
  const strategy = (cc.brain_strategy ?? null) as never;
  const prevDir = (cc.conversation_direction ?? null) as Record<string, unknown> | null;
  const t0 = new Date().toISOString();
  console.log(`=== YUMA 10/01 の決定テスト test-mode=${process.env.LLM_TEST_MODE ?? "（なし＝本番と同じ）"} alt=${process.env.LLM_ALT_ACTIONS ?? "-"} 回数=${reps} GEN=${GEN} ===`);
  const summary: string[] = [];
  for (const sc of SCENES.filter((s) => !only.length || only.includes(s.id))) {
    let ok = 0;
    const got: string[] = [];
    for (let k = 0; k < reps; k++) {
      await insertScene(sc);
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
        const a = (m.action as string) || "(なし)";
        const cp = (m.check_pattern as string | null) ?? null;
        const hit = sc.want.includes(a);
        if (hit) ok++;
        got.push(`${a}${cp ? `/${cp}` : ""}(${String(m.decision_source ?? "-")})`);
        console.log(`【${sc.id}】[${k + 1}] ${hit ? "✓" : "✗"} ${a}${cp ? `/${cp}` : ""} src=${String(m.decision_source ?? "-")} mode=${String(m.reply_mode ?? "-")} 方向「${String(m.reply_direction ?? "").replace(/\n/g, " ").slice(0, 100)}」`);
        if (GEN && a === "(なし)" && k === 0) {
          const draft = await generate(sc, m, cc);
          console.log(`   【下書き】${draft.replace(/\n/g, " / ")}`);
        }
      } finally {
        await removeScene();
      }
    }
    summary.push(`${sc.id}: ${ok}/${reps}（期待 ${sc.want.join("|")}）← ${got.join(" ")}  ※${sc.note}`);
  }
  console.log("\n=== まとめ ===");
  for (const s of summary) console.log(s);
  const { data: logs } = await sb.from("llm_usage_logs").select("action, model, env").gte("created_at", t0).eq("conversation_id", YUMA).order("created_at");
  const tally = new Map<string, number>();
  for (const l of (logs ?? []) as Array<Record<string, unknown>>) { const k = `${l.action}:${l.model}:${l.env}`; tally.set(k, (tally.get(k) ?? 0) + 1); }
  console.log("\n=== llm_usage_logs（YUMA・この回） ===");
  for (const [k, v] of tally) console.log(`  ${k} × ${v}`);
}
main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await removeScene(); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
