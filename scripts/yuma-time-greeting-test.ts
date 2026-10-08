// scripts/yuma-time-greeting-test.ts — 2026-10-08 竹内さん（り 8f705d16「こんばんは。この時間に送るのおかしい」「お客さんに送る挨拶は『お世話になっております』」）
//   お客様が時刻の挨拶（こんばんは／こんにちは）で始めた番の下書きを、YUMA のブレイン＋下書き（generate-reply の POST を同じプロセスで呼ぶ）で前後に並べる。
//   前＝TIME_GREETING_R11=off（旧）／後＝既定。今日こちらが送ったのは資料文（🌟カード）だけ＝挨拶の決定は standard（今日はじめての会話文）。
//   手順書 memory/test_protocol_brain.md どおり（YUMA だけ・共通の入口・未来の時刻・線（floor）で YUMA の過去を読まない・自分の行だけ id で消す）。
// 実行: REPLAY_FLOOR_FILE=<floor> LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-time-greeting-test.ts --floor=<floor> [回数=1] [場面,..] [--versions=base,new]
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
import { MSG_SEP } from "../app/lib/reply-context";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").slice(k.length + 3) || d;
const VERSIONS = arg("versions", "base,new").split(",");
const OUT = arg("out", "scripts/.replay-out/time-greeting.jsonl");
const FLOOR_FILE = arg("floor");
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const PREFIX = "tgr-";
const BASE_ENV: Record<string, string> = { TIME_GREETING_R11: "off" };
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const own = { msg: [] as string[] };
type Row = { s: "staff" | "customer"; t: string; sec: number; img?: string; aix?: boolean };
const card = (name: string, room: string): Row[] => [
  { s: "staff", t: "[画像]", sec: 0, img: "p1", aix: true },
  { s: "staff", t: `🌟${name} ${room}号室\n\n1件新着でYUMAさんにかなりオススメ出来るお部屋が募集に出ました！！\n\nお手隙の際にご査収ください😌！！`, sec: 1, aix: true },
];
const SCENES: Record<string, Row[]> = {
  // 実物（り 10/07 20:40）の文のまま・物件名は本番の会話の物
  konbanwa: [...card("サンライト阿倍野8", "202"), { s: "customer", t: "こんばんは！\n\nサンライト阿倍野8\nの202は\n子ども不可ですか？", sec: 3600 }],
  // 実物の「子ども不可ですか」は手本の選びで記入済みの申込フォームを含む手本が当たり、テストの歯止め（個人の値）で止まる＝同じ形でペットに替えた場面
  konbanwa_pet: [...card("サンライト阿倍野8", "202"), { s: "customer", t: "こんばんは！\n\nサンライト阿倍野8\nの202は\nペット不可ですか？", sec: 3600 }],
  konnichiwa: [...card("サンライト阿倍野8", "202"), { s: "customer", t: "こんにちは！\nここってペット飼えますか？", sec: 3600 }],
};
const TIME_RE = /こんばんは|こんばんわ|こんにちは|こんにちわ|おはよう/;

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
  own.msg = [];
}

async function main() {
  if (!process.env.REPLAY_FLOOR_FILE || process.env.REPLAY_FLOOR_FILE.replace(/\\/g, "/") !== FLOOR_FILE.replace(/\\/g, "/")) throw new Error("REPLAY_FLOOR_FILE と --floor を同じにする（YUMA の過去の記録を読まないため）");
  const reps = Math.max(1, Number(ARGS[0] ?? 1));
  const which = (ARGS[1] ?? Object.keys(SCENES).join(",")).split(",");
  h = await setupLlmTest("yuma-time-greeting-test");
  h.assertYuma(YUMA);
  const { analyzeConversation } = await import("../app/lib/brain-core");
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  const { POST } = await import("../app/api/generate-reply/route");
  for (const name of which) {
    const rows = SCENES[name];
    if (!rows) { console.warn(`場面なし: ${name}`); continue; }
    h.assertSceneSafe(rows.map((r) => r.t), name);
    for (let k = 0; k < reps; k++) for (const ver of VERSIONS) {
      await h.waitUntilYumaQuiet(own.msg);
      const last = Math.max(...rows.map((r) => r.sec));
      const t0 = Date.now() + 120_000 - last * 1000;
      const at = (sec: number) => new Date(t0 + sec * 1000).toISOString();
      const runId = randomUUID().slice(0, 8);
      const url = (x: string) => `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/property-images/test/${PREFIX}${runId}-${x}.jpg`;
      const out: Record<string, unknown> = { scene: name, ver, rep: k + 1 };
      const prev = Object.fromEntries(Object.keys(BASE_ENV).map((key) => [key, process.env[key]]));
      try {
        const ins = await sb.from("messages").insert(rows.map((r, i) => ({ conversation_id: YUMA, sender: r.s, text: r.t, is_aix_generated: !!r.aix, created_at: at(r.sec), line_message_id: `${PREFIX}${runId}-${i}`, image_url: r.img ? url(r.img) : null }))).select("id");
        if (ins.error) throw new Error(ins.error.message);
        own.msg.push(...(ins.data ?? []).map((x) => x.id as string));
        writeFloor(new Date(t0 - 5_000).toISOString());
        await new Promise((r) => setTimeout(r, 1300));
        for (const [key, v] of Object.entries(BASE_ENV)) { if (ver === "base") process.env[key] = v; else delete process.env[key]; }
        h.assertYuma(YUMA, "brain");
        const meta = await runInDeepseekScope(async () => {
          setDeepseekScope({ conversationId: YUMA, mark: { kind: "all" } });
          return analyzeConversation(YUMA, true, "proposing", null, "brain", { autoSendEnabled: true, customerName: "YUMA", prevPhase: null, prevAix: null, mode: "full", layer: "combined", strategy: null });
        }) as unknown as Record<string, unknown> | null;
        Object.assign(out, { action: meta?.action ?? null, reply_mode: meta?.reply_mode ?? null });
        if (meta) {
          const lastStaff = rows.map((r) => r.s).lastIndexOf("staff");
          const cust = rows.slice(lastStaff + 1).filter((r) => r.s === "customer").map((r) => r.t);
          const body = {
            message: cust.join(MSG_SEP), customerMessages: cust, state: "proposing", conversationId: YUMA, customerName: "YUMA", hasViewed: false, activeTaskTypes: [], hasStaffReplied: true,
            recentMessages: rows.map((r) => ({ sender: r.s, text: r.t, createdAt: at(r.sec), isAix: !!r.aix })),
            brainMetaDirect: { meta: { ...meta, reply_mode: meta.reply_mode === "aix" ? "reply" : meta.reply_mode }, customerName: "YUMA", conversationDirection: (meta.conversation_direction as Record<string, unknown> | undefined) ?? null, brainAnalyzedAt: new Date().toISOString() },
            shadowNoWrite: true, testSceneMaterials: "on",
          };
          const res = await POST(new Request("http://localhost/api/generate-reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never) as Response;
          const ct = res.headers.get("content-type") ?? "";
          const draft = ct.includes("application/json") ? `（下書きなし: ${JSON.stringify(await res.json().catch(() => ({}))).slice(0, 160)}）` : parseStream(await res.text());
          out.draft = draft;
          out.timeGreeting = TIME_RE.test(draft.split("\n").slice(0, 2).join("\n"));
          out.osewa = /お世話になっております/.test(draft.split("\n").slice(0, 2).join("\n"));
          console.log(`\n[${name} ${ver} ${k + 1}] action=${meta.action ?? "-"} reply_mode=${meta.reply_mode ?? "-"} 時刻の挨拶=${out.timeGreeting} お世話=${out.osewa}\n   下書き: ${draft.replace(/\n/g, "⏎")}`);
        }
      } catch (e) { out.error = e instanceof Error ? e.message : String(e); console.error(`   失敗: ${out.error}`); }
      finally {
        for (const [key, v] of Object.entries(prev)) { if (v === undefined) delete process.env[key]; else process.env[key] = v; }
        writeFloor(null);
        await cleanup();
      }
      appendFileSync(OUT, JSON.stringify(out) + "\n");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { writeFloor(null); try { await cleanup(); } catch (e) { console.error("片付け失敗", e); } if (h) await h.finish(); setTimeout(() => process.exit(process.exitCode ?? 0), 800); });
