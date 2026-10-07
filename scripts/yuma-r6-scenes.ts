// scripts/yuma-r6-scenes.ts — 6巡目（10/07）: 内覧の場面（退去予定か・日時の指定）を YUMA のブレイン（＋下書き）で前後に並べる
//   手順書 memory/test_protocol_brain.md どおり（YUMA だけ・共通の入口・未来の時刻・自分の行だけ id で消す）。
//   前＝5巡目の決め（VIEWING_CHECK_VACATING_ONLY=off・VIEWING_FIRST_DATE_INVITE=off）／後＝6巡目の既定。同じ場面を版ごとに reps 回。
//
// 場面（本番の会話の形を写す・名前は YUMA・画像は架空の URL）:
//   now          … 新着の物件（今見られる）→「こちら内覧希望です」→ 後: AIX【内覧調整】（内覧誘導）／前: 確認の約束
//   vacating     … 同じ物件が「10月31日退去予定のお部屋」→「こちら内覧希望です」→ 前後とも 内覧開始日の確認の約束（後は退去予定の文）
//   vacating_rec … 物件確認した（退去予定）の記録＋名前で「エスリード難波ザ・ブライト内覧したいです」→ 台帳の確認の結果で 確認の約束
//   dated_first  … 新着の物件 →「こちら10/12の14時から内覧希望です」（候補日の前の初めての指定）→ 後: AIX【内覧調整】／前: 待ち合わせ場所
//   dated_after  … AIX【内覧調整】で候補日を出した後に「10/12の14時でお願いします」→ 前後とも AIX【待ち合わせ場所】（段階の門は変わらない）
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-r6-scenes.ts [回数=1] [場面,..] [--versions=base,new] [--draft=http://localhost:3473]
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
import { requireTestServer } from "./lib/dev-server-test-guard";
import { MSG_SEP } from "../app/lib/reply-context";

const DRAFT_BASE = (process.argv.find((a) => a.startsWith("--draft=")) ?? "").slice(8);
const VERSIONS = ((process.argv.find((a) => a.startsWith("--versions=")) ?? "").slice(11) || "base,new").split(",");
const OUT = (process.argv.find((a) => a.startsWith("--out=")) ?? "").slice(6) || "scripts/.replay-out/r6-scenes.jsonl";
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const BASE_ENV: Record<string, string> = { VIEWING_CHECK_VACATING_ONLY: "off", VIEWING_FIRST_DATE_INVITE: "off" };
function parseStream(raw: string): string {
  let body = String(raw ?? "");
  const nl = body.indexOf("\n");
  if (nl >= 0) { try { const j = JSON.parse(body.slice(0, nl)); if (j && typeof j === "object") body = body.slice(nl + 1); } catch { /* */ } }
  return body.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const PREFIX = "r6sc-";
const own = { msg: [] as string[], sip: [] as string[], aix: [] as string[] };
type Row = { s: "staff" | "customer"; t: string; sec: number; img?: string; aix?: boolean };
type Scene = { rows: Row[]; sip: Array<{ img: string; name: string; room: string }>; aix: Array<{ sec: number; type: string; cp: string | null; names: string[]; sts: string[]; est: boolean; text: string }>; expect: Record<string, string> };

const OURS: Row[] = [
  { s: "staff", t: "[画像]", sec: 0, img: "ours", aix: true },
  { s: "staff", t: "🌟エスリード難波ザ・ブライト 1307号室\n\n新着でYUMAさんにかなりオススメ出来るお部屋となります！！\n家賃管理費込78,000円の1K、敷金礼金なしで初期費用をかなり抑えてご入居頂けます！！", sec: 1, aix: true },
  { s: "staff", t: "1件新着でYUMAさんにかなりオススメ出来るお部屋が募集に出ました！！\nお手隙の際にご査収ください😌！！", sec: 2, aix: true },
];
const OURS_V: Row[] = [
  OURS[0],
  { s: "staff", t: "🌟エスリード難波ザ・ブライト 1307号室\n\n新着でYUMAさんにかなりオススメ出来るお部屋となります！！\n10月31日退去予定のお部屋となります！！\n家賃管理費込78,000円の1K、敷金礼金なしで初期費用をかなり抑えてご入居頂けます！！", sec: 1, aix: true },
  OURS[2],
];
const SIP = [{ img: "ours", name: "エスリード難波ザ・ブライト", room: "1307" }];
function scene(name: string): Scene {
  if (name === "now") return { rows: [...OURS, { s: "customer", t: "こちら内覧希望です", sec: 3600 }], sip: SIP, aix: [], expect: { base: "返信（確認の約束 viewing_check）", new: "AIX viewing_invite（内覧誘導）" } };
  if (name === "vacating") return { rows: [...OURS_V, { s: "customer", t: "こちら内覧希望です", sec: 3600 }], sip: SIP, aix: [], expect: { base: "返信（確認の約束）", new: "返信（内覧開始日の確認の約束・退去予定）" } };
  if (name === "vacating_rec") return {
    rows: [...OURS,
      { s: "customer", t: "エスリード難波ザ・ブライトまだ空いてますか？", sec: 600 },
      { s: "staff", t: "YUMAさん\n確認させていただきました！！\nエスリード難波ザ・ブライト 1307号室現在募集中となります！！\n10月31日退去予定のお部屋となります！！", sec: 1800, aix: true },
      { s: "customer", t: "エスリード難波ザ・ブライト内覧したいです", sec: 3600 }],
    sip: SIP,
    aix: [{ sec: 1801, type: "property_check_result", cp: "available", names: ["エスリード難波ザ・ブライト 1307号室"], sts: ["vacating"], est: false, text: "確認させていただきました！！" }],
    expect: { base: "返信（確認の約束）", new: "返信（内覧開始日の確認の約束・台帳 退去予定）" },
  };
  if (name === "dated_first") return { rows: [...OURS, { s: "customer", t: "こちら10/12の14時から内覧希望です", sec: 3600 }], sip: SIP, aix: [], expect: { base: "AIX meeting_place（旧）か viewing_invite", new: "AIX viewing_invite（初めての指定も内覧調整）" } };
  return {
    rows: [...OURS, { s: "customer", t: "こちら内覧希望です", sec: 600 },
      { s: "staff", t: "かしこまりました😊！！\nお部屋ご案内させて頂きます！！\n直近ですと\n10/11(土) 13:00〜15:00\n10/12(日) 13:00〜16:00\n10/13(月) 11:00〜13:00\nにてご案内可能です！！\nご都合如何でしょうか😌！！", sec: 1200, aix: true },
      { s: "customer", t: "10/12の14時でお願いします", sec: 3600 }],
    sip: SIP,
    aix: [{ sec: 1201, type: "viewing_invite", cp: null, names: ["エスリード難波ザ・ブライト 1307号室"], sts: [], est: false, text: "かしこまりました😊！！" }],
    expect: { base: "AIX meeting_place", new: "AIX meeting_place（段階の門は同じ）" },
  };
}

let h: LlmTestHarness | null = null;
async function cleanup() {
  if (own.msg.length) await sb.from("messages").delete().in("id", own.msg);
  if (own.sip.length) await sb.from("sent_image_properties").delete().in("image_url", own.sip);
  if (own.aix.length) await sb.from("aix_usage_logs").delete().in("id", own.aix);
  own.msg = []; own.sip = []; own.aix = [];
}

async function main() {
  const reps = Math.max(1, Number(ARGS[0] ?? 1));
  const which = (ARGS[1] ?? "now,vacating,vacating_rec,dated_first,dated_after").split(",");
  h = await setupLlmTest("yuma-r6-scenes");
  h.assertYuma(YUMA);
  if (DRAFT_BASE) await requireTestServer(DRAFT_BASE, "yuma-r6-scenes");
  const { analyzeConversation } = await import("../app/lib/brain-core");
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  for (const name of which) {
    const sc = scene(name);
    h.assertSceneSafe(sc.rows.map((r) => r.t), name);
    for (let k = 0; k < reps; k++) for (const ver of VERSIONS) {
      await h.waitUntilYumaQuiet(own.msg);
      const last = Math.max(...sc.rows.map((r) => r.sec));
      const t0 = Date.now() + 120_000 - last * 1000; // 最後の通を今＋2分に
      const at = (sec: number) => new Date(t0 + sec * 1000).toISOString();
      const runId = randomUUID().slice(0, 8);
      const url = (x: string) => `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/property-images/test/${PREFIX}${runId}-${x}.jpg`;
      try {
        const ins = await sb.from("messages").insert(sc.rows.map((r, i) => ({ conversation_id: YUMA, sender: r.s, text: r.t, is_aix_generated: !!r.aix, created_at: at(r.sec), line_message_id: `${PREFIX}${runId}-${i}`, image_url: r.img ? url(r.img) : null }))).select("id");
        if (ins.error) throw new Error(ins.error.message);
        own.msg.push(...(ins.data ?? []).map((x) => x.id as string));
        if (sc.sip.length) {
          const r = await sb.from("sent_image_properties").insert(sc.sip.map((x) => ({ image_url: url(x.img), conversation_id: YUMA, property_name: x.name, room_no: x.room, source: "test", created_at: at(0) })));
          if (r.error) throw new Error(r.error.message);
          own.sip.push(...sc.sip.map((x) => url(x.img)));
        }
        if (sc.aix.length) {
          const ax = await sb.from("aix_usage_logs").insert(sc.aix.map((a) => ({ conversation_id: YUMA, aix_type: a.type, check_pattern: a.cp, property_names: a.names, prop_statuses: a.sts, estimate_sent: a.est, generated_text: a.text, created_at: at(a.sec), sent_at: at(a.sec) }))).select("id");
          if (ax.error) throw new Error(ax.error.message);
          own.aix.push(...(ax.data ?? []).map((x) => x.id as string));
        }
        const prev = Object.fromEntries(Object.keys(BASE_ENV).map((key) => [key, process.env[key]]));
        for (const [key, v] of Object.entries(BASE_ENV)) { if (ver === "base") process.env[key] = v; else delete process.env[key]; }
        let meta: Record<string, unknown> | null = null;
        try {
          meta = await runInDeepseekScope(async () => {
            setDeepseekScope({ conversationId: YUMA, mark: { kind: "all" } });
            return analyzeConversation(YUMA, true, "proposing", null, "brain", { autoSendEnabled: true, customerName: "YUMA", prevPhase: null, prevAix: null, mode: "full" });
          }) as unknown as Record<string, unknown> | null;
        } finally { for (const [key, v] of Object.entries(prev)) { if (v === undefined) delete process.env[key]; else process.env[key] = v; } }
        const src = (meta?.decision_source as string | undefined) ?? (meta?.decision_source_no_aix as string | undefined) ?? "-";
        const rec: Record<string, unknown> = { scene: name, ver, rep: k + 1, action: meta?.action ?? null, cp: meta?.check_pattern ?? null, reply_mode: meta?.reply_mode ?? null, src, dir: String(meta?.reply_direction ?? "").slice(0, 400) };
        console.log(`\n[${name} ${ver} ${k + 1}] 期待: ${sc.expect[ver] ?? "-"}\n   action=${meta?.action ?? "-"}${meta?.check_pattern ? `/${meta.check_pattern}` : ""} reply_mode=${meta?.reply_mode ?? "-"} src=${src}\n   方向: ${String(meta?.reply_direction ?? "").replace(/\n/g, " ").slice(0, 260)}`);
        if (DRAFT_BASE && meta && meta.reply_mode !== "aix") {
          const lastStaff = sc.rows.map((r) => r.s).lastIndexOf("staff");
          const cust = sc.rows.slice(lastStaff + 1).filter((r) => r.s === "customer").map((r) => r.t);
          const body = { message: cust.join(MSG_SEP), customerMessages: cust, state: "proposing", conversationId: YUMA, customerName: "YUMA", hasViewed: false, activeTaskTypes: [], hasStaffReplied: true,
            recentMessages: sc.rows.map((r) => ({ sender: r.s, text: r.t, createdAt: at(r.sec), isAix: !!r.aix })),
            brainMetaDirect: { meta, customerName: "YUMA", conversationDirection: (meta.conversation_direction as Record<string, unknown> | undefined) ?? null, brainAnalyzedAt: new Date().toISOString() },
            shadowNoWrite: true };
          const res = await fetch(`${DRAFT_BASE}/api/generate-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
          const ct = res.headers.get("content-type") ?? "";
          const draft = ct.includes("application/json") ? `（下書きなし: ${JSON.stringify(await res.json().catch(() => ({}))).slice(0, 160)}）` : parseStream(await res.text());
          rec.draft = draft;
          console.log(`   下書き: ${draft.replace(/\n/g, " ／ ")}`);
        }
        appendFileSync(OUT, JSON.stringify(rec) + "\n");
      } finally { await cleanup(); }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { try { await cleanup(); } catch (e) { console.error("片付け失敗", e); } if (h) await h.finish(); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
