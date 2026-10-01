// scripts/yuma-first-reply-echo-test.ts
// 2026-10-01 竹内「初回返信の条件を読み直すところ…実際は微々たる改善してスタッフが改善しているところ多いから、
//   その点も実際のLINEを見て改善する…YUMAでテストも徹底的に行う」
//
// 本番の初回の条件フォーム（名前は伏せ・実物の言い回しのまま）を YUMA に1つずつ入れ、真の初回（こちらの送信なし）として
//   ブレイン → /api/generate-reply（書かない呼び方 shadowNoWrite）で下書きを作り、条件の復唱の文（ピックアップの文）を
//   スタッフが実際に送った復唱と並べる（文字の編集距離・原文のままの言い回しが残っているか）。
//   ・書くのは YUMA の messages（line_message_id="echo-…"）だけ。場面ごとに消す（失敗しても finally で消す）
//   ・他の担当も YUMA を使うので、場面は今+300分の先の時刻に置き、REPLAY_FLOOR_FILE（開発サーバと同じファイル）で場面より前の YUMA の記録を読まない
//   ・LINE には何も送らない
//
// 実行（試行錯誤＝ブレインも返信も DeepSeek。起動コマンドにだけ付ける）:
//   開発サーバ（写し）: LLM_TEST_MODE=deepseek-all LLM_ALT_ACTIONS=reply_generate,brain_fresh,brain_full REPLAY_FLOOR_FILE=<file> npx next dev --webpack -p 3463
//   LLM_TEST_MODE=deepseek-all LLM_ALT_ACTIONS=reply_generate,brain_fresh,brain_full ECHO_BASE=http://localhost:3463 REPLAY_FLOOR_FILE=<file> \
//     npx tsx --env-file=.env.local scripts/yuma-first-reply-echo-test.ts [--only=id,id] [--reps=1] [--label=r1]
// 最終（本番と同じ組み合わせ＝ブレイン・判定・最終チェックは Claude・本文は DeepSeek）: 開発サーバも本スクリプトも LLM_TEST_MODE を外して --only で数件
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { MSG_SEP } from "../app/lib/reply-context";

type Analyze = typeof import("../app/lib/brain-core").analyzeConversation;
import { setupLlmTest, type LlmTestHarness } from "./lib/llm-test-harness";
let h: LlmTestHarness | null = null;
async function loadBrain(): Promise<Analyze> {
  // fetch の包みは brain-core を読み込む前（Anthropic SDK は作られた時点の fetch を握る）
  // 2026-10-01 共通の入口（scripts/lib/llm-test-harness.ts・手順書 memory/test_protocol_brain.md）: テストの種類の明示（deepseek-all／LLM_TEST_FINAL_CLAUDE=1）・包みの順・記録の待ち・Claude の歯止め・YUMA だけ
  h = await setupLlmTest("yuma-first-reply-echo-test");
  return (await import("../app/lib/brain-core")).analyzeConversation;
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.ECHO_BASE ?? "http://localhost:3463";
const FLOOR_FILE = process.env.REPLAY_FLOOR_FILE ?? "";
const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const ONLY = arg("only").split(",").filter(Boolean);
const REPS = Math.max(1, Number(arg("reps", "1")));
const LABEL = arg("label", `e-${new Date().toISOString().slice(5, 16).replace(/[:T-]/g, "")}`);
const OUT_DIR = "scripts/.replay-out";
// 2026-10-01 夕: AIX=1 で、初回の返信の後に AIX【物件ピックアップした】（/api/aix/action・文を返すだけ・送らない）も作り、ピックアップ行を見る
const WITH_AIX = process.env.AIX === "1";
const NL = String.fromCharCode(10);

const FORM_HEAD = "▶︎【お部屋お探し中！】\n\n（ご希望のお部屋探しご条件）\n";
const FORM_TAIL = "\n________________________\n※ 審査に不安な事がある方お気軽にお伝えください😊\n審査面柔軟にサポートさせて頂きます！";
const form = (a: string[]) => FORM_HEAD + [
  `①【ご入居の時期】⇒${a[0]}`, `②【ご希望の家賃（◯万円〜◯万円）】⇒${a[1]}`, `③【希望の広さ・間取り】⇒${a[2]}`, `④【希望築年数】${a[3]}`,
  `⑤【ご希望のエリア・駅名】⇒${a[4]}`, `⑥【ご希望の駅徒歩分数】⇒${a[5]}`, `⑦【初期費用の限度額】⇒${a[6]}`, `⑧【その他ご要望あれば】⇒${a[7]}`,
].join("\n") + FORM_TAIL;

/** 本番の初回の条件フォーム（名前は伏せ）と、スタッフが実際に送った復唱の文（お客様の名前は YUMA に置き換え） */
type Scene = { id: string; src: string; customer: string[]; staff: string; watch: RegExp[] };
const SCENES: Scene[] = [
  { id: "ka_layout", src: "10/01 チンシャンさん（1LDKか2LDK→または・・RC造→のRC造）",
    customer: [form(["まだ未定", "7万円〜10万円", "1LDKか2LDK", "特になし", "都島駅、桜ノ宮駅", "近いなら良いが妥協はできます。", "安いと嬉しいです。", "今住んでる家が1LDKで家賃8万円です。\n木造の為か、騒音がうるさいとクレームが来て疲れてます。\nちなみに今の家は木造らしいので次はRCだと嬉しいです。"])],
    staff: "都島駅・桜ノ宮駅周辺全域から家賃7万円〜10万円以内・1LDKまたは2LDKのRC造でYUMAさんにオススメできるお部屋をピックアップしてお送りさせて頂きます！！",
    watch: [/[1-5][LDKR]+か[1-5]/, /周辺から/] },
  { id: "kurai", src: "09/22（共益費込で7万円くらい→7万円程）",
    customer: [form(["2ヶ月以内", "共益費込で7万円くらい", "1k以上、6帖以上", "浴室乾燥機とコンロがついてれば大丈夫です。", "浪速区、西区", "10分", "15万以内", ""])],
    staff: "浪速区・西区周辺から7万円程・1K以上・6帖以上・浴室乾燥機とコンロ付きのお部屋をピックアップしてお送りさせて頂きます😌！！",
    watch: [/くらい|ぐらい/, /1k/] },
  { id: "joined_area", src: "09/07（堀江本町→堀江、本町周辺全域・14以下→家賃14万以下）",
    customer: [form(["即", "14以下", "1LDK 30㎡〜", "綺麗だと築年気にしないです", "堀江本町", "10以内", "30", ""])],
    staff: "堀江、本町周辺全域から家賃14万以下・1LDK30㎡〜のYUMAさんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！",
    watch: [/堀江本町エリア/, /14以下/] },
  { id: "child", src: "07/22（同棲可能、子供1人います→同棲可・お子様もご入居可能）",
    customer: [form(["11月末", "10万まで", "1LDK～", "なし", "桜川駅周辺", "", "30万", "同棲可能、子供1人います"])],
    staff: "桜川駅周辺全域からYUMAさんご希望のご条件に合った同棲可・お子様もご入居可能なお部屋全てピックアップしてお送りさせて頂きます！！",
    watch: [/子供1人います|1人あり/, /10万まで/] },
  { id: "pet_dog", src: "06/19（番号だけの短いフォーム・ペット可（犬）→ペット飼育可能）",
    customer: ["1 8月の中旬\n2 できれば７から9万円\n3 ユニバスでなければ特にない\n4 2000年以降\n5 堺筋本町、松屋町\n6 5分10分\n7 25万から30万💴以内\n8 ペット可、（犬）"],
    staff: "堺筋本町・松屋町周辺全域からYUMAさんご希望のご条件に合ったペット飼育可能のお部屋ピックアップしてお送りさせて頂きます！！",
    watch: [/（犬）|\(犬\)/, /５分10分|5分10分/] },
  { id: "atari", src: "06/15（難波心斎橋辺り→難波・心斎橋エリア周辺全域）",
    customer: ["①【ご入居の時期】⇒来月末あたり\n②【ご希望の家賃（◯万円〜◯万円）】⇒7万\n③【希望の広さ・間取り】⇒1DK\n④【希望築年数】 10年以内\n⑤【ご希望のエリア・駅名】⇒難波心斎橋辺り\n⑥【ご希望の駅徒歩分数】⇒10分\n⑦【初期費用の限度額】⇒8万以内\n⑧【その他ご要望あれば】⇒WiFi完備、オートロック、トイレバス別"],
    staff: "難波・心斎橋エリア周辺全域からご条件に合った1DK・WiFi完備・オートロック・トイレバス別の物件を全てピックアップしてお送りさせて頂きます！！",
    watch: [/辺り周辺|難波心斎橋/] },
  { id: "commute", src: "08/23（梅田まで30分→梅田まで30分圏内全域）",
    customer: ["（ご希望のお部屋探しご条件）\n①【ご入居の時期】⇒9月から10月\n②【ご希望の家賃】⇒8万から10万\n③【希望の広さ・間取り】⇒1LDK(45平米以上)、2LDK\n④【希望築年数】10年以内\n⑤【ご希望のエリア・駅名】⇒梅田まで30分\n⑥【ご希望の駅徒歩分数】⇒10分以内\n⑦【初期費用の限度額】⇒20万\n⑧【その他ご要望あれば】⇒二人入居可、ペット可能"],
    staff: "梅田まで30分圏内全域から、YUMAさんご希望のご条件に合った45㎡以上の1LDK・2LDKのお部屋をピックアップしお送りさせて頂きます！！",
    watch: [/梅田まで30分周辺/] },
  { id: "space_list", src: "08/05（城東区 京橋駅 桜ノ宮・105000円まで・2ldk以上）",
    customer: [form(["10月", "105000円まで", "2ldk以上", "リノベされていれば特になし", "城東区 京橋駅 桜ノ宮", "15分以内", "", "インスタなどで紹介されている部屋がどこにあるのか気になって連絡しました。"])],
    staff: "城東区・京橋駅・桜ノ宮周辺全域からYUMAさんご希望のご条件に合った2LDK以上のお部屋全てピックアップしてお送りさせて頂きます！！",
    watch: [/2ldk/, /105000円まで/] },
  { id: "shinai", src: "07/23（大阪市内・5万円から7万円・2LK→2LDK）",
    customer: ["①8月16日\n②5万円から7万円\n③2LK\n⑤大阪市内"],
    staff: "大阪市内全域からYUMAさんご希望のご条件に合った2LDK・家賃7万円以内のお部屋全てピックアップしてお送りさせて頂きます！！",
    watch: [/市内から/, /2LK/] },
  { id: "free_text", src: "06/23（文だけ・大阪市内でペット可2LDK…家賃17万前後）",
    customer: ["大阪市内でペット可2LDK駅徒歩10分程度\n家賃17万前後で初期費用安い物件ありますか？？"],
    staff: "大阪市内全域からペット可・2LDK・駅徒歩10分以内・家賃17万前後で初期費用を最大限抑えたお部屋ピックアップしてお送りさせて頂きます😊！！",
    watch: [/市内から/, /10分程度/] },
  { id: "ka_kurai", src: "08/26（城東区 鶴見区・最大12万くらいまで・1LDKか2LDK）",
    customer: [form(["決まってない", "最大12万くらいまで", "1LDKか2LDK", "⇒なし", "城東区 鶴見区", "", "高すぎなければ", " 鉄筋コンクリートとか 電気じゃなくてガスコンロとか\n風呂トイレ別 オートロック 宅配ボックスあり"])],
    staff: "城東区、鶴見区全域から、YUMAさんご希望のご条件に合うお部屋をピックアップさせて頂きます！！",
    watch: [/くらい/, /[1-5][LDKR]+か[1-5]/, /とか/] },
  { id: "ward_list", src: "06/22（西区北区都島区中央区・8-9万円・30㎡以上・WIC欲しい）",
    customer: [form(["8月末〜9月頭", "8-9万円", "30㎡以上", "10年以内", "西区北区都島区中央区", "8分以内", "20万", "WIC欲しいです"])],
    staff: "西区・北区・都島区・中央区エリア全域から、WIC付きでYUMAさんのご希望のご条件に合ったお部屋全てピックアップしてお送りさせて頂きます！！",
    watch: [/西区北区/, /欲しい/, /8-9万/] },
];

function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
const pickSent = (t: string) => t.split(/\n|(?<=[！!。])(?=[^！!。])/).map((s) => s.trim()).find((x) => /ピックアップ/.test(x)) ?? "";

let cleanup: string[] = [];
function writeFloor(floor: string | null) {
  if (!FLOOR_FILE) return;
  writeFileSync(FLOOR_FILE, JSON.stringify(floor ? { conversationId: YUMA, floor, status: "hearing" } : {}));
}
async function insertScene(sc: Scene) {
  // 他の担当（今+120分）より先に置く（今+300分）。真の初回＝お客様の通だけ
  const end = Date.now() + 300 * 60_000;
  const rows = sc.customer.map((t, i) => ({
    conversation_id: YUMA, sender: "customer", text: t, is_aix_generated: false, line_message_id: `echo-${randomUUID()}`,
    created_at: new Date(end - (sc.customer.length - 1 - i) * 60_000).toISOString(),
  }));
  const ins = await sb.from("messages").insert(rows).select("id");
  if (ins.error) throw new Error(`場面を作れず: ${ins.error.message}`);
  cleanup.push(...((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id));
  writeFloor(new Date(Date.parse(rows[0].created_at) - 1000).toISOString());
  await new Promise((r) => setTimeout(r, 1200));
  return rows;
}
async function removeScene() {
  writeFloor(null);
  if (!cleanup.length) return;
  await sb.from("messages").delete().in("id", cleanup);
  cleanup = [];
}

async function main() {
  const analyzeConversation = await loadBrain();
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  if (!FLOOR_FILE) console.warn("⚠ REPLAY_FLOOR_FILE なし＝YUMA の過去の記録が場面に混ざる");
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const outFile = `${OUT_DIR}/${LABEL}.jsonl`;
  writeFileSync(outFile, "");
  // 前回の失敗で残った自分の場面を先に片付ける
  await sb.from("messages").delete().eq("conversation_id", YUMA).like("line_message_id", "echo-%");
  const t0 = new Date().toISOString();
  const list = SCENES.filter((s) => !ONLY.length || ONLY.includes(s.id));
  console.log(`=== YUMA 初回の条件の復唱 ${list.length}場面×${REPS} label=${LABEL} test-mode=${process.env.LLM_TEST_MODE ?? "（なし＝本番と同じ）"} base=${BASE} ===`);
  const rowsOut: string[] = [];
  let sumD = 0, sumBase = 0, n = 0, watchHits = 0;
  for (const sc of list) {
    for (let k = 0; k < REPS; k++) {
      try {
        const msgs = await insertScene(sc);
        const meta = await runInDeepseekScope(async () => {
          setDeepseekScope({ conversationId: YUMA, mark: { kind: "all" } });
          return analyzeConversation(YUMA, true, "hearing", null, "brain", { autoSendEnabled: false, customerName: "YUMA", prevPhase: null, prevAix: null, mode: "full", layer: "combined", strategy: null });
        }) as Record<string, unknown> | null;
        const m = meta ?? {};
        const units = sc.customer;
        const body = {
          message: units.join(MSG_SEP), customerMessages: units, state: "first_reply", conversationId: YUMA, customerName: "YUMA",
          hasViewed: false, activeTaskTypes: [], hasStaffReplied: false,
          recentMessages: msgs.map((r) => ({ sender: r.sender, text: r.text, createdAt: r.created_at, isAix: false })),
          brainMetaDirect: { meta: m, customerName: "YUMA", conversationDirection: (m.conversation_direction as Record<string, unknown> | undefined) ?? null, brainAnalyzedAt: new Date().toISOString() },
          shadowNoWrite: true,
        };
        const res = await fetch(`${BASE}/api/generate-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(240_000) });
        const raw = await res.text();
        const nl = raw.indexOf("\n");
        let text = raw;
        try { JSON.parse(raw.slice(0, nl)); text = raw.slice(nl + 1); } catch { /* 1行目が本文 */ }
        const fcm = text.match(/<<<FINAL_CHECK:([\s\S]*?)>>>/);
        let fc: Record<string, unknown> | null = null; try { fc = fcm ? JSON.parse(fcm[1]) : null; } catch { fc = null; }
        text = text.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
        const echo = pickSent(text);
        const d = echo ? lev(echo, sc.staff) : sc.staff.length;
        const hits = sc.watch.filter((re) => re.test(echo)).map((re) => re.source);
        sumD += d; sumBase += sc.staff.length; n++; if (hits.length) watchHits++;
        const applied = ((fc?.tpo_debug as Record<string, unknown> | undefined)?.postprocess as Record<string, unknown> | undefined)?.validateIssues ?? null;
        console.log(`\n【${sc.id}】[${k + 1}] ${sc.src}\n  ブレイン: ${String(m.action ?? "-")}/${String(m.decision_source ?? "-")}  距離=${d}${hits.length ? `  ⚠原文のまま: ${hits.join(" ")}` : ""}\n  下書き復唱: ${echo || "（ピックアップの文なし）"}\n  実送信復唱: ${sc.staff}\n  下書き全文: ${text.replace(/\n/g, " / ")}`);
        // 語が欠ける（「トイレバス別で〇〇さんに…」→「トイレバスお部屋」）の出所を追うため、最終チェックの書き直しの有無を残す
        const tdbg = (fc?.tpo_debug ?? {}) as Record<string, unknown>;
        const fcInfo = { revision_count: fc?.revision_count ?? null, revisionOutcome: tdbg.revisionOutcome ?? null, pre: fc?.pre_revision_issues ?? null, draftHead: tdbg.draftHead ?? null, gateEdits: (tdbg.postprocess as Record<string, unknown> | undefined)?.gateEdits ?? null };
        let aixText: string | null = null;
        if (WITH_AIX && k === 0) {
          // 初回の返信を送った体で、こちらの通を足してから AIX を作る（本番の流れ: 初回の返信 → 物件ピックアップした）
          const staffRow = { conversation_id: YUMA, sender: "staff", text, is_aix_generated: false, line_message_id: `echo-${randomUUID()}`, created_at: new Date(Date.parse(msgs[msgs.length - 1].created_at) + 60_000).toISOString() };
          const ins2 = await sb.from("messages").insert(staffRow).select("id");
          cleanup.push(...((ins2.data ?? []) as Array<{ id: string }>).map((r) => r.id));
          const rm = [...msgs, staffRow].map((r) => ({ sender: r.sender, text: r.text, rawCreatedAt: r.created_at, createdAt: r.created_at, isAix: false }));
          const ar = await fetch(`${BASE}/api/aix/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
            action: "property_send", account: "sumora", conversation_id: YUMA, customer_name: "YUMA", conversation_status: "proposing",
            recent_messages: rm, customer_conditions: sc.customer.join(NL), send_mode: "normal", property_count: 5,
          }), signal: AbortSignal.timeout(240_000) });
          const aj = await ar.json().catch(() => ({})) as Record<string, unknown>;
          aixText = String(aj.message_text ?? aj.error ?? "").trim();
          console.log(`  AIX ピックアップ行: ${pickSent(aixText) || aixText.slice(0, 160).split(NL).join(" / ")}`);
        }
        rowsOut.push(JSON.stringify({ id: sc.id, k, d, hits, echo, staff: sc.staff, text, brain: m.action ?? null, applied, fc: fcInfo, aix: aixText }));
        appendFileSync(outFile, rowsOut[rowsOut.length - 1] + "\n");
      } catch (e) {
        console.log(`【${sc.id}】[${k + 1}] ERROR ${String(e).slice(0, 200)}`);
      } finally {
        await removeScene();
      }
    }
  }
  console.log(`\n=== まとめ ${label()} ===\n  復唱の距離の平均 ${(sumD / Math.max(1, n)).toFixed(1)}（スタッフの文の長さの平均 ${(sumBase / Math.max(1, n)).toFixed(1)}）・原文のままが残った ${watchHits}/${n}`);
  const { data: logs } = await sb.from("llm_usage_logs").select("action, model, env").gte("created_at", t0).eq("conversation_id", YUMA).order("created_at");
  const tally = new Map<string, number>();
  for (const l of (logs ?? []) as Array<Record<string, unknown>>) { const key = `${l.action}:${l.model}:${l.env}`; tally.set(key, (tally.get(key) ?? 0) + 1); }
  console.log("\n=== llm_usage_logs（YUMA・この回）===");
  for (const [key, v] of tally) console.log(`  ${key} × ${v}`);
  function label() { return LABEL; }
}
main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await removeScene(); if (h) await h.finish().catch((e) => console.warn("finish:", String(e))); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
