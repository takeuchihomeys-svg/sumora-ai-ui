// scripts/yuma-customer-memo-test.ts — お客様のメモ・気持ちの流れ（customer-memo・customer-mood-flow・10/08）の前後を YUMA で比べる（off＝メモなし／on＝メモあり）。
//   手順書 memory/test_protocol_brain.md どおり（YUMA だけ・共通の入口・未来の時刻・線（floor）で YUMA の過去を読まない・自分の行だけ id で消す・同時1本）。
//   on は「最後のお客様の番より前の通」を DeepSeek でメモにしてから（refreshCustomerMemoLlm・表には書かず手元の箱＝__customerMemoOverride）、最後の番を入れてブレイン→下書き。
//   場面は11巡目の不一致 194番のうちメモで防げた番の実物（#214 全て送った→新着待ち／#36 初期費用の用意の時期／#166 保証会社の希望と審査の事情／#97 新生児）。名前は YUMA・物件名は伏せた。
// 実行: TEST_CLOCK_JST_HOUR=14 REPLAY_FLOOR_FILE=<floor> LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-customer-memo-test.ts --floor=<floor> [回数=1] [場面,..] [--versions=off,on] [--out=]
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
import { MSG_SEP } from "../app/lib/reply-context";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").slice(k.length + 3) || d;
const VERSIONS = arg("versions", "off,on").split(",");
const OUT = arg("out", "scripts/.replay-out/customer-memo.jsonl");
const FLOOR_FILE = arg("floor");
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const PREFIX = "cmemo-";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const own = { msg: [] as string[], sip: [] as string[] };
const memoBox = new Map<string, import("../app/lib/customer-memo").StoredMemo>();
(globalThis as { __customerMemoOverride?: unknown }).__customerMemoOverride = memoBox;
type Row = { s: "staff" | "customer"; t: string; sec: number; img?: string; aix?: boolean };
type Prop = { name: string; room: string };
const ESLEAD: Prop = { name: "エスリード難波レジデンス", room: "1406" };
/** 今日（JST）から days 日後 */
const ahead = (days: number) => { const d = new Date(Date.now() + 9 * 3600_000 + days * 86_400_000); return { md: `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`, slash: `${d.getUTCMonth() + 1}/${d.getUTCDate()}` }; };
function rec(p: Prop, sec: number): Row[] {
  return [
    { s: "staff", t: "[画像]", sec, img: "p1", aix: true },
    { s: "staff", t: `🌟${p.name} ${p.room}号室\n\n1件新着でYUMAさんにかなりオススメ出来るお部屋が募集に出ました！！\n家賃管理費込78,000円の1K、敷金礼金なしで初期費用をかなり抑えてご入居頂けます！！\n\nお手隙の際にご査収ください😌！！`, sec: sec + 1, aix: true },
  ];
}
const SCENES: Record<string, { rows: Row[]; expect: string }> = {
  // 10/08 竹内さん「初期費用の振込が12月下旬以降になるように逆算して申込」（payment-timing・決まった計算）
  money_dec: { rows: [
    { s: "customer", t: "初期費用の用意ができるのが12月下旬以降になりそうです🙇", sec: 0 },
    { s: "staff", t: "かしこまりました！！\nYUMAさんにオススメ出来るお部屋ピックアップしお送りさせて頂きます！！", sec: 600 },
    ...rec(ESLEAD, 86_400), { s: "customer", t: "ここすごく気に入りました！申込したいです！", sec: 90_000 }],
    expect: "内覧はそのまま・申込の時期を逆算（12/1〜12/11 頃のお申込みで入居 12/31 以降＝お振込は12月下旬以降）" },
  // #214 の実物: こちらが「現在募集中のお部屋は全てピックアップ」した後に「もう少し安く」＝新着待ちの約束（新たにピックアップと言わない）
  all_sent: { rows: [
    { s: "customer", t: "西区か浪速区で8万以内の1Kでお願いします", sec: 0 },
    { s: "staff", t: "[画像]", sec: 86_000, img: "p1", aix: true },
    { s: "staff", t: "YUMAさん夜分遅くに失礼致します。\n現在募集中のお部屋でYUMAさんのご条件に近いお部屋全てピックアップさせて頂きました！！\nお気に召されたお部屋お申込み可能です！！\nお手隙の際にご査収ください😌！！", sec: 86_010, aix: true },
    { s: "customer", t: "お調べありがとうございます😭", sec: 88_900 },
    { s: "customer", t: "なかなか要望条件が多く、お部屋選びに苦戦してて申し訳ないですが何卒よろしくお願い致します🙇‍♂️", sec: 88_960 },
    { s: "customer", t: "敷金礼金0で出来るだけ安く済ませたいと思っております🙇‍♂️", sec: 88_980 }],
    expect: "人: 新着情報随時確認・募集に出次第お送り（今の募集は全て送った後）＝「新たにピックアップ」と言わない" },
  // #36 の実物（時期だけ先へ）: 前の発言「最短でも12月末にしか初期費用を用意出来ない」→ 新しいオススメ → 内覧したい
  money_late: { rows: [
    { s: "customer", t: "ありがとうございます。\n沢山、頂けて幸いです。\n私も最短でも12月末にしか初期費用を用意出来ないと思うので", sec: 0 },
    { s: "staff", t: "はい😊！！\n初期費用面も出来る限り、割引させて頂きYUMAさんのお引越しにかかる費用抑えさせて頂きます！！\n気になる点等出てきましたらいつでもお気軽にご連絡ください！！", sec: 700 },
    ...rec(ESLEAD, 86_400), { s: "customer", t: "ここ良さそうですね！内覧したいです！", sec: 90_000 }],
    expect: "初期費用の用意が12月末＝入居・申込の時期を合わせる（今すぐの申込で抑えるを強く押さない・時期を踏まえた案内）" },
  // #166 の実物（伏せた）: 前の発言で保証会社はクレカ系を控えたい・名義貸しで審査落ちの事情 → 新しいオススメ → 審査の質問
  guarantor: { rows: [
    { s: "customer", t: "わがままを言いますが、保証会社はクレカ系は控えたいです。\nあと、前回通らなかったのは以前、友人に名義を貸した際に飛ばれてるので\nそれが影響してるかもしれないです。", sec: 0 },
    { s: "staff", t: "かしこまりました！！\nクレジットカード系保証会社は避け、独立系保証会社をご利用のお部屋を中心にYUMAさんにオススメできるお部屋ピックアップさせて頂きます！！", sec: 900 },
    ...rec(ESLEAD, 86_400), { s: "customer", t: "ここ気になります！今度は審査大丈夫そうですか？", sec: 90_000 }],
    expect: "前の事情（クレカ系を避ける・前回の否決）を踏まえる＝保証会社の種類の確認・審査の通りやすさ・切り替えの交渉" },
  // #97 の実物: 前の発言で新生児と2人暮らし → お風呂が狭いと… → お風呂広めを中心に探す約束
  newborn: { rows: [
    { s: "customer", t: "新生児と二人暮らしなので1DK以上で4万5千円以内でお願いします🙇‍♀️", sec: 0 },
    { s: "staff", t: "かしこまりました！！\nYUMAさんと新生児のお子様お二人でお過ごし頂ける1DK以上・家賃4万5000円以内のお部屋ピックアップさせて頂きます😊！！", sec: 600 },
    ...rec(ESLEAD, 86_400), { s: "customer", t: "ありがとうございますm(_ _)m\nお風呂が狭いと赤ちゃんのお風呂入れるのが難しいなって思っちゃって…💦", sec: 90_000 }],
    expect: "人: ご要望お聞かせ頂きありがとうございます→お風呂広めのお部屋を中心にお調べ（共感だけで終わらない）" },
};

function parseStream(raw: string): string {
  let body = String(raw ?? "");
  const nl = body.indexOf("\n");
  if (nl >= 0) { try { const j = JSON.parse(body.slice(0, nl)); if (j && typeof j === "object") body = body.slice(nl + 1); } catch { /* */ } }
  return body.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
}
function writeFloor(floor: string | null) {
  if (!FLOOR_FILE) return;
  writeFileSync(FLOOR_FILE, JSON.stringify(floor ? { conversationId: YUMA, floor, status: "proposing", messageIdPrefix: PREFIX } : {}));
}
let h: LlmTestHarness | null = null;
async function cleanup() {
  if (own.msg.length) await sb.from("messages").delete().in("id", own.msg);
  if (own.sip.length) await sb.from("sent_image_properties").delete().in("image_url", own.sip);
  own.msg = []; own.sip = [];
}

async function main() {
  if (!process.env.REPLAY_FLOOR_FILE || process.env.REPLAY_FLOOR_FILE.replace(/\\/g, "/") !== FLOOR_FILE.replace(/\\/g, "/")) throw new Error("REPLAY_FLOOR_FILE と --floor を同じにする（YUMA の過去の記録を読まないため）");
  const reps = Math.max(1, Number(ARGS[0] ?? 1));
  const which = (ARGS[1] ?? Object.keys(SCENES).join(",")).split(",");
  h = await setupLlmTest("yuma-customer-memo-test");
  h.assertYuma(YUMA);
  const { analyzeConversation } = await import("../app/lib/brain-core");
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  const { POST } = await import("../app/api/generate-reply/route");
  for (const name of which) {
    const sc = SCENES[name];
    if (!sc) { console.warn(`場面なし: ${name}`); continue; }
    h.assertSceneSafe(sc.rows.map((r) => r.t), name);
    for (let k = 0; k < reps; k++) for (const ver of VERSIONS) {
      process.env.CUSTOMER_MEMO = ver === "off" ? "off" : "";
      process.env.CUSTOMER_MOOD_FLOW = ver === "off" ? "off" : "";
      process.env.PAYMENT_TIMING = ver === "off" ? "off" : "";
      process.env.CUSTOMER_MEMO_LLM_NOTE = ver === "off" ? "" : "on"; // 10/08 影をやめる前の確かめ: on はメモの DeepSeek の行もブレインと返信に渡す
      process.env.CUSTOMER_MEMO_LLM = "off"; // ブレインの後の after の読み取りは止める（メモは下で1回だけ作る）
      memoBox.clear();
      await h.waitUntilYumaQuiet(own.msg);
      const last = Math.max(...sc.rows.map((r) => r.sec));
      const t0 = Date.now() + 120_000 - last * 1000;
      const at = (sec: number) => new Date(t0 + sec * 1000).toISOString();
      const runId = randomUUID().slice(0, 8);
      const url = (x: string) => `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/property-images/test/${PREFIX}${runId}-${x}.jpg`;
      const out: Record<string, unknown> = { scene: name, ver, rep: k + 1, expect: sc.expect };
      const lastTurnStart = (() => { let i = sc.rows.length; while (i > 0 && sc.rows[i - 1].s === "customer") i--; return i; })();
      try {
        const toRow = (r: Row, i: number) => ({ conversation_id: YUMA, sender: r.s, text: r.t, is_aix_generated: !!r.aix, created_at: at(r.sec), line_message_id: `${PREFIX}${runId}-${i}`, image_url: r.img ? url(r.img) : null });
        writeFloor(new Date(t0 - 5_000).toISOString());
        const pre = await sb.from("messages").insert(sc.rows.slice(0, lastTurnStart).map(toRow)).select("id");
        if (pre.error) throw new Error(pre.error.message);
        own.msg.push(...(pre.data ?? []).map((x) => x.id as string));
        if (ver !== "off") {
          // 最後のお客様の番より前の通でメモを作る（本番では前の番のブレインの後に作られている物）
          try {
            process.env.CUSTOMER_MEMO_LLM = "";
            const { refreshCustomerMemoLlm } = await import("../app/lib/customer-memo-server");
            const rr = await runInDeepseekScope(async () => { setDeepseekScope({ conversationId: YUMA, mark: { kind: "all" } }); return refreshCustomerMemoLlm(YUMA); });
            out.memoRefresh = rr;
          } finally { process.env.CUSTOMER_MEMO_LLM = "off"; }
          const m = memoBox.get(YUMA);
          out.memo = (m?.items ?? []).map((x) => `${x.kind}: ${x.text}${x.sourceQuote ? ` ＝「${x.sourceQuote}」` : ""}`);
          console.log(`   メモ（${(out.memo as string[]).length}）: ${(out.memo as string[]).join(" ／ ")}`);
        }
        const ins = await sb.from("messages").insert(sc.rows.slice(lastTurnStart).map((r, j) => toRow(r, lastTurnStart + j))).select("id");
        if (ins.error) throw new Error(ins.error.message);
        own.msg.push(...(ins.data ?? []).map((x) => x.id as string));
        const imgRow = sc.rows.find((r) => r.img);
        if (imgRow) {
          const r = await sb.from("sent_image_properties").insert([{ image_url: url("p1"), conversation_id: YUMA, property_name: ESLEAD.name, room_no: ESLEAD.room, source: "test", created_at: at(imgRow.sec) }]);
          if (r.error) throw new Error(r.error.message);
          own.sip.push(url("p1"));
        }
        writeFloor(new Date(t0 - 5_000).toISOString());
        await new Promise((r) => setTimeout(r, 1300));
        h.assertYuma(YUMA, "brain");
        const meta = await runInDeepseekScope(async () => {
          setDeepseekScope({ conversationId: YUMA, mark: { kind: "all" } });
          return analyzeConversation(YUMA, true, "proposing", null, "brain", { autoSendEnabled: true, customerName: "YUMA", prevPhase: null, prevAix: null, mode: "full", layer: "combined", strategy: null });
        }) as unknown as Record<string, unknown> | null;
        const src = (meta?.decision_source as string | undefined) ?? (meta?.decision_source_no_aix as string | undefined) ?? "-";
        Object.assign(out, { action: meta?.action ?? null, cp: meta?.check_pattern ?? null, reply_mode: meta?.reply_mode ?? null, src, dir: String(meta?.reply_direction ?? "").slice(0, 300), keyTopics: meta?.key_topics ?? null, alts: meta?.alt_actions ?? null, note: String(meta?.note ?? "").slice(0, 200) });
        console.log(`\n[${name} ${ver} ${k + 1}] 期待: ${sc.expect}\n   action=${meta?.action ?? "-"} reply_mode=${meta?.reply_mode ?? "-"} src=${src} alts=${JSON.stringify(meta?.alt_actions ?? null)}\n   方向: ${String(meta?.reply_direction ?? "").replace(/\n/g, " ").slice(0, 240)}`);
        if (meta) {
          const lastStaff = sc.rows.map((r) => r.s).lastIndexOf("staff");
          const cust = sc.rows.slice(lastStaff + 1).filter((r) => r.s === "customer").map((r) => r.t);
          const body = {
            message: cust.join(MSG_SEP), customerMessages: cust, state: "proposing", conversationId: YUMA, customerName: "YUMA", hasViewed: false, activeTaskTypes: [], hasStaffReplied: true,
            recentMessages: sc.rows.map((r) => ({ sender: r.s, text: r.t, createdAt: at(r.sec), isAix: !!r.aix })),
            brainMetaDirect: { meta: { ...meta, reply_mode: meta.reply_mode === "aix" ? "reply" : meta.reply_mode }, customerName: "YUMA", conversationDirection: (meta.conversation_direction as Record<string, unknown> | undefined) ?? null, brainAnalyzedAt: new Date().toISOString() },
            shadowNoWrite: true, testSceneMaterials: "on",
          };
          const res = await POST(new Request("http://localhost/api/generate-reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never) as Response;
          const ct = res.headers.get("content-type") ?? "";
          out.draft = ct.includes("application/json") ? `（下書きなし: ${JSON.stringify(await res.json().catch(() => ({}))).slice(0, 160)}）` : parseStream(await res.text());
          console.log(`   下書き: ${String(out.draft).replace(/\n/g, " ／ ")}`);
          // 連投の依頼の一覧に対して下書きが触れていない項目（request-ledger.uncoveredRequests・ログだけ）
          const { splitRequests, uncoveredRequests, TOPIC_JA } = await import("../app/lib/request-ledger");
          const items = splitRequests(cust, new Date().toISOString());
          if (items.length >= 2) { out.items = items.map((x) => x.topic); out.uncovered = uncoveredRequests(items, String(out.draft ?? "")).map((x) => x.topic); console.log(`   一覧: ${items.map((x) => TOPIC_JA[x.topic]).join("・")}｜下書きの抜け: ${(out.uncovered as string[]).map((t) => TOPIC_JA[t as keyof typeof TOPIC_JA]).join("・") || "なし"}`); }
        }
      } catch (e) { out.error = e instanceof Error ? e.message : String(e); console.error(`   失敗: ${out.error}`); }
      finally { writeFloor(null); await cleanup(); }
      appendFileSync(OUT, JSON.stringify(out) + "\n");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { writeFloor(null); try { await cleanup(); } catch (e) { console.error("片付け失敗", e); } if (h) await h.finish(); setTimeout(() => process.exit(process.exitCode ?? 0), 800); });
