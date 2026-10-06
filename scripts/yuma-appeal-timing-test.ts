// scripts/yuma-appeal-timing-test.ts
// 訴求のタイミング（app/lib/appeal-timing.ts）を YUMA で通す: 実物の場面（チンシャン・R・退去予定・質問）を入れて
//   ①ブレイン（analyzeConversation・保存しない）が appeal_timing と reply_direction に何を出すか
//   ②返信の下書き（開発サーバの /api/generate-reply）に申込／内覧の訴求が入るか
// を見る。手順書 memory/test_protocol_brain.md（YUMA だけ・試行錯誤は LLM_TEST_MODE=deepseek-all・最後の Claude は LLM_TEST_FINAL_CLAUDE=1 で場面ごとに1〜2回）。
//
// 実行:
//   開発サーバ: LLM_TEST_MODE=deepseek-all LINE_STAFF_GROUP_ID=invalid npx next dev --webpack -p 3471
//   LLM_TEST_MODE=deepseek-all BASE_URL=http://localhost:3471 npx tsx --env-file=.env.local scripts/yuma-appeal-timing-test.ts [回数=1] [場面id,...]
//   NO_GEN=1 でブレインだけ（開発サーバ不要）
//
// 書くもの: YUMA の messages（場面の数通・自分の id だけ消す）。generate-reply が YUMA の conversations の下書きの列を書くので、
//   始める前の値を自分で控えて最後に戻す（共有の scripts/.yuma-backup.json は他の担当も使うので触らない）。
import { createClient } from "@supabase/supabase-js";
import { setupLlmTest, type LlmTestHarness } from "./lib/llm-test-harness";
import { requireTestServer } from "./lib/dev-server-test-guard";
import { detectAppeal } from "../app/lib/appeal-timing";

let h: LlmTestHarness | null = null;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3471";
const NO_GEN = process.env.NO_GEN === "1";
const SNAP_COLS = "status, ai_draft, ai_draft_check, suggested_aix_meta, last_brain_meta, brain_analyzed_at, draft_pending_at, draft_attempted_at, last_message, last_sender, updated_at";

type Turn = { s: "staff" | "customer"; t: string; aix?: string };
type Scene = { id: string; note: string; turns: Turn[]; want: "apply" | "viewing" | "none"; wantLevel?: string };

const KASHIMI = "🌟カシミマンション 401号室\n\n（オススメポイント）\n・家賃86,000円・共益費4,000円・水道代3,000円（合計93,000円）\n・間取り：2LDK（リビング9帖、洋室7帖・洋室5帖）\n・京阪本線「森小路」駅徒歩5分\n・リノベーション物件・角部屋\n・エアコン3基新設\n・南向きで日当たり良好";
const KASHIMI_2 = "こちらのお部屋如何でしょうか！！\n\nリノベーション済みの角部屋で南向き・エアコン3基新設と設備も充実しており、YUMAさんにかなりオススメ出来るお部屋となります！！\n\nお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！\nお手隙の際にご査収ください😊！！";
const SCENES: Scene[] = [
  {
    id: "chinshan", note: "チンシャン 10/05 19:46「いいですね！」（物件オススメの後・空室・AI は見積書の約束だけだった）",
    turns: [{ s: "staff", t: KASHIMI, aix: "property_recommendation" }, { s: "staff", t: KASHIMI_2, aix: "property_recommendation" }, { s: "customer", t: "いいですね！" }],
    want: "viewing", wantLevel: "must",
  },
  {
    id: "r_think", note: "R 10/05 15:57「確認していただきありがとうございます！ 検討します！」（見積書の後・スタッフは申込の扉）",
    turns: [
      { s: "staff", t: "【カーサピエント 203号室】\n\n初期費用：355,880円\n\nスモラなら一般的な不動産業者より70,400円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。", aix: "estimate_sheet" },
      { s: "staff", t: "初期費用の御見積書となります！！\nこちらのお部屋クリーニング費用はご契約時にお支払いの為費用が初期費用がかかる物件となります！！", aix: "estimate_sheet" },
      { s: "customer", t: "見積もりありがとうございます。\nエアコンの件よろしくお願いします！" },
      { s: "staff", t: "はい😊！！\n\nエアコンの件、明日確認してご連絡させて頂きます😌！！" },
      { s: "staff", t: "YUMAさん\nお世話になっております！！\n\n管理会社にエアコンの件確認させていただき、リビング洋室共に備わっております。とのご返答でした！！\n\nお手隙の際にご確認の程よろしくお願いいたします！！" },
      { s: "customer", t: "確認していただきありがとうございます！\n検討します！" },
    ],
    want: "apply",
  },
  {
    id: "moveout_think", note: "67fda056 7/18「検討させてください」（退去予定の物件オススメの後・スタッフは1部屋のみ＋抑えた状態でご内覧）",
    turns: [
      { s: "staff", t: "🌟ラージヒル鶴見緑地 302号室\n\n（オススメポイント）\n・1LDK・家賃管理費込75,000円\n・11月29日退去予定のお部屋となります！！\n・1部屋のみの募集となります！！", aix: "property_recommendation" },
      { s: "customer", t: "ありがとうございます！！ 検討させてください🙇‍♀️" },
    ],
    want: "apply",
  },
  {
    id: "question", note: "見積書の後の質問（訴求は足さない・実送信 3%）",
    turns: [
      { s: "staff", t: "【カーサピエント 203号室】\n\n初期費用：355,880円\n\n※ご入居日によって日割家賃が発生致します。", aix: "estimate_sheet" },
      { s: "customer", t: "更新料はかかりますか？" },
    ],
    want: "none",
  },
];

let ownIds: string[] = [];
async function insertScene(sc: Scene): Promise<string> {
  h!.assertSceneSafe(sc.turns.map((t) => t.t), sc.id);
  h!.assertYuma(Y, "場面の書き込み");
  const times = h!.sceneTimes(sc.turns.length);
  const ins = await sb.from("messages").insert(sc.turns.map((t, i) => ({ conversation_id: Y, sender: t.s, text: t.t, is_aix_generated: !!t.aix, created_at: times[i] }))).select("id");
  if (ins.error) throw new Error(`場面を作れず: ${ins.error.message}`);
  ownIds.push(...((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id));
  // AIX の記録（aix_usage_logs）は書かない（集計・学習の表に混ざる）。場面は is_aix_generated の文と物件の文で読む（appeal-timing の記録なしの道）
  return times[times.length - 1];
}
async function removeScene() {
  if (ownIds.length) await sb.from("messages").delete().in("id", ownIds);
  ownIds = [];
}

async function main() {
  h = await setupLlmTest("yuma-appeal-timing-test");
  if (!NO_GEN) await requireTestServer(BASE, "yuma-appeal-timing-test");
  const { analyzeConversation } = await import("../app/lib/brain-core");
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  const reps = Math.max(1, Math.min(3, Number(process.argv[2] ?? 1)));
  const only = (process.argv[3] ?? "").split(",").filter(Boolean);
  const { data: snap } = await sb.from("conversations").select(SNAP_COLS).eq("id", Y).maybeSingle();
  const { data: c } = await sb.from("conversations").select("status, customer_name, has_viewed, brain_strategy, conversation_direction").eq("id", Y).maybeSingle();
  const cc = (c ?? {}) as Record<string, unknown>;
  const summary: string[] = [];
  try {
    for (const sc of SCENES.filter((s) => !only.length || only.includes(s.id))) {
      for (let k = 0; k < reps; k++) {
        await h.waitUntilYumaQuiet(ownIds);
        await insertScene(sc);
        try {
          const strategy = (cc.brain_strategy ?? null) as never;
          const prevDir = (cc.conversation_direction ?? null) as Record<string, unknown> | null;
          const meta = await runInDeepseekScope(async () => {
            setDeepseekScope({ conversationId: Y, mark: { kind: "all" } });
            return analyzeConversation(Y, true, String(cc.status ?? "proposing"), null, "brain", {
              autoSendEnabled: false, customerName: "YUMA",
              prevPhase: typeof prevDir?.current_phase === "string" ? prevDir.current_phase : null, prevAix: null,
              mode: strategy ? "incremental" : "full", layer: strategy ? "fresh" : "combined", strategy: strategy ?? null,
            });
          }) as Record<string, unknown> | null;
          const at = (meta?.appeal_timing ?? null) as { kind: string; level: string; reason: string } | null;
          const dir = String(meta?.reply_direction ?? "");
          console.log(`\n【${sc.id}】[${k + 1}] ${sc.note}`);
          console.log(`  ブレイン: action=${meta?.action ?? "(なし)"} src=${meta?.decision_source ?? "-"} 訴求=${at ? `${at.kind}/${at.level}（${at.reason}）` : "-"}`);
          console.log(`  方向: ${dir.replace(/\n/g, " ").slice(0, 260)}`);
          let draft = "";
          if (!NO_GEN) {
            const { data: msgs } = await sb.from("messages").select("sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(20);
            const recentMessages = ((msgs ?? []) as Array<Record<string, unknown>>).reverse().map((m) => ({ sender: String(m.sender), text: String(m.text ?? ""), imageUrl: (m.image_url as string | null) ?? undefined, createdAt: String(m.created_at), isAix: !!m.is_aix_generated }));
            const last = sc.turns[sc.turns.length - 1].t;
            const res = await fetch(`${BASE}/api/generate-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
              message: last, customerMessages: [last], state: String(cc.status ?? "proposing"), conversationId: Y, customerName: "YUMA",
              hasViewed: !!cc.has_viewed, activeTaskTypes: [], recentMessages, brainMeta: meta ?? undefined,
            }) });
            const raw = await res.text(); const nl = raw.indexOf("\n");
            draft = (nl >= 0 ? raw.slice(nl + 1) : raw).replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
            console.log(`  下書き（HTTP ${res.status}）:\n    ${draft.replace(/\n/g, "\n    ")}`);
          }
          const d = detectAppeal(draft);
          const got = d.apply ? "apply" : d.viewing ? "viewing" : "none";
          const brainOk = at ? at.kind === sc.want && (!sc.wantLevel || at.level === sc.wantLevel) : sc.want === "none";
          const draftOk = NO_GEN ? null : got === sc.want;
          summary.push(`${sc.id}[${k + 1}]: 判定 ${brainOk ? "✓" : "✗"}（${at?.kind ?? "-"}/${at?.level ?? "-"}）${draftOk === null ? "" : ` 下書き ${draftOk ? "✓" : "✗"}（${got}）`} ← 期待 ${sc.want}`);
        } finally {
          await removeScene();
        }
      }
    }
  } finally {
    await removeScene();
    if (snap) await sb.from("conversations").update(snap as never).eq("id", Y);
    console.log("\n片付け: 入れた通を消し、YUMA の会話の列を始める前の値に戻した");
  }
  console.log("\n=== まとめ ===");
  for (const s of summary) console.log(s);
}
main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await removeScene().catch(() => {}); if (h) await h.finish().catch((e) => console.warn("finish:", String(e))); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
