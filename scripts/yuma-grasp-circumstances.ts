// scripts/yuma-grasp-circumstances.ts — 把握「お客様の事情」（customer-circumstances.ts・10/08）の前後を YUMA で比べる（off＝把握なし／on＝把握あり）。
//   手順書 memory/test_protocol_brain.md どおり（YUMA だけ・共通の入口・未来の時刻・線（floor）で YUMA の過去を読まない・自分の行だけ id で消す・同時1本）。
//   場面は実物の外れ（7巡目の差の組 40日）から: r 8/30「都合つくのが9月13日以降…埋まる可能性高いですか」→ 人は「抑えた状態で 9/13 以降のご内覧」／
//   前の発言で「〇日以降」と言った後の内覧の希望／遠方（広島に住んでいて内見が難しい）の後の前向きな反応。日付は今日から先にずらした。
// 実行: TEST_CLOCK_JST_HOUR=14 REPLAY_FLOOR_FILE=<floor> LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-grasp-circumstances.ts --floor=<floor> [回数=1] [場面,..] [--versions=off,on] [--out=]
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
import { MSG_SEP } from "../app/lib/reply-context";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").slice(k.length + 3) || d;
const VERSIONS = arg("versions", "off,on").split(",");
const OUT = arg("out", "scripts/.replay-out/grasp-cc.jsonl");
const FLOOR_FILE = arg("floor");
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const PREFIX = "grcc-";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const own = { msg: [] as string[], sip: [] as string[] };
type Row = { s: "staff" | "customer"; t: string; sec: number; img?: string; aix?: boolean };
type Prop = { name: string; room: string };
const ESLEAD: Prop = { name: "エスリード難波レジデンス", room: "1406" };
/** 今日（JST）から days 日後 */
const ahead = (days: number) => { const d = new Date(Date.now() + 9 * 3600_000 + days * 86_400_000); return { md: `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`, slash: `${d.getUTCMonth() + 1}/${d.getUTCDate()}` }; };
const D12 = ahead(12);
function rec(p: Prop, sec: number): Row[] {
  return [
    { s: "staff", t: "[画像]", sec, img: "p1", aix: true },
    { s: "staff", t: `🌟${p.name} ${p.room}号室\n\n1件新着でYUMAさんにかなりオススメ出来るお部屋が募集に出ました！！\n家賃管理費込78,000円の1K、敷金礼金なしで初期費用をかなり抑えてご入居頂けます！！\n\nお手隙の際にご査収ください😌！！`, sec: sec + 1, aix: true },
  ];
}
const SCENES: Record<string, { rows: Row[]; expect: string }> = {
  // r 8/30 の実物（日付だけ先へ）: 今回の発言に「〇日以降」＋埋まるか
  avail_now: { rows: [...rec(ESLEAD, 0), { s: "customer", t: `ありがとうございます！\n内覧したいんですが都合つくのが${D12.md}以降の予定なんですが、今見てる物件埋まる可能性高いですかね`, sec: 3600 }],
    expect: `人: 好条件ですぐ埋まる可能性→撮影かオンライン内見→お部屋抑えた状態で ${D12.slash} 以降にご内覧（日時の候補は出さない）` },
  // 前の発言で「〇日以降」→ 物件オススメ → 内覧したい
  avail_prev: { rows: [
    { s: "customer", t: `内覧は都合つくのが${D12.md}以降になりそうです🙇`, sec: 0 },
    { s: "staff", t: "かしこまりました！！\nYUMAさんにオススメ出来るお部屋ピックアップしお送りさせて頂きます！！", sec: 600 },
    ...rec(ESLEAD, 86_400), { s: "customer", t: "ここめっちゃいいですね！内覧したいです！", sec: 90_000 }],
    expect: `${D12.slash} より前の日時を組まない・すぐ来られない＝お部屋抑えた状態で ${D12.slash} 以降にご内覧（申込の訴求）` },
  // 前の発言で遠方 → 物件オススメ → 前向き
  remote_prev: { rows: [
    { s: "customer", t: "今広島に住んでいて、内見が難しい状況なのですが大丈夫でしょうか？", sec: 0 },
    { s: "staff", t: "はい！！広島にお住まいでもご契約可能です！！オンライン内見や室内の撮影もご対応させて頂きます😊！！", sec: 600 },
    ...rec(ESLEAD, 86_400), { s: "customer", t: "ここ気になります！", sec: 90_000 }],
    expect: "現地の内覧の日時を組まない・オンライン内見／撮影・お部屋を抑える向き" },
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
  h = await setupLlmTest("yuma-grasp-circumstances");
  h.assertYuma(YUMA);
  const { analyzeConversation } = await import("../app/lib/brain-core");
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  const { POST } = await import("../app/api/generate-reply/route");
  for (const name of which) {
    const sc = SCENES[name];
    if (!sc) { console.warn(`場面なし: ${name}`); continue; }
    h.assertSceneSafe(sc.rows.map((r) => r.t), name);
    for (let k = 0; k < reps; k++) for (const ver of VERSIONS) {
      process.env.CUSTOMER_CIRCUMSTANCES = ver === "off" ? "off" : "";
      process.env.APPEAL_CIRCUMSTANCES = ver === "off" ? "off" : "";
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
        Object.assign(out, { action: meta?.action ?? null, cp: meta?.check_pattern ?? null, reply_mode: meta?.reply_mode ?? null, src, dir: String(meta?.reply_direction ?? "").slice(0, 300), keyTopics: meta?.key_topics ?? null });
        console.log(`\n[${name} ${ver} ${k + 1}] 期待: ${sc.expect}\n   action=${meta?.action ?? "-"} reply_mode=${meta?.reply_mode ?? "-"} src=${src}\n   方向: ${String(meta?.reply_direction ?? "").replace(/\n/g, " ").slice(0, 240)}`);
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
