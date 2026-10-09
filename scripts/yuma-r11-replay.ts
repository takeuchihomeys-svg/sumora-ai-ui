// scripts/yuma-r11-replay.ts — 11巡目（10/08）: 竹内さんの手打ちの過去の番を YUMA で作り直し、下書きを竹内さんの実送信と比べる（直す前／後を同じブレインで）
//   yuma-r7-replay.ts の写し。違い: 版は 11巡目の直し（R11_ENV）・番は scripts/audit-r11-reply-table.ts の書き出し（竹内さんの手打ち・messages.staff_writer）・
//   ブレインの判断（意図・質問・条件変更・迷い）を控えて採点で場面をブレインに寄せられるようにする・控えの名前は r11
// （以下 r7 の説明）
//   手順書 memory/test_protocol_brain.md どおり: YUMA だけ・共通の入口・未来の時刻・申込の書類の手前で切る・名前は YUMA・自分の行だけ消す・同時1本。
//   yuma-r3-replay.ts（開発サーバを叩く）からの違い: 同じフォルダで他の担当の next dev が動いていて2つ目を立てられない（.next の取り合い）ため、
//     generate-reply の POST を同じプロセスで呼ぶ（scripts/yuma-overfire-route-test.ts と同じ形）。版は環境変数で切り替える（同じ番・同じブレインで前後を並べる）。
//   版: before＝7巡目の直しを全部 off（REPLY_SCENE_R7・GREETING_OPENER_R7・VIEWING_DAY_NOTICE_R7・VIEWING_ACK_DATE_SUFFIX）／after＝既定
// 実行: TEST_CLOCK_JST_HOUR=14 REPLAY_FLOOR_FILE=<floor> LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-r7-replay.ts \
//        --floor=<floor> --src=scripts/.replay-out/r7-turns.jsonl [--versions=before,after] [--reps=1] [--scenes=..] [--per=99] [--label=r7a] [--brain-cache=<file>] [--only=<key,..>]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
import { MSG_SEP } from "../app/lib/reply-context";
import { type ReplyScene } from "../app/lib/reply-scene";
import { shiftDatesInText } from "./lib/scenario-date-shift";
import { writerFromText } from "../app/lib/staff-writer";

const URL_OR_PHONE_RE = /https?:\/\/[^\s　]+|0\d{1,4}[-ー－]?\d{1,4}[-ー－]?\d{3,4}/g;
const MAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const NOT_NAME = /^(?:お客|皆|旦那|奥|管理会社|担当|YUMA|同居人|オーナー|業者|大家|貸主|保証会社|ご主人|主人|彼女|彼氏|お子|弟|妹|兄|姉|母|父|ご両親|親御|内覧担当|鈴木|管理人|みな$)/;
function addressNamesOf(staffTexts: ReadonlyArray<string>): string[] {
  const out = new Set<string>();
  for (const t of staffTexts) for (const m of String(t ?? "").matchAll(/(?:^|\n|、|。|！|\s|\/)([^\s\n、。！!?？「」()（）・/]{1,10}?)(?:さん|様)(?=\n|に|の|が|お|ご|達|、|！|😊|😌|$|\s)/g)) {
    const nm = m[1]; if (!NOT_NAME.test(nm) && !/[0-9０-９]/.test(nm)) out.add(nm);
  }
  return [...out];
}
function maskText(t: string, customerName: string | null, extraNames: ReadonlyArray<string> = []): string {
  let s = String(t ?? "");
  const names = new Set<string>();
  const n = (customerName ?? "").trim();
  if (n.length >= 2) { names.add(n); for (const p of n.split(/[\s　]+/)) if (p.length >= 2) names.add(p); }
  for (const x of extraNames) if (x) names.add(x);
  for (const nm of [...names].sort((a, b) => b.length - a.length)) { s = s.split(`${nm}さん`).join("YUMAさん").split(`${nm}様`).join("YUMA様"); if (nm.length >= 2) s = s.split(nm).join("YUMA"); }
  s = s.replace(/[^\s、。！!]{2,8}(様|さん)から(ご)?紹介/g, "ご紹介者様から$2紹介");
  s = s.replace(/^([^\n]{1,14}?)(さん|様)(\n)/, "YUMA$2$3");
  return s.replace(URL_OR_PHONE_RE, (m) => (/^https?:/.test(m) ? m : "（電話番号）")).replace(MAIL_RE, "yuma@example.com");
}

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const FLOOR_FILE = arg("floor", "");
const SRC = arg("src", "scripts/.replay-out/r7-turns.jsonl");
const SCENES = arg("scenes").split(",").filter(Boolean);
const ONLY = arg("only").split(",").filter(Boolean);
const PER = Number(arg("per", "99"));
// 2026-10-08 正解の書き手で絞る（竹内「竹内のLINEか従業員のLINEかで…」）: takeuchi＝竹内さんの手打ちだけを正解に／employee／空＝全部（旧）
const WRITER = arg("writer", "");
const VERSIONS = arg("versions", "before,after").split(",").filter(Boolean);
const REPS = Math.max(1, Number(arg("reps", "1")));
const LABEL = arg("label", "r11");
const BRAIN_CACHE = arg("brain-cache", `scripts/.replay-out/r11-brain-cache.json`);
const OUT = arg("out", `scripts/.replay-out/r11-${LABEL}.jsonl`);
const GAP_MS = Number(arg("gap-ms", "3000"));
/** 場面の文の日付をずらす: none（既定）／exact＝場面の日から今日までの日数そのまま（内覧当日の場面を「今日」にする・曜日は付け直す） */
const DATE_SHIFT = arg("date-shift", "none");
const PREFIX = "r11scene-";
// 10/08: 回ごとに別の控え（同じ名前だと、後から起動した回が先の回の控えを「前回の残り」と読んで戻し、先の回の場面を壊した）
const PC_BACKUP = arg("pc-backup", `scripts/.replay-out/.r11-${LABEL}-yuma-pc-backup.json`);
// 11巡目の直し（before＝全部 off）。足したら並べる
const R7_ENV = (process.env.R11_ENV_LIST ?? "REPLY_SCENE_BRAIN,ESTIMATE_POSITIVE_BRAIN,REPLY_STYLE_R11").split(",").filter(Boolean);
const PC_FIELDS = ["desired_area", "floor_plan", "rent_min", "rent_max", "move_in_time", "preferences", "ng_points", "walk_minutes", "pet", "floor_area_min", "floor_area_max", "commute_station", "commute_minutes", "area_mode", "initial_cost_limit", "building_age", "other_requests", "occupants", "property_send_count", "last_property_sent_at", "ai_summary", "ai_summary_json", "ai_summary_at", "personality_profile"] as const;
const PC_BLANK = new Set(["ai_summary", "ai_summary_json", "ai_summary_at", "personality_profile"]);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
let h: LlmTestHarness | null = null;
let own: string[] = [];
let pcRestore: { id: string; row: Record<string, unknown> } | null = null;
type Turn = { key: string; conv: string; at: string; scene: ReplyScene; staffText: string; src?: string };
type Msg = { id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };

function setVersion(v: string) {
  for (const k of R7_ENV) { if (v === "before") process.env[k] = "off"; else delete process.env[k]; }
}
function writeFloor(floor: string | null) {
  if (!FLOOR_FILE) return;
  writeFileSync(FLOOR_FILE, JSON.stringify(floor ? { conversationId: YUMA, floor, status: "proposing", messageIdPrefix: PREFIX, keepPropertyCustomer: true } : {}));
}
/** 他の担当の再生が YUMA の条件の行を写している間（その控えのファイルが空でない間）は待つ。
 *  控えが入っている時に写すと、こちらの控えが「他の担当の場面の条件」になり、戻す時に本当の YUMA の条件を失う（10/07 の r6 と同時に走る時の穴） */
async function waitOtherPcCopies(maxMin = 240) {
  const { readdirSync } = await import("node:fs");
  const deadline = Date.now() + maxMin * 60_000;
  for (;;) {
    const busy = readdirSync("scripts/.replay-out").filter((f) => /^\..*-yuma-pc-backup\.json$/.test(f) && `scripts/.replay-out/${f}` !== PC_BACKUP.replace(/\\/g, "/"))
      .filter((f) => { try { return readFileSync(`scripts/.replay-out/${f}`, "utf8").trim().length > 0; } catch { return false; } });
    if (!busy.length) return;
    if (Date.now() > deadline) throw new Error(`他の担当の再生が YUMA の条件の行を写したまま（${busy.join(",")}）。終わるのを待つ`);
    console.warn(`  … 他の担当の再生が YUMA の条件の行を写し中（${busy.join(",")}）→ 60秒待ちます`);
    await new Promise((r) => setTimeout(r, 60_000));
  }
}
async function yumaPcId(): Promise<string> {
  const { data } = await sb.from("conversations").select("property_customer_id").eq("id", YUMA).maybeSingle();
  const id = (data?.property_customer_id as string | null) ?? null; if (!id) throw new Error("YUMA の条件の行が無い"); return id;
}
async function copyPc(srcConv: string, yumaPc: string): Promise<boolean> {
  if (!pcRestore) {
    const { data } = await sb.from("property_customers").select(PC_FIELDS.join(", ")).eq("id", yumaPc).maybeSingle();
    pcRestore = { id: yumaPc, row: (data ?? {}) as unknown as Record<string, unknown> };
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
  writeFileSync(PC_BACKUP, ""); console.log("=== YUMA の条件の行を元に戻した ==="); pcRestore = null;
}
function parseStream(raw: string): string {
  let body = String(raw ?? "");
  const nl = body.indexOf("\n");
  if (nl >= 0) { try { const j = JSON.parse(body.slice(0, nl)); if (j && typeof j === "object") body = body.slice(nl + 1); } catch { /* */ } }
  return body.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
}

async function main() {
  if (!process.env.TEST_CLOCK_JST_HOUR) console.warn("⚠ TEST_CLOCK_JST_HOUR が無い＝今の時刻で流す（夜中は営業時間外の指示が入る）");
  if (!process.env.REPLAY_FLOOR_FILE || process.env.REPLAY_FLOOR_FILE.replace(/\\/g, "/") !== FLOOR_FILE.replace(/\\/g, "/")) throw new Error("REPLAY_FLOOR_FILE と --floor を同じにする（YUMA の過去の記録を読まないため）");
  h = await setupLlmTest("yuma-r11-replay");
  const analyzeConversation = (await import("../app/lib/brain-core")).analyzeConversation;
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  const { POST } = await import("../app/api/generate-reply/route");
  const cache: Record<string, Record<string, unknown>> = existsSync(BRAIN_CACHE) ? JSON.parse(readFileSync(BRAIN_CACHE, "utf8") || "{}") : {};
  const all = readFileSync(SRC, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { conv: string; at: string; scene: ReplyScene; staffText: string; src?: string });
  const cnt = new Map<string, number>();
  const turns: Turn[] = [];
  for (const r of all) {
    const key = `${r.conv.slice(0, 8)}${r.at.slice(5, 16).replace(/[-T:]/g, "")}`;
    if (ONLY.length && !ONLY.includes(key)) continue;
    if (SCENES.length && !SCENES.includes(r.scene)) continue;
    if (WRITER && ((r as { writer?: string | null }).writer ?? writerFromText(r.staffText).writer) !== WRITER) continue;
    if ((cnt.get(r.scene) ?? 0) >= PER) continue;
    cnt.set(r.scene, (cnt.get(r.scene) ?? 0) + 1);
    turns.push({ key, conv: r.conv, at: r.at, scene: r.scene, staffText: r.staffText, src: r.src });
  }
  console.log(`番 ${turns.length}: ${[...cnt].map(([k, v]) => `${k}=${v}`).join(" ")}・版 ${VERSIONS.join("/")}×${REPS}`);
  const yumaPc = await yumaPcId();
  if (existsSync(PC_BACKUP) && readFileSync(PC_BACKUP, "utf8").trim()) {
    const bk = JSON.parse(readFileSync(PC_BACKUP, "utf8")) as { id: string; row: Record<string, unknown> };
    const r = await sb.from("property_customers").update(bk.row).eq("id", bk.id);
    if (r.error) throw new Error(`前回の控えから YUMA の条件の行を戻せない: ${r.error.message}`);
    writeFileSync(PC_BACKUP, ""); console.warn("=== 前回の控えから YUMA の条件の行を戻した ===");
  }
  if (!existsSync(OUT)) writeFileSync(OUT, "");
  const done = new Set(readFileSync(OUT, "utf8").trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { id: string }).id));
  for (const t of turns) {
    if (done.has(t.key)) continue;
    const rec: Record<string, unknown> = { id: t.key, conv: t.conv.slice(0, 8), at: t.at, scene: t.scene, src: t.src };
    try {
      const { data: conv } = await sb.from("conversations").select("customer_name").eq("id", t.conv).maybeSingle();
      const { data } = await sb.from("messages").select("id, sender, text, created_at, is_aix_generated").eq("conversation_id", t.conv).lte("created_at", t.at).order("created_at", { ascending: false }).limit(60);
      const ms = ((data ?? []) as Msg[]).reverse();
      let end = ms.length - 1; while (end >= 0 && ms[end].sender !== "customer") end--;
      if (end < 0) { rec.skip = "材料なし"; appendFileSync(OUT, JSON.stringify(rec) + "\n"); continue; }
      let start = end; while (start - 1 >= 0 && ms[start - 1].sender === "customer") start--;
      const ctx = ms.slice(Math.max(0, start - 29), start); const cust = ms.slice(start, end + 1);
      const cut = h.cutBeforeApplicationMaterial([...ctx, ...cust]);
      if (cut.cutAt !== null && cut.cutAt < ctx.length + cust.length) { rec.skip = "申込の書類"; appendFileSync(OUT, JSON.stringify(rec) + "\n"); continue; }
      const nm = addressNamesOf(ms.filter((x) => x.sender !== "customer").map((x) => x.text ?? ""));
      const jd = (ms: number) => Math.floor((ms + 9 * 3600_000) / 86_400_000);
      const shiftDays = DATE_SHIFT === "exact" ? Math.max(0, jd(Date.now()) - jd(Date.parse(t.at))) : 0;
      const yr = new Date(Date.parse(t.at) + 9 * 3600_000).getUTCFullYear();
      rec.dateShift = shiftDays;
      const mask = (s: string | null) => shiftDatesInText(maskText(s ?? "", (conv?.customer_name as string | null) ?? null, nm), shiftDays, yr);
      const context = ctx.map((m) => ({ s: m.sender === "customer" ? "customer" : "staff", t: mask(m.text), aix: !!m.is_aix_generated }));
      const customer = cust.map((m) => mask(m.text)).filter((x) => x.trim());
      rec.customer = customer; rec.staff = mask(t.staffText);
      rec.prevStaff = [...context].reverse().find((m) => m.s === "staff" && m.t.trim() && !/^\[(?:画像|動画)\]$/.test(m.t.trim()))?.t ?? "";
      h.assertSceneSafe([...context.map((m) => m.t), ...customer], t.key);
      await waitOtherPcCopies();
      await h.waitUntilYumaQuiet(own, { maxWaitMin: 120 });
      await waitOtherPcCopies();
      rec.pc = await copyPc(t.conv, yumaPc);
      const msgsAll = [...context, ...customer.map((x) => ({ s: "customer", t: x, aix: false }))];
      const times = h.sceneTimes(msgsAll.length, { stepSec: 90 });
      const ins = await sb.from("messages").insert(msgsAll.map((m, i) => ({ conversation_id: YUMA, sender: m.s, text: m.t || "[画像]", is_aix_generated: !!m.aix, line_message_id: `${PREFIX}${randomUUID()}`, created_at: times[i] }))).select("id");
      if (ins.error) throw new Error(ins.error.message);
      own = ((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id);
      writeFloor(new Date(Date.parse(times[0]) - 1000).toISOString());
      await new Promise((r) => setTimeout(r, 1300));
      h.assertYuma(YUMA, "brain");
      let meta = cache[t.key];
      if (!meta) {
        setVersion("after");
        for (let attempt = 0; attempt < 2 && !meta; attempt++) {
          meta = await runInDeepseekScope(async () => { setDeepseekScope({ conversationId: YUMA, mark: { kind: "all" } }); return analyzeConversation(YUMA, true, "proposing", rec.pc ? yumaPc : null, "brain", { autoSendEnabled: true, customerName: "YUMA", prevPhase: null, prevAix: null, mode: "full", layer: "combined", strategy: null }); }) as unknown as Record<string, unknown>;
        }
        if (!meta) throw new Error("ブレインが null");
        cache[t.key] = meta; writeFileSync(BRAIN_CACHE, JSON.stringify(cache));
      }
      rec.brain = { action: meta.action ?? null, reply_mode: meta.reply_mode ?? null, dir: String(meta.reply_direction ?? "").slice(0, 160), intent: meta.customer_intent ?? null, q: meta.customer_questions ?? [], cond: meta.condition_change_type ?? null, scope: meta.condition_change_scope ?? null, hes: meta.hesitancy_pattern ?? null };
      if (meta.reply_mode === "aix") rec.no_draft = "brain_aix";
      const staffEngaged = context.some((m) => m.s === "staff" && m.t.trim() && m.t.trim() !== "[画像]");
      for (const v of VERSIONS) for (let rep = 0; rep < REPS; rep++) {
        const key = rep === 0 ? `draft_${v}` : `draft_${v}_${rep}`;
        setVersion(v);
        const body = {
          message: customer.join(MSG_SEP), customerMessages: customer, state: staffEngaged ? "proposing" : "first_reply", conversationId: YUMA, customerName: "YUMA",
          hasViewed: false, activeTaskTypes: [], hasStaffReplied: staffEngaged,
          recentMessages: msgsAll.slice(-25).map((m, i, arr) => ({ sender: m.s, text: m.t, createdAt: times[times.length - arr.length + i], isAix: !!m.aix })),
          brainMetaDirect: { meta: { ...meta, reply_mode: meta.reply_mode === "aix" ? "reply" : meta.reply_mode }, customerName: "YUMA", conversationDirection: (meta.conversation_direction as Record<string, unknown> | undefined) ?? null, brainAnalyzedAt: new Date().toISOString() },
          shadowNoWrite: true, testSceneMaterials: "on", testExcludeReplyText: t.staffText ?? "",
        };
        const t0 = Date.now();
        try {
          const res = await POST(new Request("http://localhost/api/generate-reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never) as Response;
          const ct = res.headers.get("content-type") ?? "";
          if (ct.includes("application/json")) { const j = await res.json().catch(() => ({})) as Record<string, unknown>; rec[key] = null; rec[`skip_${key}`] = String(j.reason ?? j.error ?? res.status); }
          else rec[key] = parseStream(await res.text());
        } catch (e) { rec[key] = null; rec[`err_${key}`] = e instanceof Error ? e.message : String(e); }
        rec[`ms_${key}`] = Date.now() - t0;
      }
      setVersion("after");
    } catch (e) { rec.error = e instanceof Error ? e.message : String(e); }
    finally {
      writeFloor(null);
      if (own.length) {
        const del = await sb.from("messages").delete().in("id", own);
        if (del.error) await sb.from("messages").delete().eq("conversation_id", YUMA).like("line_message_id", `${PREFIX}%`);
        own = [];
      }
    }
    appendFileSync(OUT, JSON.stringify(rec) + "\n");
    console.log(`${rec.id} [${rec.scene}] ${rec.error ?? rec.skip ?? ""} ${VERSIONS.map((v) => `${v}:${String(rec[`draft_${v}`] ?? rec[`skip_draft_${v}`] ?? rec[`err_draft_${v}`] ?? "").replace(/\n/g, "/").slice(0, 50)}`).join(" | ")}`);
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  console.log(`書き出し: ${OUT}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  writeFloor(null);
  if (own.length) await sb.from("messages").delete().in("id", own);
  await restorePc().catch((e) => console.warn("restorePc:", String(e)));
  if (h) await h.finish();
  setTimeout(() => process.exit(process.exitCode ?? 0), 800);
});
