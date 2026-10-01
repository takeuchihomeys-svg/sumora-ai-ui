// scripts/yuma-brain-1002-test.ts
// 2026-10-02 竹内さんの6つの決定（条件ヒアリング／分割はカード払いなら可／費用の質問の合図／スタッフの確認は AIX で止める／電話の文を会話に合わせる／申込の同居人）を
//   YUMA でブレインと（GEN=1 の時）返信・AIX に通す。手順書 memory/test_protocol_brain.md のとおり:
//   ・入口 scripts/lib/llm-test-harness.ts（印・包み・YUMA だけ・個人情報の網・記録の数え）
//   ・場面は YUMA に line_message_id="replay-d1002-…" で未来の時刻に入れ、REPLAY_FLOOR_FILE で YUMA の過去の記録・他の担当の場面を読まない
//   ・場面の文は本番の発言の形（名前・番号なし）。申込の書類は入れない
// 実行（試行錯誤＝全部 DeepSeek）:
//   REPLAY_FLOOR_FILE=<floor.json> LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-brain-1002-test.ts [回数=2] [場面id,...]
//   GEN=1 BASE_URL=http://localhost:<port> を付けると、AIX なしの場面の返信の下書き（/api/generate-reply）と 条件ヒアリング の AIX（/api/aix/action）も作る
//   （開発サーバも同じ REPLAY_FLOOR_FILE と印で起動しておく）
// 最終（本番と同じ）: LLM_TEST_FINAL_CLAUDE=1（開発サーバも付け直して再起動）・回数=1
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { setupLlmTest, type LlmTestHarness } from "./lib/llm-test-harness";
import { buildCallText } from "../app/lib/phone-call";
import { detectCoResident } from "../app/lib/co-resident";
import { aixAutoSendGate, findStaffOnlyFact } from "../app/lib/staff-confirm-facts";
import { findCompanyFactContradictionsUngated } from "../app/lib/company-fact-guard";

type Analyze = typeof import("../app/lib/brain-core").analyzeConversation;
let h: LlmTestHarness | null = null;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3471";
const GEN = process.env.GEN === "1";
const FLOOR_FILE = process.env.REPLAY_FLOOR_FILE ?? "";
const PREFIX = "replay-d1002-";
let cleanup: string[] = [];

type Turn = { s: "staff" | "customer"; t: string; aix?: boolean };
type Scene = { id: string; decision: string; note: string; turns: Turn[]; want: string[]; status?: string; gen?: "reply" | "hearing" | "phone" | "apply" };

const GREET = "YUMAさん、はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！\n\nYUMAさんがご満足頂くお部屋が見つかるまでお部屋探し全力でサポートさせて頂きます！！\n何卒よろしくお願い致します！！";
const PROP_SEND = "🌟ジーメゾン石津町東アビテ 0201号室\n\n新着で募集に出た、敷金礼金なし・ペット飼育可（小型犬2匹まで）のお部屋で、YUMAさんにかなりオススメ出来るお部屋となります！！\n\n家賃70,000円・管理費5,000円（合計75,000円）の1LDKで、南海本線「諏訪ノ森」徒歩10分と好立地です！！\n\nお手隙の際にご査収ください😌！！";
const EST_SENT = "YUMAさん\nジーメゾン石津町東アビテ 0201号室最大限割引しました初期費用の御見積書となります！！\n\n【ジーメゾン石津町東アビテ 0201号室】\n初期費用：158,400円\n\nお手隙の際にご査収ください😌！！";

const SCENES: Scene[] = [
  // ── 決定1: 条件がそろわないうちは物件ピックアップではなく条件ヒアリング ──
  { id: "hear_incomplete", decision: "1", note: "挨拶の後「難波周辺でワンルーム探してます」（家賃なし）", want: ["condition_hearing", "(なし)"], status: "hearing", gen: "hearing", turns: [
    { s: "customer", t: "はじめまして、お部屋探しています" },
    { s: "staff", t: GREET },
    { s: "customer", t: "難波周辺でワンルーム探してます" },
  ] },
  { id: "hear_complete", decision: "1", note: "対照: エリア＋家賃あり（ピックアップのまま）", want: ["property_send", "(なし)"], status: "hearing", turns: [
    { s: "customer", t: "はじめまして、お部屋探しています" },
    { s: "staff", t: GREET },
    { s: "customer", t: "難波周辺でワンルーム、家賃7万円以内で探してます" },
  ] },
  // ── 決定2: 分割はカード払いなら可（返信）──
  { id: "installment", decision: "2", note: "見積書の後「初期費用って分割できますか？」", want: ["(なし)"], gen: "reply", turns: [
    { s: "staff", t: EST_SENT, aix: true },
    { s: "customer", t: "初期費用って分割できますか？" },
  ] },
  { id: "installment_hard", decision: "2", note: "みこと 9/30 の形「初期費用分割は難しいですよね🥲」", want: ["(なし)"], gen: "reply", turns: [
    { s: "staff", t: EST_SENT, aix: true },
    { s: "customer", t: "ありがとうございます。\n初期費用分割は難しいですよね🥲" },
  ] },
  // ── 決定3: 費用の質問の合図 ──
  { id: "cost_here", decision: "3", note: "こちらが送ったお部屋に「初期費用はいくら位になりますかね」（c024b7b9）", want: ["estimate_sheet"], turns: [
    { s: "staff", t: PROP_SEND, aix: true },
    { s: "customer", t: "初期費用はいくら位になりますかね" },
  ] },
  { id: "cost_nego", decision: "3", note: "見積書の後「初期費用もう少し安くなりませんか？」（値下げ・交渉）", want: ["(なし)", "acknowledge_check", "property_recommendation", "property_send"], turns: [
    { s: "staff", t: EST_SENT, aix: true },
    { s: "customer", t: "初期費用もう少し安くなりませんか？" },
  ] },
  { id: "cost_brought", decision: "3", note: "SUUMO の持ち込み＋「ここの初期費用いくらですか？」（110b3053）", want: ["property_check_result"], turns: [
    { s: "staff", t: PROP_SEND, aix: true },
    { s: "customer", t: "ここの初期費用いくらですか？\nTC天美南 1階\nhttps://suumo.jp/chintai/bc_100527713926/\nby SUUMO" },
  ] },
  { id: "cost_thanks", decision: "3", note: "見積書へのお礼「見積もりありがとうございます…改めて連絡させていただきます」（fb8ab8d5）", want: ["(なし)"], turns: [
    { s: "staff", t: EST_SENT, aix: true },
    { s: "customer", t: "見積もりありがとうございます🙇\n1度確認してまた改めて連絡させていただきます🙇" },
  ] },
  // ── 決定5: 電話の文を会話に合わせる ──
  { id: "phone_time", decision: "5", note: "「14:30-15:00くらいに掛けても大丈夫でしょうか？」（ボタンはまだ）", want: ["phone_call", "(なし)"], gen: "phone", turns: [
    { s: "staff", t: PROP_SEND, aix: true },
    { s: "customer", t: "ちょっと相談したいことがあるので14:30-15:00くらいに電話掛けても大丈夫でしょうか？" },
  ] },
  { id: "phone_ask", decision: "5", note: "H 9/15「ご相談があるのですがお電話では無理でしょうか？」", want: ["phone_call"], gen: "phone", turns: [
    { s: "staff", t: PROP_SEND, aix: true },
    { s: "customer", t: "ありがとうございます😊 ご相談があるのですがお電話では無理でしょうか？" },
  ] },
  // ── 決定6: 申込へ・同居人 ──
  { id: "apply_shared", decision: "6", note: "「彼女と一緒に住みたいのでここで申し込みしたいです！」", want: ["application_push"], gen: "apply", turns: [
    { s: "staff", t: PROP_SEND, aix: true },
    { s: "customer", t: "ここすごくいいです！彼女と一緒に住みたいのでここで申し込みしたいです！" },
  ] },
  { id: "apply_unknown", decision: "6", note: "「608で申し込みしたいです」（同居人の手がかりなし）", want: ["application_push"], gen: "apply", turns: [
    { s: "staff", t: PROP_SEND, aix: true },
    { s: "customer", t: "ここで申し込みしたいです！" },
  ] },
];

function writeFloor(floor: string | null, status?: string) {
  if (!FLOOR_FILE) return;
  writeFileSync(FLOOR_FILE, JSON.stringify(floor ? { conversationId: YUMA, floor, status: status ?? "proposing", messageIdPrefix: "replay-" } : {}));
}
async function insertScene(sc: Scene, k: number): Promise<string> {
  h!.assertSceneSafe(sc.turns.map((t) => t.t), sc.id);
  const times = h!.sceneTimes(sc.turns.length);
  const rows = sc.turns.map((t, i) => ({ conversation_id: YUMA, sender: t.s, text: t.t, is_aix_generated: !!t.aix, created_at: times[i], line_message_id: `${PREFIX}${sc.id}-${k}-${i}-${Date.now()}` }));
  const ins = await sb.from("messages").insert(rows).select("id");
  if (ins.error) throw new Error(`場面を作れず: ${ins.error.message}`);
  cleanup.push(...((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id));
  writeFloor(times[0], sc.status);
  return times[0];
}
async function removeScene() {
  if (!cleanup.length) return;
  await sb.from("messages").delete().in("id", cleanup);
  cleanup = [];
  writeFloor(null);
}
function recentOf(sc: Scene, times: string[]) {
  return sc.turns.map((t, i) => ({ sender: t.s, text: t.t, createdAt: times[i], rawCreatedAt: times[i], isAix: !!t.aix }));
}
async function genReply(sc: Scene, meta: Record<string, unknown>): Promise<string> {
  const times = h!.sceneTimes(sc.turns.length);
  const msg = sc.turns.filter((t) => t.s === "customer").slice(-1)[0]?.t ?? "";
  const res = await fetch(`${BASE}/api/generate-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    message: msg, customerMessages: [msg], state: sc.status ?? "proposing", conversationId: YUMA, customerName: "YUMA", hasViewed: false, activeTaskTypes: [],
    recentMessages: recentOf(sc, times), brainMeta: meta, shadowNoWrite: true,
  }), signal: AbortSignal.timeout(240_000) });
  const raw = await res.text(); const nl = raw.indexOf("\n");
  return (nl >= 0 ? raw.slice(nl + 1) : raw).replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
}
async function genHearing(sc: Scene): Promise<string> {
  const times = h!.sceneTimes(sc.turns.length);
  const r = await fetch(`${BASE}/api/aix/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    action: "condition_hearing", account: "sumora", conversation_id: YUMA, customer_name: "YUMA", recent_messages: recentOf(sc, times),
    // 顧客の行・条件の文字なし＝お客様の発言から書き入れる形（hearingKnownFromCustomerTexts）を確かめる
  }), signal: AbortSignal.timeout(240_000) });
  const j = await r.json().catch(() => ({})) as Record<string, unknown>;
  return `【導入】${String(j.message_text ?? j.error ?? "").replace(/\n/g, " / ")}\n   【フォーム】${String(j.hearing_form ?? "").replace(/\n/g, " / ")}`;
}

async function main() {
  h = await setupLlmTest("yuma-brain-1002-test");
  const analyzeConversation: Analyze = (await import("../app/lib/brain-core")).analyzeConversation;
  if (!FLOOR_FILE) console.warn("⚠ REPLAY_FLOOR_FILE なし＝YUMA の過去の記録が場面に混ざる");
  if (GEN) { const { requireTestServer } = await import("./lib/dev-server-test-guard"); await requireTestServer(BASE, "yuma-brain-1002-test"); }
  const reps = Math.max(1, Math.min(4, Number(process.argv[2] ?? 2)));
  const only = (process.argv[3] ?? "").split(",").filter(Boolean);
  console.log(`=== YUMA 10/02 の6つの決定 run=${h.run} 回数=${reps} GEN=${GEN} ===`);
  const summary: string[] = [];
  let mixed = 0;
  for (const sc of SCENES.filter((s) => !only.length || only.includes(s.id))) {
    let ok = 0; const got: string[] = [];
    for (let k = 0; k < reps; k++) {
      await h.waitUntilYumaQuiet(cleanup);
      await insertScene(sc, k);
      try {
        const foreign = await h.foreignYumaRows(cleanup);
        if (foreign.length) { mixed++; console.log(`【${sc.id}】[${k + 1}] 混ざり ${foreign.length}行 → 数えない`); continue; }
        const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
        const meta = await runInDeepseekScope(async () => {
          setDeepseekScope({ conversationId: YUMA, mark: { kind: "all" } });
          return analyzeConversation(YUMA, true, sc.status ?? "proposing", null, "brain", { autoSendEnabled: false, customerName: "YUMA", prevPhase: null, prevAix: null, mode: "full", layer: "combined", strategy: null });
        });
        const m = (meta ?? {}) as Record<string, unknown>;
        const a = (m.action as string) || "(なし)";
        const cp = (m.check_pattern as string | null) ?? null;
        const hit = sc.want.includes(a);
        if (hit) ok++;
        got.push(`${a}${cp ? `/${cp}` : ""}(${String(m.decision_source ?? "-")})`);
        console.log(`【${sc.id}】[${k + 1}] ${hit ? "✓" : "✗"} ${a}${cp ? `/${cp}` : ""} src=${String(m.decision_source ?? "-")} mode=${String(m.reply_mode ?? "-")} 自動送信=${a === "(なし)" ? "（返信）" : JSON.stringify(aixAutoSendGate(a))}`);
        const custTexts = sc.turns.filter((t) => t.s === "customer").map((t) => t.t);
        if (sc.gen === "phone" && k === 0) console.log(`   【電話の文】${buildCallText({ customerTurn: custTexts.slice(-1)[0], customerName: "YUMA" }).replace(/\n/g, " / ")}`);
        if (sc.gen === "apply" && k === 0) console.log(`   【同居人】${JSON.stringify(detectCoResident(custTexts))}`);
        if (GEN && k === 0 && sc.gen === "hearing") console.log(`   ${await genHearing(sc)}`);
        if (GEN && k === 0 && sc.gen === "reply" && a === "(なし)") {
          const draft = await genReply(sc, m);
          const contra = findCompanyFactContradictionsUngated(draft).map((x) => x.factId);
          console.log(`   【下書き】${draft.replace(/\n/g, " / ")}\n   カード=${/クレジット|カード/.test(draft)} 3.24%=${/3\.24/.test(draft)} 断定=${contra.join(",") || "なし"} スタッフ確認の事実=${findStaffOnlyFact(draft)?.kind ?? "なし"}`);
        }
      } finally {
        await removeScene();
      }
    }
    summary.push(`[決定${sc.decision}] ${sc.id}: ${ok}/${reps}（期待 ${sc.want.join("|")}）← ${got.join(" ")}  ※${sc.note}`);
  }
  console.log("\n=== まとめ ===");
  for (const s of summary) console.log(s);
  console.log(`混ざり ${mixed} 回（数えない）`);
}
main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await removeScene().catch(() => {}); if (h) await h.finish().catch((e) => console.warn("finish:", String(e))); setTimeout(() => process.exit(process.exitCode ?? 0), 800); });
