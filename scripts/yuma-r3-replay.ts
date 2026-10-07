// scripts/yuma-r3-replay.ts — 返信の質の3巡目（10/07）: 本番の過去の番を YUMA で作り直し、ブレインの道（返信か AIX か）と下書きの文を
//   スタッフの実際（手打ち／押した AIX）と比べる。変える物（ブレインの直し・扉の1文・物件検索ブレインの材料・会社のルールの場面の絞り）を番ごとに on/off で並べる。
//   手順書 memory/test_protocol_brain.md どおり: YUMA だけ・共通の入口・未来の時刻・申込の書類の手前で切る・名前は YUMA・自分の行だけ消す。
//   2巡目の yuma-scene-materials-ab.ts からの違い:
//     ①お客様の登録の条件を YUMA の条件の行に一時的に写す（場面のお客様の条件でブレイン・物件検索ブレインが動く・終わったら戻す）
//     ②スタッフが AIX を押した番も流す（--src=path:<audit-path-gap-by-scene の jsonl>）＝道の一致を測る
//     ③ブレインの版（--brains=base,new・base は TWO_STAGE_ACK_WAIT=off）④下書きの版（--drafts=名前:旗=on+旗=off,…・generate-reply の testFlags）
//     ⑤テストの時計（TEST_CLOCK_JST_HOUR=14 を本スクリプトと開発サーバの両方に付ける＝営業時間外の指示を入れない・竹内さん 10/07）
// 実行: TEST_CLOCK_JST_HOUR=14 REPLAY_FLOOR_FILE=<floor> LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-r3-replay.ts \
//        --base=http://localhost:3473 --floor=<floor> --src=examples|path:<jsonl> [--per=4] [--scenes=ack,considering] [--brains=new] \
//        [--drafts=A:considering_door=off,B:considering_door=on] [--reps=1] [--label=r3a] [--brain-cache=<file>] [--only=<id8,..>] [--no-draft]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
import { requireTestServer } from "./lib/dev-server-test-guard";
import { isTestConversation } from "../app/lib/test-conversations";
import { MSG_SEP } from "../app/lib/reply-context";
import { resolveReplyScene, type ReplyScene } from "../app/lib/reply-scene";

// yuma-scene-materials-ab.ts と同じ伏せ方（あのファイルは import すると main が走る）
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

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const BASE = arg("base", "http://localhost:3473");
const FLOOR_FILE = arg("floor", "");
const SRC = arg("src", "examples");
const PER = Number(arg("per", "4"));
const SCENES = arg("scenes").split(",").filter(Boolean);
const ONLY = arg("only").split(",").filter(Boolean);
const CONVS = arg("convs").split(",").filter(Boolean);
const PER_CONV = Math.max(1, Number(arg("per-conv", "1")));
const SINCE = arg("since", "2026-09-07T00:00:00Z");
const BRAINS = arg("brains", "new").split(",").filter(Boolean);
const DRAFT_BRAIN = arg("draft-brain", BRAINS[BRAINS.length - 1]);
const DRAFTS = arg("drafts", "A:").split(",").filter(Boolean).map((d) => {
  const [name, flags = ""] = d.split(":");
  return { name, flags: Object.fromEntries(flags.split("+").filter(Boolean).map((f) => f.split("="))) as Record<string, string> };
});
const REPS = Math.max(1, Number(arg("reps", "1")));
const BRAIN_REPS = Math.max(1, Number(arg("brain-reps", "1")));
const NO_DRAFT = args.includes("--no-draft");
const LABEL = arg("label", "r3");
const BRAIN_CACHE = arg("brain-cache", "");
const OUT = arg("out", `scripts/.replay-out/r3-${LABEL}.jsonl`);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const PREFIX = "r3scene-";
const PC_BACKUP = arg("pc-backup", "scripts/.replay-out/.r3-yuma-pc-backup.json");
const GAP_MS = Number(arg("gap-ms", "3000")); // 10/07 本番 DB が止まった → 番と番の間を空ける・ブレインと下書きは1本ずつ
const PC_FIELDS = ["desired_area", "floor_plan", "rent_min", "rent_max", "move_in_time", "preferences", "ng_points", "walk_minutes", "pet", "floor_area_min", "floor_area_max", "commute_station", "commute_minutes", "area_mode", "initial_cost_limit", "building_age", "other_requests", "occupants", "property_send_count", "last_property_sent_at", "ai_summary", "ai_summary_json", "ai_summary_at", "personality_profile"] as const;
const PC_BLANK = new Set(["ai_summary", "ai_summary_json", "ai_summary_at", "personality_profile"]); // 場面のお客様の要約は写さない（名前・個人の値が入りうる）
let h: LlmTestHarness | null = null;
let own: string[] = [];
let pcRestore: { id: string; row: Record<string, unknown> } | null = null;

type Turn = { key: string; conversation_id: string; at: string; scene: ReplyScene; staffPath: string[]; staffCp?: string[]; staffText: string; convStatus: string | null };
type Msg = { id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };

function writeFloor(floor: string | null, status = "proposing") {
  if (!FLOOR_FILE) return;
  writeFileSync(FLOOR_FILE, JSON.stringify(floor ? { conversationId: YUMA, floor, status, messageIdPrefix: PREFIX, keepPropertyCustomer: true } : {}));
}

async function pickTurns(): Promise<Turn[]> {
  const out: Turn[] = [];
  const count = new Map<string, number>();
  const perConv = new Map<string, number>();
  const take = (t: Turn) => {
    if (ONLY.length && !ONLY.includes(t.key)) return;
    if (CONVS.length && !CONVS.some((c) => t.conversation_id.startsWith(c))) return;
    if (SCENES.length && !SCENES.includes(t.scene)) return;
    if (!ONLY.length && (count.get(t.scene) ?? 0) >= PER) return;
    if (!ONLY.length && (perConv.get(t.conversation_id) ?? 0) >= PER_CONV) return;
    count.set(t.scene, (count.get(t.scene) ?? 0) + 1); perConv.set(t.conversation_id, (perConv.get(t.conversation_id) ?? 0) + 1); out.push(t);
  };
  if (SRC.startsWith("path:")) {
    const rows = readFileSync(SRC.slice(5), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { conv: string; at: string; scene: ReplyScene; staff: string[]; staffCp?: string[]; staffText: string });
    // 新しい番から（10/03〜の2段の後の判断を先に）
    for (const r of rows.sort((a, b) => (a.at < b.at ? 1 : -1))) take({ key: `${r.conv.slice(0, 8)}${r.at.slice(11, 16).replace(":", "")}`, conversation_id: r.conv, at: r.at, scene: r.scene, staffPath: r.staff, staffCp: r.staffCp ?? [], staffText: r.staffText, convStatus: null });
    return out;
  }
  const { data, error } = await sb.from("ai_reply_examples").select("id, conversation_id, created_at, sent_at, customer_message, ai_draft, sent_reply")
    .eq("entry_source", "line_reply").gte("created_at", SINCE).not("ai_draft", "is", null).not("sent_reply", "is", null).order("created_at", { ascending: false }).limit(1000);
  if (error) throw new Error(error.message);
  type Ex = { id: string; conversation_id: string; created_at: string; sent_at: string | null; customer_message: string | null; ai_draft: string | null; sent_reply: string | null };
  const rows = ((data ?? []) as Ex[]).filter((r) => !isTestConversation(r.conversation_id) && (r.ai_draft ?? "").trim().length > 5 && !/^__|\[AIX誘導中\]/.test((r.ai_draft ?? "").trim()) && (r.sent_reply ?? "").trim().length > 1);
  const applied = new Map<string, string>();
  const ids = [...new Set(rows.map((r) => r.conversation_id))];
  for (let i = 0; i < ids.length; i += 100) {
    const a = await sb.from("aix_usage_logs").select("conversation_id, created_at").in("conversation_id", ids.slice(i, i + 100)).eq("aix_type", "application_push").order("created_at");
    for (const x of (a.data ?? []) as Array<{ conversation_id: string; created_at: string }>) if (!applied.has(x.conversation_id)) applied.set(x.conversation_id, x.created_at);
  }
  for (const r of rows) {
    const ap = applied.get(r.conversation_id);
    if (ap && Date.parse(ap) <= Date.parse(r.created_at)) continue;
    // 番の時刻＝お客様の最後の発言（スタッフの送信の前）。送信時刻より前のお客様の発言を後で読む
    take({ key: r.id.slice(0, 8), conversation_id: r.conversation_id, at: r.sent_at ?? r.created_at, scene: resolveReplyScene({ customerText: r.customer_message ?? "" }).scene, staffPath: ["reply"], staffText: r.sent_reply ?? "", convStatus: null });
  }
  return out;
}

/** 番の材料: お客様の連投（at まで）＋前の 29 通（申込の書類の手前で切る・伏せる）。path の番は at＝分析した発言の時刻（含む） */
async function buildScene(t: Turn, customerName: string | null) {
  const isPath = SRC.startsWith("path:");
  const q = sb.from("messages").select("id, sender, text, created_at, is_aix_generated").eq("conversation_id", t.conversation_id).order("created_at", { ascending: false }).limit(60);
  const { data } = await (isPath ? q.lte("created_at", t.at) : q.lt("created_at", t.at));
  const ms = ((data ?? []) as Msg[]).reverse();
  let end = ms.length - 1;
  while (end >= 0 && ms[end].sender !== "customer") end--;
  if (end < 0) return null;
  let start = end;
  while (start - 1 >= 0 && ms[start - 1].sender === "customer") start--;
  const ctx = ms.slice(Math.max(0, start - 29), start);
  const cust = ms.slice(start, end + 1);
  const cut = h!.cutBeforeApplicationMaterial([...ctx, ...cust]);
  if (cut.cutAt !== null && cut.cutAt < ctx.length + cust.length) return null;
  const nm = addressNamesOf(ms.filter((x) => x.sender !== "customer").map((x) => x.text ?? ""));
  const mask = (s: string | null) => maskText(s ?? "", customerName, nm);
  return {
    context: ctx.map((m) => ({ s: m.sender === "customer" ? "customer" : "staff", t: mask(m.text), aix: !!m.is_aix_generated })),
    customer: cust.map((m) => mask(m.text)).filter((x) => x.trim()),
    staff: mask(t.staffText), nm,
  };
}

async function yumaPcId(): Promise<string> {
  const { data } = await sb.from("conversations").select("property_customer_id").eq("id", YUMA).maybeSingle();
  const id = (data?.property_customer_id as string | null) ?? null;
  if (!id) throw new Error("YUMA の条件の行が無い");
  return id;
}
/** 場面のお客様の登録の条件を YUMA の条件の行に写す（最初の1回だけ元の行を控える） */
async function copyPc(srcConv: string, yumaPc: string): Promise<boolean> {
  if (!pcRestore) {
    const { data } = await sb.from("property_customers").select(PC_FIELDS.join(", ")).eq("id", yumaPc).maybeSingle();
    pcRestore = { id: yumaPc, row: (data ?? {}) as unknown as Record<string, unknown> };
    // 10/07: 途中で止めると（taskkill）元の行がメモリごと消えた → 写す前にファイルにも控える（次の起動で残っていれば先に戻す）
    writeFileSync(PC_BACKUP, JSON.stringify(pcRestore));
  }
  const { data: c } = await sb.from("conversations").select("property_customer_id").eq("id", srcConv).maybeSingle();
  const srcPc = (c?.property_customer_id as string | null) ?? null;
  let src: Record<string, unknown> = {};
  if (srcPc) src = (((await sb.from("property_customers").select(PC_FIELDS.join(", ")).eq("id", srcPc).maybeSingle()).data ?? {}) as unknown) as Record<string, unknown>;
  const patch = Object.fromEntries(PC_FIELDS.map((k) => [k, PC_BLANK.has(k) ? null : (src[k] ?? null)]));
  const { error } = await sb.from("property_customers").update(patch).eq("id", yumaPc);
  if (error) throw new Error(`条件の行の写し: ${error.message}`);
  return !!srcPc;
}
async function restorePc() {
  if (!pcRestore) return;
  const r = await sb.from("property_customers").update(pcRestore.row).eq("id", pcRestore.id);
  if (r.error) { console.error(`⛔ YUMA の条件の行を戻せない（控え ${PC_BACKUP} に残す）: ${r.error.message}`); return; }
  try { writeFileSync(PC_BACKUP, ""); } catch { /* */ }
  console.log("=== YUMA の条件の行を元に戻した ===");
  pcRestore = null;
}

function parseStream(raw: string): string {
  let body = String(raw ?? "");
  const nl = body.indexOf("\n");
  if (nl >= 0) { try { const j = JSON.parse(body.slice(0, nl)); if (j && typeof j === "object") body = body.slice(nl + 1); } catch { /* */ } }
  return body.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
}

async function main() {
  if (!process.env.TEST_CLOCK_JST_HOUR) console.warn("⚠ TEST_CLOCK_JST_HOUR が無い＝今の時刻で流す（夜中は営業時間外の指示が入る）");
  if (!process.env.REPLAY_FLOOR_FILE || process.env.REPLAY_FLOOR_FILE.replace(/\\/g, "/") !== FLOOR_FILE.replace(/\\/g, "/")) console.warn("⚠ REPLAY_FLOOR_FILE（このスクリプトのブレインが読む線）と --floor が違う");
  h = await setupLlmTest("r3-replay");
  if (!NO_DRAFT) await requireTestServer(BASE, "r3-replay");
  const analyzeConversation = (await import("../app/lib/brain-core")).analyzeConversation;
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  const cache: Record<string, Record<string, unknown>> = BRAIN_CACHE && existsSync(BRAIN_CACHE) ? JSON.parse(readFileSync(BRAIN_CACHE, "utf8")) : {};
  const turns = await pickTurns();
  console.log(`番 ${turns.length}: ${[...new Set(turns.map((t) => t.scene))].map((s) => `${s}=${turns.filter((t) => t.scene === s).length}`).join(" ")}`);
  const yumaPc = await yumaPcId();
  if (existsSync(PC_BACKUP) && readFileSync(PC_BACKUP, "utf8").trim()) {
    const bk = JSON.parse(readFileSync(PC_BACKUP, "utf8")) as { id: string; row: Record<string, unknown> };
    const r = await sb.from("property_customers").update(bk.row).eq("id", bk.id);
    if (r.error) throw new Error(`前回の控えから YUMA の条件の行を戻せない: ${r.error.message}`);
    writeFileSync(PC_BACKUP, "");
    console.warn("=== 前回の控えから YUMA の条件の行を戻した ===");
  }
  writeFileSync(OUT, "");
  for (const t of turns) {
    const rec: Record<string, unknown> = { id: t.key, conv: t.conversation_id.slice(0, 8), at: t.at, scene: t.scene, staffPath: t.staffPath, staffCp: t.staffCp ?? [] };
    try {
      const { data: conv } = await sb.from("conversations").select("customer_name").eq("id", t.conversation_id).maybeSingle();
      const sc = await buildScene(t, (conv?.customer_name as string | null) ?? null);
      if (!sc || !sc.customer.length) { rec.skip = "材料なし/書類"; appendFileSync(OUT, JSON.stringify(rec) + "\n"); continue; }
      h.assertSceneSafe([...sc.context.map((m) => m.t), ...sc.customer], t.key);
      rec.customer = sc.customer; rec.staff = sc.staff;
      await h.waitUntilYumaQuiet(own); // 10/07: 他の担当が YUMA を使っている間に条件の行を写さない（先に待つ）
      rec.pc = await copyPc(t.conversation_id, yumaPc);
      const all = [...sc.context, ...sc.customer.map((x) => ({ s: "customer", t: x, aix: false }))];
      const times = h.sceneTimes(all.length, { stepSec: 90 });
      const ins = await sb.from("messages").insert(all.map((m, i) => ({ conversation_id: YUMA, sender: m.s, text: m.t || "[画像]", is_aix_generated: !!m.aix, line_message_id: `${PREFIX}${randomUUID()}`, created_at: times[i] }))).select("id");
      if (ins.error) throw new Error(ins.error.message);
      own = ((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id);
      writeFloor(new Date(Date.parse(times[0]) - 1000).toISOString());
      await new Promise((r) => setTimeout(r, 1300));
      const brains: Record<string, Record<string, unknown>> = {};
      // ブレインの版: base/new＝2段の了承の直し（環境変数・順番に）／off/on＝材料を場面で絞る（opts.sceneMaterials・同時に流す）。各版 BRAIN_REPS 回
      const runBrain = async (b: "on" | "off" | "base" | "new"): Promise<Record<string, unknown>> => {
        let meta: Record<string, unknown> | null = null;
        for (let attempt = 0; attempt < 2 && !meta; attempt++) {
          meta = await runInDeepseekScope(async () => { setDeepseekScope({ conversationId: YUMA, mark: { kind: "all" } }); return analyzeConversation(YUMA, true, "proposing", rec.pc ? yumaPc : null, "brain", { autoSendEnabled: true, customerName: "YUMA", prevPhase: null, prevAix: null, mode: "full", layer: "combined", strategy: null, ...(b === "on" || b === "off" ? { sceneMaterials: b } : {}) }); }) as unknown as Record<string, unknown> | null;
          if (!meta && attempt === 0) console.warn(`  ブレインが null → 取り直す（${b}）`);
        }
        if (!meta) throw new Error(`ブレインが null（${b}）`);
        return meta;
      };
      const pick = (meta: Record<string, unknown>) => ({ action: meta.action ?? null, reply_mode: meta.reply_mode ?? null, src: (meta as { decision_source?: string }).decision_source ?? (meta as { decision_source_no_aix?: string }).decision_source_no_aix ?? null, cp: (meta as { check_pattern?: string }).check_pattern ?? null, appeal: (meta as { appeal_timing?: { kind?: string } }).appeal_timing?.kind ?? null, dir: String(meta.reply_direction ?? "").slice(0, 200), key_topics: meta.key_topics ?? null, avoid: meta.avoid_topics ?? null });
      h.assertYuma(YUMA, "brain");
      const parallel: string[] = BRAINS.filter((b) => b === "on" || b === "off");
      const serial = BRAINS.filter((b) => !parallel.includes(b));
      for (const b of serial) {
        const ck = `${t.key}|${b}`;
        let meta = cache[ck];
        if (!meta) {
          const prev = process.env.TWO_STAGE_ACK_WAIT;
          if (b === "base") process.env.TWO_STAGE_ACK_WAIT = "off"; else delete process.env.TWO_STAGE_ACK_WAIT;
          try { meta = await runBrain(b as "base"); } finally { if (prev === undefined) delete process.env.TWO_STAGE_ACK_WAIT; else process.env.TWO_STAGE_ACK_WAIT = prev; }
          cache[ck] = meta; if (BRAIN_CACHE) writeFileSync(BRAIN_CACHE, JSON.stringify(cache));
        }
        brains[b] = meta; rec[`brain_${b}`] = pick(meta);
      }
      const pjobs = parallel.flatMap((b) => Array.from({ length: BRAIN_REPS }, (_, rep) => ({ b, key: rep === 0 ? b : `${b}_${rep}` })));
      // 10/07 本番 DB が止まった（max_connections 60）→ 同時に流さない（1本ずつ）
      const results: Array<PromiseSettledResult<{ b: string; key: string; meta: Record<string, unknown> }>> = [];
      for (const { b, key } of pjobs) {
        try {
          const ck = `${t.key}|${key}`;
          const meta = cache[ck] ?? await runBrain(b as "on" | "off");
          cache[ck] = meta;
          results.push({ status: "fulfilled", value: { b, key, meta } });
        } catch (e) { results.push({ status: "rejected", reason: e }); }
      }
      if (BRAIN_CACHE && pjobs.length) writeFileSync(BRAIN_CACHE, JSON.stringify(cache));
      for (const r of results) {
        if (r.status !== "fulfilled") { rec.brain_errors = ((rec.brain_errors as number) ?? 0) + 1; continue; }
        rec[`brain_${r.value.key}`] = pick(r.value.meta);
        if (!brains[r.value.b]) brains[r.value.b] = r.value.meta;
      }
      const meta = brains[DRAFT_BRAIN];
      if (!NO_DRAFT && meta && meta.reply_mode !== "aix") {
        const staffEngaged = sc.context.some((m) => m.s === "staff" && m.t.trim() && m.t.trim() !== "[画像]");
        const jobs = DRAFTS.flatMap((d) => Array.from({ length: REPS }, (_, rep) => ({ d, key: rep === 0 ? d.name : `${d.name}_${rep}` })));
        // 10/07 本番 DB が止まった → 下書きも1本ずつ（開発サーバの generate-reply は1回で DB を数十回読む）
        for (const { d, key } of jobs) await (async () => {
          const body = {
            message: sc.customer.join(MSG_SEP), customerMessages: sc.customer, state: staffEngaged ? "proposing" : "first_reply", conversationId: YUMA, customerName: "YUMA",
            hasViewed: false, activeTaskTypes: [], hasStaffReplied: staffEngaged,
            recentMessages: all.slice(-25).map((m, i, arr) => ({ sender: m.s, text: m.t, createdAt: times[times.length - arr.length + i], isAix: !!m.aix })),
            brainMetaDirect: { meta, customerName: "YUMA", conversationDirection: (meta.conversation_direction as Record<string, unknown> | undefined) ?? null, brainAnalyzedAt: new Date().toISOString() },
            shadowNoWrite: true, testSceneMaterials: "on", testExcludeReplyText: t.staffText ?? "", testFlags: d.flags,
          };
          const t0 = Date.now();
          const res = await fetch(`${BASE}/api/generate-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
          const ct = res.headers.get("content-type") ?? "";
          if (ct.includes("application/json")) { const j = await res.json().catch(() => ({})) as Record<string, unknown>; rec[`draft_${key}`] = null; rec[`skip_${key}`] = String(j.reason ?? j.error ?? res.status); }
          else rec[`draft_${key}`] = parseStream(await res.text());
          rec[`ms_${key}`] = Date.now() - t0;
        })();
      } else if (meta?.reply_mode === "aix") rec.no_draft = "brain_aix";
    } catch (e) { rec.error = e instanceof Error ? e.message : String(e); }
    finally {
      writeFloor(null);
      if (own.length) {
        // 消し損ね（DB の一時的な失敗）で次の番の「他の実行の行」になって10分待った（10/07 B2）→ 失敗を見て、自分の頭の行だけ取り直して消す
        const del = await sb.from("messages").delete().in("id", own);
        if (del.error) { console.warn(`  行の片付けに失敗 → 頭 ${PREFIX} の行を消し直す: ${del.error.message}`); await sb.from("messages").delete().eq("conversation_id", YUMA).like("line_message_id", `${PREFIX}%`); }
        own = [];
      }
    }
    appendFileSync(OUT, JSON.stringify(rec) + "\n");
    await new Promise((r) => setTimeout(r, GAP_MS));
    const bs = BRAINS.map((b) => { const x = rec[`brain_${b}`] as { action?: string; reply_mode?: string } | undefined; return `${b}=${x ? (x.reply_mode === "aix" ? x.action : "返信") : "-"}`; }).join(" ");
    console.log(`${rec.id} [${rec.scene}] 人=${t.staffPath.join(",")} ${rec.error ?? rec.skip ?? bs} ${DRAFTS.map((d) => `${d.name}:${String(rec[`draft_${d.name}`] ?? rec[`skip_${d.name}`] ?? "").replace(/\n/g, "/").slice(0, 40)}`).join(" | ")}`);
  }
  console.log(`書き出し: ${OUT}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  writeFloor(null);
  if (own.length) await sb.from("messages").delete().in("id", own);
  await restorePc().catch((e) => console.warn("restorePc:", String(e)));
  if (h) await h.finish();
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
});
