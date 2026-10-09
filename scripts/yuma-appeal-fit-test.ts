// scripts/yuma-appeal-fit-test.ts — 10/08 竹内さん①②④⑥（刺さり具合・オンライン内見の申し出・代表確認の読み取り）を YUMA で確かめる（off＝直しの前／on＝後）。
//   手順書 memory/test_protocol_brain.md どおり（YUMA だけ・共通の入口・未来の時刻・線（floor）で YUMA の過去を読まない・自分の行だけ id で消す・同時1本）。
//   yuma-grasp-circumstances.ts を写して場面だけ替えた（ブレイン→返信の下書き＝generate-reply の POST を直に呼ぶ・DB の下書きは書かない shadowNoWrite）。
// 実行: TEST_CLOCK_JST_HOUR=14 REPLAY_FLOOR_FILE=<floor> LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-appeal-fit-test.ts --floor=<floor> [回数=1] [場面,..] [--versions=off,on] [--out=]
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
import { MSG_SEP } from "../app/lib/reply-context";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").slice(k.length + 3) || d;
const VERSIONS = arg("versions", "on").split(",");
const OUT = arg("out", "scripts/.replay-out/appeal-fit-yuma.jsonl");
const FLOOR_FILE = arg("floor");
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const PREFIX = "apfit-";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const own = { msg: [] as string[], sip: [] as string[] };
type Row = { s: "staff" | "customer"; t: string; sec: number; img?: string; aix?: boolean };
type Prop = { name: string; room: string };
const ESLEAD: Prop = { name: "エスリード難波レジデンス", room: "1406" };
/** 今日（JST）から days 日後 */
const ahead = (days: number) => { const d = new Date(Date.now() + 9 * 3600_000 + days * 86_400_000); return { md: `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`, slash: `${d.getUTCMonth() + 1}/${d.getUTCDate()}` }; };
const D12 = ahead(12);
const D5 = ahead(5);
function rec(p: Prop, sec: number): Row[] {
  return [
    { s: "staff", t: "[画像]", sec, img: "p1", aix: true },
    { s: "staff", t: `🌟${p.name} ${p.room}号室\n\n1件新着でYUMAさんにかなりオススメ出来るお部屋が募集に出ました！！\n家賃管理費込78,000円の1K、敷金礼金なしで初期費用をかなり抑えてご入居頂けます！！\n\nお手隙の際にご査収ください😌！！`, sec: sec + 1, aix: true },
  ];
}
const SCENES: Record<string, { rows: Row[]; expect: string }> = {
  // ① 出張中（日付なし）の「内覧したい」（d367d1b9 7/29 の形）→ 返信で抑えた状態でのご内覧＋オンライン内見・撮影の申し出（最終チェックで落ちない）
  trip_now: { rows: [...rec(ESLEAD, 0), { s: "customer", t: "内覧したいのですが、現在出張中のため、そちらへ伺うことができません", sec: 3600 }],
    expect: "返信: お部屋を抑えた状態でのご内覧＋「オンライン内見や、室内の撮影もご対応させて頂きます😊！！」・日時を組まない" },
  // ② 予定が詰まって×かなり刺さっている（fb8ab8d5 9/7 の形・3分で返事・好条件で気になる・内見できますか）→ 抑える提案→撮影（AIX）
  busy_strong: { rows: [...rec(ESLEAD, 0), { s: "customer", t: "条件など含め好条件で気になるのですが内見などはできますか？？\n今月前半結構予定詰まってて🥲", sec: 180 }],
    expect: "先に抑える提案（お気に召されましたら抑えた状態でご内覧）＋室内の撮影は AIX（返信は約束まで）" },
  // ② 予定が詰まって×反応が薄い（10時間後に予定だけ）→ 撮影して送る（AIX）→ 気に入ってから抑える・抑える提案は入れない
  busy_weak: { rows: [...rec(ESLEAD, 0), { s: "customer", t: "今月前半結構予定詰まってて🥲", sec: 36_000 }],
    expect: "抑える提案は入れない・一度室内撮影しお送り（AIX）→ 気に入ってから抑える" },
  // ④ 今週は無理×そこそこ（bfd172e6 7/13 の形）→ 来週以降で内覧調整（AIX）・抑える提案は入れない
  week_weak: { rows: [...rec(ESLEAD, 0), { s: "customer", t: "では、今週は内覧に行けないです", sec: 36_000 }],
    expect: "AIX【内覧調整】（来週以降）・抑える提案は入れない" },
  // ④ 今週は無理×かなり刺さっている → 抑える提案
  week_strong: { rows: [...rec(ESLEAD, 0), { s: "customer", t: "ここめっちゃいいです！内覧したいんですけど今週は行けないです💦", sec: 300 }],
    expect: "先に抑える提案（お気に召されましたら抑えた状態でご内覧）・日時を組まない" },
  // ⑥ 御見積書の後に持ち込みの物件（URL）→「こちらはいくらくらいお安くできますか？」（f5e92bc6 9/15 の形）→ 代表確認にしない（見積書・物件確認）
  daihyo_newprop: { rows: [...rec(ESLEAD, 0),
    { s: "staff", t: "最大限割引させて頂いた初期費用の御見積書となります！！\n\n①【エスリード難波レジデンス 1406号室】\n\n初期費用：102,280円\n\nスモラなら一般的な不動産業者より24,520円節約出来ます！！", sec: 600, aix: true },
    { s: "customer", t: "地下鉄谷町線 駒川中野 徒歩5分\n1LDK 8.5万円\nhttps://myhome.nifty.com/smp/rent/osaka/osakashihigashisumiyoshiku/suumof_000000000000/", sec: 86_400 },
    { s: "customer", t: "こんにちは。こちらはいくらくらいお安くできますか？", sec: 86_460 }],
    expect: "AIX【確認します（代表確認）】にしない（持ち込みの物件の募集状況＋御見積書）" },
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
  h = await setupLlmTest("yuma-appeal-fit-test");
  h.assertYuma(YUMA);
  const { analyzeConversation } = await import("../app/lib/brain-core");
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  const { POST } = await import("../app/api/generate-reply/route");
  for (const name of which) {
    const sc = SCENES[name];
    if (!sc) { console.warn(`場面なし: ${name}`); continue; }
    h.assertSceneSafe(sc.rows.map((r) => r.t), name);
    for (let k = 0; k < reps; k++) for (const ver of VERSIONS) {
      // off＝今回の直し（刺さり・最終チェックの申し出・代表確認の読み取り）の前
      for (const k of ["PROPERTY_APPEAL_FIT", "FINAL_CHECK_VIEWING_OFFER", "FURTHER_DISCOUNT_NEW_PROPERTY", "CIRCUMSTANCE_BUSY_BY_APPEAL"]) process.env[k] = ver === "off" ? "off" : "";
      await h.waitUntilYumaQuiet(own.msg);
      const last = Math.max(...sc.rows.map((r) => r.sec));
      const t0 = Date.now() + 120_000 - last * 1000;
      const at = (sec: number) => new Date(t0 + sec * 1000).toISOString();
      const runId = randomUUID().slice(0, 8);
      const url = (x: string) => `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/property-images/test/${PREFIX}${runId}-${x}.jpg`;
      const out: Record<string, unknown> = { scene: name, ver, rep: k + 1, expect: sc.expect };
      try {
        const ins = await sb.from("messages").insert(sc.rows.map((r, i) => ({ conversation_id: YUMA, sender: r.s, text: r.t, is_aix_generated: !!r.aix, created_at: at(r.sec), line_message_id: `${PREFIX}${runId}-${i}`, image_url: r.img ? url(r.img) : null }))).select("id");
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
