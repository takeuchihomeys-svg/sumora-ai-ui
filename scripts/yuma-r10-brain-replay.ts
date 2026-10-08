// scripts/yuma-r10-brain-replay.ts — 10巡目（10/08）: 本番の過去の番を YUMA で作り直し、ブレインの判断だけ（返信か AIX か・どのボタン）を前後で比べる
//   返信の文は作らない（ブレインだけ回して費用を抑える・竹内さん「返信か AIX の判断を先に完全に」）。
//   手順書 memory/test_protocol_brain.md どおり: YUMA だけ・共通の入口・未来の時刻・申込の書類の手前で切る・名前は YUMA・自分の行だけ消す・同時1本・
//   他の担当が YUMA の条件の行を写している間は待つ・日付は今日にずらす（内覧の番が壊れないように）・途中で止めても続きから。
//   版（環境変数で切り替え・同じ番で並べる）: before＝10巡目の直しを全部 off（R10_ENV）／after＝既定
//   番の出所: scripts/audit-r10-path-truth.ts --out の jsonl（正解 truth・truthKey・小場面 sub・書き手 writer）。--pick で層ごとに選ぶ
// 実行: TEST_CLOCK_JST_HOUR=14 REPLAY_FLOOR_FILE=<floor> LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-r10-brain-replay.ts \
//        --floor=<floor> --src=scripts/.replay-out/r10-truth.jsonl [--per=3] [--max=90] [--since=2026-09-12] [--versions=before,after] [--label=r10a] [--only=<key,..>]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
import { shiftDatesInText } from "./lib/scenario-date-shift";

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
const SRC = arg("src", "scripts/.replay-out/r10-truth.jsonl");
const ONLY = arg("only").split(",").filter(Boolean);
const PER = Number(arg("per", "3"));
const MAX = Number(arg("max", "90"));
const SINCE = arg("since", "2026-09-12T00:00:00Z");
const VERSIONS = arg("versions", "before,after").split(",").filter(Boolean);
const LABEL = arg("label", "r10a");
const OUT = arg("out", `scripts/.replay-out/r10-${LABEL}.jsonl`);
const GAP_MS = Number(arg("gap-ms", "3000"));
const PREFIX = "r10scene-";
const PC_BACKUP = arg("pc-backup", `scripts/.replay-out/.r10-${LABEL}-yuma-pc-backup.json`);
const R10_ENV = ["BRAIN_AIX_CATALOG", "TWO_STAGE_PICKUP_UNLESS_ACK", "FURTHER_DISCOUNT_DAIHYO", "VIEWING_DAY_GREETING", "NEGOTIATION_PROMISE_AIX"] as const;
const PC_FIELDS = ["desired_area", "floor_plan", "rent_min", "rent_max", "move_in_time", "preferences", "ng_points", "walk_minutes", "pet", "floor_area_min", "floor_area_max", "commute_station", "commute_minutes", "area_mode", "initial_cost_limit", "building_age", "other_requests", "occupants", "property_send_count", "last_property_sent_at", "ai_summary", "ai_summary_json", "ai_summary_at", "personality_profile"] as const;
const PC_BLANK = new Set(["ai_summary", "ai_summary_json", "ai_summary_at", "personality_profile"]);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
let h: LlmTestHarness | null = null;
let own: string[] = [];
let pcRestore: { id: string; row: Record<string, unknown> } | null = null;
type Src = { conv: string; at: string; sub: string; scene: string; truth: string; truthKey: string; truthBtn: string | null; promise: string | null; writer: string; staffText: string; brain: string | null; brainKey: string | null; laterAix?: string[]; period: string };
type Msg = { id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };

// ⚠ 10/08: 再生は場面の通を全部「今日」の未来の時刻に置くので、同じ日の2通目（TWO_STAGE_SAME_DAY_DIRECT）が文脈の古い約束を「今日の約束」と読み誤る
//   （22b2511e: 前の日の確認の約束で持ち込みの番が AIX を直接になった）→ 再生では前後とも off（この決まりは正解の表の実際の時刻で別に当て直す）
function setVersion(v: string) {
  for (const k of R10_ENV) { if (v === "before") process.env[k] = "off"; else delete process.env[k]; }
  process.env.TWO_STAGE_SAME_DAY_DIRECT = "off";
}
function writeFloor(floor: string | null) {
  if (!FLOOR_FILE) return;
  writeFileSync(FLOOR_FILE, JSON.stringify(floor ? { conversationId: YUMA, floor, status: "proposing", messageIdPrefix: PREFIX, keepPropertyCustomer: true } : {}));
}
async function waitOtherPcCopies(maxMin = 240) {
  const deadline = Date.now() + maxMin * 60_000;
  for (;;) {
    const busy = readdirSync("scripts/.replay-out").filter((f) => /^\..*-yuma-pc-backup\.json$/.test(f) && `scripts/.replay-out/${f}` !== PC_BACKUP.replace(/\\/g, "/"))
      .filter((f) => { try { return readFileSync(`scripts/.replay-out/${f}`, "utf8").trim().length > 0; } catch { return false; } });
    if (!busy.length) return;
    if (Date.now() > deadline) throw new Error(`他の担当の再生が YUMA の条件の行を写したまま（${busy.join(",")}）`);
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

/** 層ごとに選ぶ: 小場面×正解（AIX の番／返信の番）ごとに PER 件・新しい番から。最大 MAX */
function pickTurns(rows: Src[]): Array<Src & { key: string }> {
  const out: Array<Src & { key: string }> = [];
  const cnt = new Map<string, number>();
  const seen = new Set<string>();
  const sorted = rows.filter((r) => r.period === "AIX後" && Date.parse(r.at) >= Date.parse(SINCE) && r.truth !== "なし").sort((a, b) => (a.at < b.at ? 1 : -1));
  for (const r of sorted) {
    const key = `${r.conv.slice(0, 8)}${r.at.slice(5, 16).replace(/[-T:]/g, "")}`;
    if (ONLY.length) { if (ONLY.includes(key)) out.push({ ...r, key }); continue; }
    const side = r.truth === "AIX" || r.truth === "2段→AIX" ? "AIX" : "返信";
    const layer = `${r.sub}|${side}`;
    if ((cnt.get(layer) ?? 0) >= PER || seen.has(r.conv + layer)) continue;
    cnt.set(layer, (cnt.get(layer) ?? 0) + 1); seen.add(r.conv + layer);
    out.push({ ...r, key });
    if (out.length >= MAX) break;
  }
  return out;
}

async function main() {
  if (!process.env.TEST_CLOCK_JST_HOUR) console.warn("⚠ TEST_CLOCK_JST_HOUR が無い＝今の時刻で流す");
  if (!process.env.REPLAY_FLOOR_FILE || process.env.REPLAY_FLOOR_FILE.replace(/\\/g, "/") !== FLOOR_FILE.replace(/\\/g, "/")) throw new Error("REPLAY_FLOOR_FILE と --floor を同じにする（YUMA の過去の記録を読まないため）");
  h = await setupLlmTest("yuma-r10-brain-replay");
  const analyzeConversation = (await import("../app/lib/brain-core")).analyzeConversation;
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  const rows = readFileSync(SRC, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Src);
  const turns = pickTurns(rows);
  console.log(`番 ${turns.length}（AIX の番 ${turns.filter((t) => t.truth === "AIX" || t.truth === "2段→AIX").length}）・版 ${VERSIONS.join("/")}`);
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
    const rec: Record<string, unknown> = { id: t.key, conv: t.conv.slice(0, 8), at: t.at, sub: t.sub, scene: t.scene, writer: t.writer, truth: t.truth, truthKey: t.truthKey, truthBtn: t.truthBtn, promise: t.promise, prodBrain: t.brain, prodBrainKey: t.brainKey, laterAix: t.laterAix ?? [] };
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
      const jd = (x: number) => Math.floor((x + 9 * 3600_000) / 86_400_000);
      const shiftDays = Math.max(0, jd(Date.now()) - jd(Date.parse(t.at)));
      const yr = new Date(Date.parse(t.at) + 9 * 3600_000).getUTCFullYear();
      rec.dateShift = shiftDays;
      const mask = (s: string | null) => shiftDatesInText(maskText(s ?? "", (conv?.customer_name as string | null) ?? null, nm), shiftDays, yr);
      const context = ctx.map((m) => ({ s: m.sender === "customer" ? "customer" : "staff", t: mask(m.text), aix: !!m.is_aix_generated }));
      const customer = cust.map((m) => mask(m.text)).filter((x) => x.trim());
      rec.customer = customer.join(" / ").slice(0, 300);
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
      for (const v of VERSIONS) {
        setVersion(v);
        let meta: Record<string, unknown> | null = null;
        try {
          for (let attempt = 0; attempt < 2 && !meta; attempt++) {
            meta = await runInDeepseekScope(async () => { setDeepseekScope({ conversationId: YUMA, mark: { kind: "all" } }); return analyzeConversation(YUMA, true, "proposing", rec.pc ? yumaPc : null, "brain", { autoSendEnabled: true, customerName: "YUMA", prevPhase: null, prevAix: null, mode: "full", layer: "combined", strategy: null }); }) as unknown as Record<string, unknown> | null;
          }
        } finally { setVersion("after"); }
        if (!meta) { rec[`err_${v}`] = "ブレインが null"; continue; }
        const m = meta as Record<string, unknown> & { decision_source?: string; decision_source_no_aix?: string; check_pattern?: string };
        rec[`brain_${v}`] = { action: meta.reply_mode === "aix" ? meta.action ?? null : null, reply_mode: meta.reply_mode ?? null, src: m.decision_source ?? m.decision_source_no_aix ?? null, cp: m.check_pattern ?? null, dir: String(meta.reply_direction ?? "").slice(0, 160) };
      }
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
    const show = (v: string) => { const b = rec[`brain_${v}`] as { action?: string | null; reply_mode?: string; src?: string } | undefined; return b ? (b.reply_mode === "aix" ? `AIX:${b.action}` : `返信(${String(b.src ?? "").replace(/^rule:two_stage_promise/, "2段")})`) : String(rec[`err_${v}`] ?? "-"); };
    console.log(`${rec.id} [${rec.sub}] 正解=${t.truthKey} ${rec.error ?? rec.skip ?? VERSIONS.map((v) => `${v}=${show(v)}`).join(" ")}`);
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
