// scripts/yuma-far-move-in-test.ts — 入居の時期が先のお客様（contact-promise.ts・10/08 竹内さん）の前後を YUMA で比べる（off＝今まで／on＝理想の流れ＋連絡の日の約束）。
//   手順書 memory/test_protocol_brain.md どおり（YUMA だけ・共通の入口・未来の時刻・線（floor）で YUMA の過去を読まない・自分の行だけ id で消す・同時1本）。
//   場面は実物（きむら 6/7「一応八月の下旬あたりに引っ越そうと…8月20頃」・カメ 10/5「2028/3月以降入居」）の形で、日付を今から先にした。
//   最後に送った文（竹内さんの型）をカレンダーに入れて（syncContactPromiseCalendar）、行を読んで id で消す。
// 実行: REPLAY_FLOOR_FILE=<floor> LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-far-move-in-test.ts --floor=<floor> [回数=1] [場面,..] [--versions=off,on]
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
import { MSG_SEP } from "../app/lib/reply-context";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").slice(k.length + 3) || d;
const VERSIONS = arg("versions", "off,on").split(",");
const OUT = arg("out", "scripts/.replay-out/far-move-in.jsonl");
const FLOOR_FILE = arg("floor");
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const PREFIX = "fmi-";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const own = { msg: [] as string[], sip: [] as string[] };
type Row = { s: "staff" | "customer"; t: string; sec: number; img?: string; aix?: boolean };
type Prop = { name: string; room: string };
const NEAR = (() => { const d = new Date(Date.now() + 9 * 3600_000 + 40 * 86_400_000); return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`; })();
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
const GREET_PICKUP = "YUMAさん、はじめまして😊！！この度ご連絡頂きありがとうございます！！\n梅田周辺全域からYUMAさんご希望のご条件に合ったお部屋ピックアップしお送りさせて頂きます😌！！";
const SCENES: Record<string, { rows: Row[]; expect: string }> = {
  // きむらの形: 挨拶・ピックアップの宣言の後に「〇月の下旬あたりに引っ越そうと…」（約4ヶ月先）
  far_kimura: { rows: [
    { s: "customer", t: "梅田周辺で1K、7万以内で探しています", sec: 0 },
    { s: "staff", t: GREET_PICKUP, sec: 600 },
    { s: "customer", t: "おはようございます！\n一応2月の下旬あたりに引っ越そうと思ってます！\n2月20頃", sec: 7200 }],
    expect: "AIX なし（返信）・抑えられるのは1ヶ月 → 1ヶ月半前の日頃から本格的に → その日にピックアップしお送りの約束（今日のピックアップの約束はしない）" },
  // カメの形: 条件の箇条書きで入居が2年先
  far_kame: { rows: [
    { s: "customer", t: "お部屋探したいです", sec: 0 },
    { s: "staff", t: "YUMAさん、はじめまして😊！！この度ご連絡頂きありがとうございます！！\nご希望のエリアお送りいただけましたらよりオススメできるお部屋ピックアップ出来ますので希望エリアもお送りください！！", sec: 600 },
    { s: "customer", t: "2028/3月以降入居\n4~7万\n2LDK\n大阪府内", sec: 7200 }],
    expect: "AIX なし（返信）・理想の流れ＋連絡の日（2028年1月半ば）の約束" },
  // 対照: 入居が近い（5週間先＝連絡の日が7日未満）→ 今まで通りピックアップ
  near: { rows: [
    { s: "customer", t: "梅田周辺で1K、7万以内で探しています", sec: 0 },
    { s: "staff", t: GREET_PICKUP, sec: 600 },
    { s: "customer", t: `入居は${NEAR}頃でお願いします！`, sec: 7200 }],
    expect: "今まで通り（物件ピックアップの番）・連絡の日の約束はしない" },
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
  h = await setupLlmTest("yuma-far-move-in-test");
  h.assertYuma(YUMA);
  const { analyzeConversation } = await import("../app/lib/brain-core");
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  const { POST } = await import("../app/api/generate-reply/route");
  for (const name of which) {
    const sc = SCENES[name];
    if (!sc) { console.warn(`場面なし: ${name}`); continue; }
    h.assertSceneSafe(sc.rows.map((r) => r.t), name);
    for (let k = 0; k < reps; k++) for (const ver of VERSIONS) {
      process.env.FAR_MOVE_IN_CONTACT = ver === "off" ? "off" : "";
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
        Object.assign(out, { far: meta?.far_move_in ?? null, pending_pickup: meta?.pending_pickup ?? null, fcp: meta?.first_contact_pickup ?? null, action: meta?.action ?? null, cp: meta?.check_pattern ?? null, reply_mode: meta?.reply_mode ?? null, src, dir: String(meta?.reply_direction ?? "").slice(0, 300), keyTopics: meta?.key_topics ?? null, alts: meta?.alt_actions ?? null, note: String(meta?.note ?? "").slice(0, 200) });
        console.log(`\n[${name} ${ver} ${k + 1}] 期待: ${sc.expect}\n   far=${JSON.stringify(meta?.far_move_in ?? null)} pending_pickup=${meta?.pending_pickup ?? "-"} action=${meta?.action ?? "-"} reply_mode=${meta?.reply_mode ?? "-"} src=${src} alts=${JSON.stringify(meta?.alt_actions ?? null)}\n   方向: ${String(meta?.reply_direction ?? "").replace(/\n/g, " ").slice(0, 240)}`);
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
          // 送った事にしてカレンダーへ（本番の送信の後と同じ syncContactPromiseCalendar）→ 行を読んで id で消す
          if (ver === "on" && typeof out.draft === "string" && !out.draft.startsWith("（")) {
            const { syncContactPromiseCalendar } = await import("../app/lib/contact-promise-server");
            const sentAt = new Date().toISOString();
            await syncContactPromiseCalendar({ conversationId: YUMA, text: out.draft, sentAt, delivered: false });
            const { data: cal } = await sb.from("calendar_events").select("id, title, start_at, event_type, notes").eq("conversation_id", YUMA).eq("is_done", false).like("notes", "【必ず】%【連絡日%").gte("created_at", new Date(Date.now() - 120_000).toISOString());
            out.calendar = cal ?? [];
            console.log(`   カレンダー: ${JSON.stringify((cal ?? []).map((r) => ({ title: r.title, start_at: r.start_at, type: r.event_type, head: String(r.notes ?? "").split("\n")[0] })))}`);
            if (cal?.length) await sb.from("calendar_events").delete().in("id", cal.map((r) => r.id));
          }
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
