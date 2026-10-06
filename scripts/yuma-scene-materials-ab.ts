// scripts/yuma-scene-materials-ab.ts — 2巡目（10/07）: 本番の過去の番を YUMA で生成し直し、場面ごとの材料の取捨 あり／なし を同じブレインの判断で比べる
//   手順書 memory/test_protocol_brain.md どおり: YUMA だけ・共通の入口・未来の時刻・申込の書類の手前で切る・名前は YUMA・自分の行だけ消す
//   ブレインは1番につき1回（--brain-cache に保存して次の巡で使い回す＝揺れと費用を減らす）。下書きは開発サーバの /api/generate-reply（shadowNoWrite）
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-scene-materials-ab.ts --base=http://localhost:3471 --floor=<floor.json>
//        [--per=4] [--variants=off,on] [--label=r1] [--brain-cache=<file>] [--only=<id,..>] [--scenes=ack,question]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
import { requireTestServer } from "./lib/dev-server-test-guard";
// replay-scenarios-mine.ts の maskText / addressNamesOf の写し（あのファイルは import すると main が走る）
const URL_OR_PHONE_RE = /https?:\/\/[^\s　]+|0\d{1,4}[-ー－]?\d{1,4}[-ー－]?\d{3,4}/g;
const MAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const NOT_NAME = /^(?:お客|皆|旦那|奥|管理会社|担当|YUMA|同居人|オーナー|業者|大家|貸主|保証会社|ご主人|主人|彼女|彼氏|お子|弟|妹|兄|姉|母|父|ご両親|親御|内覧担当|鈴木|管理人|みな$)/;
function addressNamesOf(staffTexts: ReadonlyArray<string>): string[] {
  const out = new Set<string>();
  for (const t of staffTexts) for (const m of String(t ?? "").matchAll(/(?:^|\n|、|。|！|\s|\/)([^\s\n、。！!?？「」()（）・/]{1,10}?)(?:さん|様)(?=\n|に|の|が|お|ご|達|、|！|😊|😌|$|\s)/g)) {
    const nm = m[1];
    if (!NOT_NAME.test(nm) && !/[0-9０-９]/.test(nm)) out.add(nm);
  }
  return [...out];
}
function maskText(t: string, customerName: string | null, extraNames: ReadonlyArray<string> = []): string {
  let s = String(t ?? "");
  const names = new Set<string>();
  const n = (customerName ?? "").trim();
  if (n.length >= 2) { names.add(n); for (const p of n.split(/[\s　]+/)) if (p.length >= 2) names.add(p); }
  for (const x of extraNames) if (x) names.add(x);
  for (const nm of [...names].sort((a, b) => b.length - a.length)) {
    s = s.split(`${nm}さん`).join("YUMAさん").split(`${nm}様`).join("YUMA様");
    if (nm.length >= 2) s = s.split(nm).join("YUMA");
  }
  s = s.replace(/[^\s、。！!]{2,8}(様|さん)から(ご)?紹介/g, "ご紹介者様から$2紹介");
  s = s.replace(/^([^\n]{1,14}?)(さん|様)(\n)/, "YUMA$2$3");
  return s.replace(URL_OR_PHONE_RE, (m) => (/^https?:/.test(m) ? m : "（電話番号）")).replace(MAIL_RE, "yuma@example.com");
}
import { isTestConversation } from "../app/lib/test-conversations";
import { MSG_SEP } from "../app/lib/reply-context";
import { resolveReplyScene, type ReplyScene } from "../app/lib/reply-scene";

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const BASE = arg("base", "http://localhost:3471");
const FLOOR_FILE = arg("floor", "");
const PER = Number(arg("per", "4"));
const VARIANTS = arg("variants", "off,on").split(",").filter(Boolean);
const REPS = Math.max(1, Number(arg("reps", "1")));
const LABEL = arg("label", "r");
const BRAIN_CACHE = arg("brain-cache", "");
const ONLY = arg("only").split(",").filter(Boolean);
const SCENES = arg("scenes").split(",").filter(Boolean);
const OUT = arg("out", `scripts/.replay-out/r2-${LABEL}.jsonl`);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const PREFIX = "r2scene-";
let h: LlmTestHarness | null = null;
let own: string[] = [];

type Ex = { id: string; conversation_id: string; created_at: string; sent_at: string | null; customer_message: string | null; ai_draft: string | null; sent_reply: string | null };
type Msg = { id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };

function writeFloor(floor: string | null) {
  if (!FLOOR_FILE) return;
  writeFileSync(FLOOR_FILE, JSON.stringify(floor ? { conversationId: YUMA, floor, status: "proposing", messageIdPrefix: PREFIX } : {}));
}

async function pickTurns(): Promise<Array<Ex & { scene: ReplyScene; customerName: string | null }>> {
  const since = "2026-09-07T00:00:00Z";
  const { data, error } = await sb.from("ai_reply_examples").select("id, conversation_id, created_at, sent_at, customer_message, ai_draft, sent_reply")
    .eq("entry_source", "line_reply").gte("created_at", since).not("ai_draft", "is", null).not("sent_reply", "is", null).order("created_at", { ascending: false }).limit(1000);
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as Ex[]).filter((r) => !isTestConversation(r.conversation_id) && (r.ai_draft ?? "").trim().length > 5 && !/^__|\[AIX誘導中\]/.test((r.ai_draft ?? "").trim()) && (r.sent_reply ?? "").trim().length > 1);
  const convIds = [...new Set(rows.map((r) => r.conversation_id))];
  const convs = new Map<string, { customer_name: string | null; status: string | null }>();
  const applied = new Map<string, string>();
  for (let i = 0; i < convIds.length; i += 100) {
    const ch = convIds.slice(i, i + 100);
    const c = await sb.from("conversations").select("id, customer_name, status").in("id", ch);
    for (const x of (c.data ?? []) as Array<{ id: string; customer_name: string | null; status: string | null }>) convs.set(x.id, x);
    const a = await sb.from("aix_usage_logs").select("conversation_id, created_at").in("conversation_id", ch).eq("aix_type", "application_push").order("created_at");
    for (const x of (a.data ?? []) as Array<{ conversation_id: string; created_at: string }>) if (!applied.has(x.conversation_id)) applied.set(x.conversation_id, x.created_at);
  }
  const out: Array<Ex & { scene: ReplyScene; customerName: string | null }> = [];
  const count = new Map<string, number>();
  const perConv = new Map<string, number>();
  for (const r of rows) {
    if (ONLY.length && !ONLY.includes(r.id.slice(0, 8))) continue;
    const ap = applied.get(r.conversation_id);
    if (ap && Date.parse(ap) <= Date.parse(r.created_at)) continue; // 申込以降は対象外
    const sc = resolveReplyScene({ customerText: r.customer_message ?? "" }).scene;
    if (SCENES.length && !SCENES.includes(sc)) continue;
    if (!ONLY.length && (count.get(sc) ?? 0) >= PER) continue;
    if ((perConv.get(r.conversation_id) ?? 0) >= 1 && !ONLY.length) continue; // 1会話1番（偏りを避ける）
    count.set(sc, (count.get(sc) ?? 0) + 1); perConv.set(r.conversation_id, 1);
    out.push({ ...r, scene: sc, customerName: convs.get(r.conversation_id)?.customer_name ?? null });
  }
  return out;
}

/** 番の材料: その返信の前のお客様の連投＋前の 29 通（申込の書類の手前で切る・伏せる） */
async function buildScene(t: Ex & { customerName: string | null }) {
  const until = t.sent_at ?? t.created_at;
  const { data } = await sb.from("messages").select("id, sender, text, created_at, is_aix_generated").eq("conversation_id", t.conversation_id).lt("created_at", until).order("created_at", { ascending: false }).limit(60);
  const ms = ((data ?? []) as Msg[]).reverse();
  // 最後のお客様の連投
  let end = ms.length - 1;
  while (end >= 0 && ms[end].sender !== "customer") end--;
  if (end < 0) return null;
  let start = end;
  while (start - 1 >= 0 && ms[start - 1].sender === "customer") start--;
  const ctx = ms.slice(Math.max(0, start - 29), start);
  const cust = ms.slice(start, end + 1);
  const cut = h!.cutBeforeApplicationMaterial([...ctx, ...cust]);
  if (cut.cutAt !== null && cut.cutAt < ctx.length + cust.length) return null; // 書類が出た番は使わない
  const nm = addressNamesOf(ms.filter((x) => x.sender !== "customer").map((x) => x.text ?? ""));
  const mask = (s: string | null) => maskText(s ?? "", t.customerName, nm);
  return {
    context: ctx.map((m) => ({ s: m.sender === "customer" ? "customer" : "staff", t: mask(m.text), aix: !!m.is_aix_generated })),
    customer: cust.map((m) => mask(m.text)).filter((x) => x.trim()),
    staff: mask(t.sent_reply), prodDraft: mask(t.ai_draft),
  };
}

function parseStream(raw: string): string {
  let body = String(raw ?? "");
  const nl = body.indexOf("\n");
  if (nl >= 0) { try { const j = JSON.parse(body.slice(0, nl)); if (j && typeof j === "object") body = body.slice(nl + 1); } catch { /* */ } }
  return body.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
}

async function main() {
  h = await setupLlmTest("r2-scene-ab");
  await requireTestServer(BASE, "r2-scene-ab");
  const analyzeConversation = (await import("../app/lib/brain-core")).analyzeConversation;
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  const cache: Record<string, Record<string, unknown>> = BRAIN_CACHE && existsSync(BRAIN_CACHE) ? JSON.parse(readFileSync(BRAIN_CACHE, "utf8")) : {};
  const turns = await pickTurns();
  console.log(`番 ${turns.length}: ${[...new Set(turns.map((t) => t.scene))].map((s) => `${s}=${turns.filter((t) => t.scene === s).length}`).join(" ")}`);
  writeFileSync(OUT, "");
  for (const t of turns) {
    const rec: Record<string, unknown> = { id: t.id.slice(0, 8), conv: t.conversation_id.slice(0, 8), at: t.created_at, scene: t.scene };
    try {
      const sc = await buildScene(t);
      if (!sc || !sc.customer.length) { rec.skip = "材料なし/書類"; appendFileSync(OUT, JSON.stringify(rec) + "\n"); continue; }
      h.assertSceneSafe([...sc.context.map((m) => m.t), ...sc.customer], rec.id as string);
      rec.customer = sc.customer; rec.staff = sc.staff; rec.prod = sc.prodDraft;
      await h.waitUntilYumaQuiet(own);
      const all = [...sc.context, ...sc.customer.map((x) => ({ s: "customer", t: x, aix: false }))];
      const times = h.sceneTimes(all.length, { stepSec: 90 });
      const ins = await sb.from("messages").insert(all.map((m, i) => ({ conversation_id: YUMA, sender: m.s, text: m.t || "[画像]", is_aix_generated: !!m.aix, line_message_id: `${PREFIX}${randomUUID()}`, created_at: times[i] }))).select("id");
      if (ins.error) throw new Error(ins.error.message);
      own = ((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id);
      writeFloor(new Date(Date.parse(times[0]) - 1000).toISOString());
      await new Promise((r) => setTimeout(r, 1300));
      let meta = cache[t.id];
      if (!meta) {
        h.assertYuma(YUMA, "brain");
        meta = await runInDeepseekScope(async () => { setDeepseekScope({ conversationId: YUMA, mark: { kind: "all" } }); return analyzeConversation(YUMA, true, "proposing", null, "brain", { autoSendEnabled: true, customerName: "YUMA", prevPhase: null, prevAix: null, mode: "full", layer: "combined", strategy: null }); }) as unknown as Record<string, unknown>;
        if (!meta) throw new Error("ブレインが null");
        cache[t.id] = meta;
        if (BRAIN_CACHE) writeFileSync(BRAIN_CACHE, JSON.stringify(cache));
      }
      rec.brain = { action: meta.action ?? null, reply_mode: meta.reply_mode ?? null, dir: String(meta.reply_direction ?? "").slice(0, 160) };
      const staffEngaged = sc.context.some((m) => m.s === "staff" && m.t.trim() && m.t.trim() !== "[画像]");
      const jobs = VARIANTS.flatMap((v) => Array.from({ length: REPS }, (_, rep) => ({ v, key: rep === 0 ? v : `${v}_${rep}` })));
      await Promise.all(jobs.map(async ({ v, key }) => {
        const body = {
          message: sc.customer.join(MSG_SEP), customerMessages: sc.customer, state: staffEngaged ? "proposing" : "first_reply", conversationId: YUMA, customerName: "YUMA",
          hasViewed: false, activeTaskTypes: [], hasStaffReplied: staffEngaged,
          recentMessages: all.slice(-25).map((m, i, arr) => ({ sender: m.s, text: m.t, createdAt: times[times.length - arr.length + i], isAix: !!m.aix })),
          brainMetaDirect: { meta, customerName: "YUMA", conversationDirection: (meta.conversation_direction as Record<string, unknown> | undefined) ?? null, brainAnalyzedAt: new Date().toISOString() },
          shadowNoWrite: true, testSceneMaterials: v, testExcludeReplyText: t.sent_reply ?? "",
        };
        const t0 = Date.now();
        const res = await fetch(`${BASE}/api/generate-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
        const ct = res.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) { const j = await res.json().catch(() => ({})) as Record<string, unknown>; rec[`draft_${key}`] = null; rec[`skip_${key}`] = String(j.reason ?? j.error ?? res.status); }
        else rec[`draft_${key}`] = parseStream(await res.text());
        rec[`ms_${key}`] = Date.now() - t0;
      }));
    } catch (e) { rec.error = e instanceof Error ? e.message : String(e); }
    finally {
      writeFloor(null);
      if (own.length) { await sb.from("messages").delete().in("id", own); own = []; }
    }
    appendFileSync(OUT, JSON.stringify(rec) + "\n");
    console.log(`${rec.id} [${rec.scene}] ${rec.error ?? rec.skip ?? `brain=${(rec.brain as { action?: string })?.action ?? "-"} ` + VARIANTS.map((v) => `${v}:${String(rec[`draft_${v}`] ?? rec[`skip_${v}`] ?? "").replace(/\n/g, "/").slice(0, 50)}`).join(" | ")}`);
  }
  console.log(`書き出し: ${OUT}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  writeFloor(null);
  if (own.length) await sb.from("messages").delete().in("id", own);
  if (h) await h.finish();
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
});
