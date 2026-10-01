// scripts/yuma-aix-scene-brain-test.ts
// YUMA（テスト用の会話・竹内さん本人）に実物の場面を入れて、ブレインがどの AIX を選ぶかを見る。場面は毎回消す。
//
// 実行（試行錯誤＝ブレインも DeepSeek・起動コマンドにだけ付ける）:
//   LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-aix-scene-brain-test.ts [回数=3] [場面id,...]
// 最終の確かめ（本番と同じ＝ブレインは Claude）: LLM_TEST_FINAL_CLAUDE=1 を付けて 回数=1 で（2026-10-01〜 どちらかが無いと止まる・手順書 memory/test_protocol_brain.md）
//
// 2026-10-01 竹内（和樹事例）「YUMAでテストもするように…DEEPSEEKで徹底的にテストしてクロードは最終調整」
//   「他のAIXボタンでもちゃんとできているのか」→ 場面は想像で作らず、実際にスタッフがその AIX を押した直前のお客様の発言をそのまま使う。
// 書くもの: YUMA の messages（場面の数通）だけ。ブレインは analyzeConversation を直接呼ぶ（判断の保存・AIX要対応・カレンダー・通知は作らない）。
//   property_customer_id を渡さない（全項目の層でお客様の要約を書くため）。終わったら（失敗しても）入れた通を消す
import { createClient } from "@supabase/supabase-js";
// ⚠ 差し替え（fetch を包む）は brain-core を読み込む前に入れる（Anthropic SDK は作られた時点の fetch を握る）。
//   開発サーバでは instrumentation.ts が入れるが、tsx のスクリプトでは自分で入れないと LLM_ALT_ACTIONS を付けても Claude のまま
//   （2026-10-01 に1回これで「DeepSeek のつもりが Claude」で回した）。使用量の記録も入れる（llm_usage_logs の model で確かめる）
// 2026-10-01 共通の入口（scripts/lib/llm-test-harness.ts・手順書 memory/test_protocol_brain.md）に置き換え:
//   テストの種類の明示・包みの順・記録の待ち・route=script:<名前>・deepseek-all で Claude を止める・YUMA だけ、を1か所で
import { setupLlmTest, type LlmTestHarness } from "./lib/llm-test-harness";
type Analyze = typeof import("../app/lib/brain-core").analyzeConversation;
let h: LlmTestHarness | null = null;
async function loadBrain(): Promise<Analyze> {
  h = await setupLlmTest("yuma-aix-scene-brain-test");
  return (await import("../app/lib/brain-core")).analyzeConversation;
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
let cleanup: string[] = [];

type Turn = { s: "staff" | "customer"; t: string; aix?: boolean };
type Scene = { id: string; note: string; turns: Turn[]; want: string[]; wantCp?: RegExp };

const PROP_SEND = "🌟ジーメゾン石津町東アビテ 0201号室\n\n新着で募集に出た、敷金礼金なし・ペット飼育可（小型犬2匹まで）のお部屋で、YUMAさんにかなりオススメ出来るお部屋となります！！\n\n家賃70,000円・管理費5,000円（合計75,000円）の1LDKで、南海本線「諏訪ノ森」徒歩10分と好立地です！！\n\nお手隙の際にご査収ください😌！！";
const SCENES: Scene[] = [
  {
    id: "kazuki", note: "和樹 10/1 12:45（ピックアップの約束が未履行のまま SUUMO の持ち込み）",
    turns: [
      { s: "staff", t: PROP_SEND, aix: true },
      { s: "customer", t: "ここも気になってたんですけどスーパーが遠いかなと思って辞めてたんですよね。" },
      { s: "staff", t: "YUMAさん\nご査収いただきありがとうございます😊！！\n1番近くのスーパーマーケットはサンディ 諏訪ノ森店となり、徒歩で9分の距離となります！！\n\n引き続き新着でオススメできるお部屋ピックアップしお送りさせていただきます😌！！" },
      { s: "customer", t: "わかりました！\nわざわざありがとうございます！" },
      { s: "customer", t: "ＭＡＩＳＯＮ　ＬＵＮＡ 1階\nhttps://suumo.jp/chintai/bc_100500564435/\nby SUUMO" },
      { s: "customer", t: "ここはどうでしょうか？" },
    ],
    want: ["property_check_result"],
  },
  {
    id: "kazuki_prev", note: "和樹 9/30 21:34（「ここ気になってます！」・スタッフは 物件確認した＋御見積書同封）",
    turns: [
      { s: "staff", t: PROP_SEND, aix: true },
      { s: "customer", t: "初芝 1SLDK 2階\nhttps://suumo.jp/chintai/bc_100528886581/\nby SUUMO\n\nここ気になってます！" },
    ],
    want: ["property_check_result", "estimate_sheet"],
  },
  {
    id: "estimate", note: "c024b7b9 実物「初期費用はいくら位になりますかね」（スタッフ: 見積書送る）",
    turns: [{ s: "staff", t: PROP_SEND, aix: true }, { s: "customer", t: "初期費用はいくら位になりますかね" }],
    want: ["estimate_sheet"],
  },
  {
    id: "viewing", note: "110b3053 実物「ここの物件内覧いついけますか？」（スタッフ: 内覧調整）",
    turns: [{ s: "staff", t: PROP_SEND, aix: true }, { s: "customer", t: "ここの物件内覧いついけますか？" }],
    want: ["viewing_invite"],
  },
  {
    id: "meeting", note: "95019eb8 実物「10/4の13時半でお願いします!」（候補日の後・スタッフ: 待ち合わせ場所）",
    turns: [
      { s: "staff", t: PROP_SEND, aix: true },
      { s: "customer", t: "ここ内覧したいです" },
      { s: "staff", t: "YUMAさん\nかしこまりました！！\nジーメゾン石津町東アビテ 0201号室\n10/4（土）11:00〜18:30\n10/5（日）11:00〜18:30\nでご案内可能です😊！！\nご都合よろしいお日にちお時間お教え下さい！！", aix: true },
      { s: "customer", t: "10/4の13時半でお願いします!" },
    ],
    want: ["meeting_place"],
  },
  {
    id: "cost_breakdown", note: "f2196d11 実物「家賃込の価格でしょうか？」（見積書の後・スタッフ: 初期費用について）",
    turns: [
      { s: "staff", t: "YUMAさん\n確認させていただきました！！\nジーメゾン石津町東アビテ 0201号室現在募集中となります！！\n最大限割引しました御見積書同封させて頂きました！！\n\n【ジーメゾン石津町東アビテ 0201号室】\n初期費用：158,400円\n\nお手隙の際にご査収ください😌！！", aix: true },
      { s: "customer", t: "家賃込の価格でしょうか？" },
    ],
    want: ["cost_breakdown", "estimate_sheet"],
  },
  {
    id: "search_more", note: "8b5a777e 実物「築年数もう少し浅めの物件はないでしょうか？」（スタッフ: 物件オススメ／ピックアップ）",
    turns: [{ s: "staff", t: PROP_SEND, aix: true }, { s: "customer", t: "築年数もう少し浅めの物件はないでしょうか？" }],
    want: ["property_send", "property_recommendation"],
  },
  {
    id: "phone", note: "ad97cd40 実物「でんわ行けますかー？」（スタッフ: 電話をかける）",
    turns: [{ s: "staff", t: PROP_SEND, aix: true }, { s: "customer", t: "でんわ行けますかー？" }],
    want: ["phone_call"],
  },
  {
    id: "confirm_equip", note: "ae3ffecb 実物「リビングにクーラー取り付けられるか分かりますでしょうか？」（確認した（条件）の場面）",
    turns: [{ s: "staff", t: PROP_SEND, aix: true }, { s: "customer", t: "リビングにクーラー取り付けられるか分かりますでしょうか？" }],
    want: ["property_check_result"], wantCp: /^mgmt_/,
  },
  {
    id: "procedure", note: "みこと事例「審査通るまでどのくらいの期間見といたらいいですか？」（AIX なし・返信で説明）",
    turns: [{ s: "staff", t: PROP_SEND, aix: true }, { s: "customer", t: "審査通るまでどのくらいの期間見といたらいいですか？" }],
    want: ["(なし)"],
  },
];

async function insertScene(sc: Scene) {
  h!.assertSceneSafe(sc.turns.map((t) => t.t), sc.id);
  // 2026-10-01: 他の実行も YUMA に場面を入れる → 自分の場面が一番新しくなるよう先の時刻（共通の入口の sceneTimes）
  const times = h!.sceneTimes(sc.turns.length);
  const rows = sc.turns.map((t, i) => ({
    conversation_id: YUMA, sender: t.s, text: t.t, is_aix_generated: !!t.aix,
    created_at: times[i],
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

async function main() {
  const analyzeConversation = await loadBrain();
  const reps = Math.max(1, Math.min(6, Number(process.argv[2] ?? 3)));
  const only = (process.argv[3] ?? "").split(",").filter(Boolean);
  const { data: c } = await sb.from("conversations").select("status, brain_strategy, conversation_direction").eq("id", YUMA).maybeSingle();
  const cc = (c ?? {}) as Record<string, unknown>;
  const strategy = (cc.brain_strategy ?? null) as never;
  const prevDir = (cc.conversation_direction ?? null) as Record<string, unknown> | null;
  console.log(`=== YUMA 場面テスト test-mode=${process.env.LLM_TEST_MODE ?? "（なし＝本番と同じ）"} alt=${process.env.LLM_ALT_ACTIONS ?? "-"} 回数=${reps} ===`);
  const summary: string[] = [];
  for (const sc of SCENES.filter((s) => !only.length || only.includes(s.id))) {
    let ok = 0;
    const got: string[] = [];
    for (let k = 0; k < reps; k++) {
      await insertScene(sc);
      try {
        // 出口の二重の鍵（llm-alt-provider cutoffGateDecision）: 会話の呼び出しは「時刻の線の印」が無いと DeepSeek に回らない。
        //   YUMA は竹内さん本人のテスト用の会話なので線は全部（kind=all）。本番のブレインは印を置かない＝Claude のまま
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
        const hit = sc.want.includes(a) && (!sc.wantCp || (cp != null && sc.wantCp.test(cp)));
        if (hit) ok++;
        got.push(`${a}${cp ? `/${cp}` : ""}(${String(m.decision_source ?? "-")})`);
        console.log(`【${sc.id}】[${k + 1}] ${hit ? "✓" : "✗"} ${a}${cp ? `/${cp}` : ""} src=${String(m.decision_source ?? "-")} 方向「${String(m.reply_direction ?? "").replace(/\n/g, " ").slice(0, 90)}」`);
      } finally {
        await removeScene();
      }
    }
    summary.push(`${sc.id}: ${ok}/${reps}（期待 ${sc.want.join("|")}${sc.wantCp ? `/${sc.wantCp.source}` : ""}）← ${got.join(" ")}  ※${sc.note}`);
  }
  console.log("\n=== まとめ ===");
  for (const s of summary) console.log(s);
}
main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await removeScene(); if (h) await h.finish().catch((e) => console.warn("finish:", String(e))); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
