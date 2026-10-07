// scripts/yuma-cost-model-pilot.ts — 案②「判断が単純な場面だけ安いモデル」の最後の確かめ（Claude・場面ごとに2番×1回・手順書の上限どおり）
//   2026-10-07 竹内「この3つもはかって！！質は絶対に落ちないように」。同じ本番の過去の番（3巡目の再生と同じ番）を YUMA で、
//   今のブレイン（Sonnet 5.5）と Haiku 4.5 で1回ずつ流し、道（返信か・どの AIX か・2段の約束）・reply_direction を並べる。
//   Haiku への切り替えはこのスクリプトの中だけ（記録の包みの外側で、ブレインの要求の model を書き換える）。brain-core は触らない。
//   ⚠ 1番×1回の比べは揺れを測れない＝大きな崩れ（JSON が壊れる・決まりを無視する）を見るためだけ。数で決めるには場面ごと20番×6回（Claude 約 $10〜15）が要る。
// 実行: TEST_CLOCK_JST_HOUR=14 REPLAY_FLOOR_FILE=<floor> LLM_TEST_FINAL_CLAUDE=1 npx tsx --env-file=.env.local scripts/yuma-cost-model-pilot.ts --floor=<floor> \
//        [--src=scripts/.replay-out/r3-brainB1.jsonl] [--scenes=ack,considering,other] [--per=2] [--out=scripts/.replay-out/cost-model-pilot.jsonl]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";

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
const FLOOR_FILE = arg("floor", "");
const SRC = arg("src", "scripts/.replay-out/r3-brainB1.jsonl");
const SCENES = arg("scenes", "ack,considering,other").split(",").filter(Boolean);
const PER = Number(arg("per", "2"));
const OUT = arg("out", "scripts/.replay-out/cost-model-pilot.jsonl");
const HAIKU = "claude-haiku-4-5-20251001";
const PC_BACKUP = "scripts/.replay-out/.cost-model-yuma-pc-backup.json";
const PREFIX = "costmodel-";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const PC_FIELDS = ["desired_area", "floor_plan", "rent_min", "rent_max", "move_in_time", "preferences", "ng_points", "walk_minutes", "pet", "floor_area_min", "floor_area_max", "commute_station", "commute_minutes", "area_mode", "initial_cost_limit", "building_age", "other_requests", "occupants", "property_send_count", "last_property_sent_at", "ai_summary", "ai_summary_json", "ai_summary_at", "personality_profile"] as const;
const PC_BLANK = new Set(["ai_summary", "ai_summary_json", "ai_summary_at", "personality_profile"]);
let h: LlmTestHarness | null = null;
let own: string[] = [];
let pcRestore: { id: string; row: Record<string, unknown> } | null = null;
let modelOverride: string | null = null;
type Msg = { id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };

function writeFloor(floor: string | null) {
  if (!FLOOR_FILE) return;
  writeFileSync(FLOOR_FILE, JSON.stringify(floor ? { conversationId: YUMA, floor, status: "proposing", messageIdPrefix: PREFIX, keepPropertyCustomer: true } : {}));
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
  const { error } = await sb.from("property_customers").update(Object.fromEntries(PC_FIELDS.map((k) => [k, PC_BLANK.has(k) ? null : (src[k] ?? null)]))).eq("id", yumaPc);
  if (error) throw new Error(`条件の行の写し: ${error.message}`);
  return !!srcPc;
}
async function restorePc() {
  if (!pcRestore) return;
  const r = await sb.from("property_customers").update(pcRestore.row).eq("id", pcRestore.id);
  if (r.error) { console.error(`⛔ YUMA の条件の行を戻せない（控え ${PC_BACKUP}）: ${r.error.message}`); return; }
  writeFileSync(PC_BACKUP, "");
  console.log("=== YUMA の条件の行を元に戻した ===");
  pcRestore = null;
}
async function clearOwn() {
  if (!own.length) return;
  const del = await sb.from("messages").delete().in("id", own);
  if (del.error) await sb.from("messages").delete().eq("conversation_id", YUMA).like("line_message_id", `${PREFIX}%`);
  own = [];
}

async function main() {
  if (!process.env.REPLAY_FLOOR_FILE || process.env.REPLAY_FLOOR_FILE.replace(/\\/g, "/") !== FLOOR_FILE.replace(/\\/g, "/")) throw new Error("REPLAY_FLOOR_FILE と --floor を同じにしてください");
  h = await setupLlmTest("cost-model-pilot");
  if (h.run !== "final-claude") throw new Error("このスクリプトは LLM_TEST_FINAL_CLAUDE=1 だけ（Haiku と Sonnet を比べる）");
  // 記録の包みの外側でブレインの要求の model を書き換える（このスクリプトの中だけ・modelOverride が付いている時だけ）
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (modelOverride && /api\.anthropic\.com\/v1\/messages(?:\?|$)/.test(url) && init && typeof init.body === "string") {
      try { const j = JSON.parse(init.body) as Record<string, unknown>; if (String(j.model ?? "").startsWith("claude-sonnet")) { j.model = modelOverride; init = { ...init, body: JSON.stringify(j) }; } } catch { /* そのまま */ }
    }
    return inner(input, init);
  }) as typeof fetch;
  const analyzeConversation = (await import("../app/lib/brain-core")).analyzeConversation;
  const { data: yc } = await sb.from("conversations").select("property_customer_id").eq("id", YUMA).maybeSingle();
  const yumaPc = (yc?.property_customer_id as string | null) ?? null;
  if (!yumaPc) throw new Error("YUMA の条件の行が無い");
  if (existsSync(PC_BACKUP) && readFileSync(PC_BACKUP, "utf8").trim()) {
    const bk = JSON.parse(readFileSync(PC_BACKUP, "utf8")) as { id: string; row: Record<string, unknown> };
    await sb.from("property_customers").update(bk.row).eq("id", bk.id);
    writeFileSync(PC_BACKUP, "");
  }
  type Src = { conv: string; at: string; scene: string; staffPath: string[]; error?: string; skip?: string };
  const src = readFileSync(SRC, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Src).filter((r) => !r.error && !r.skip && SCENES.includes(r.scene));
  const turns: Src[] = [];
  for (const s of SCENES) turns.push(...src.filter((r) => r.scene === s).slice(0, PER));
  console.log(`番 ${turns.length}: ${SCENES.map((s) => `${s}=${turns.filter((t) => t.scene === s).length}`).join(" ")}`);
  writeFileSync(OUT, "");
  const pick = (m: Record<string, unknown>) => ({ action: m.action ?? null, reply_mode: m.reply_mode ?? null, src: (m as { decision_source?: string }).decision_source ?? null, dir: String(m.reply_direction ?? "").slice(0, 200), key_topics: m.key_topics ?? null, avoid: m.avoid_topics ?? null });
  for (const t of turns) {
    const rec: Record<string, unknown> = { conv: t.conv, at: t.at, scene: t.scene, staffPath: t.staffPath };
    try {
      const { data: d } = await sb.from("brain_decision_logs").select("conversation_id").eq("analyzed_msg_ts", t.at).like("conversation_id", `${t.conv}%`).limit(1);
      const conv = (d?.[0]?.conversation_id as string | undefined) ?? null;
      if (!conv) { rec.skip = "会話が見つからない"; appendFileSync(OUT, JSON.stringify(rec) + "\n"); continue; }
      const { data: cn } = await sb.from("conversations").select("customer_name").eq("id", conv).maybeSingle();
      const { data } = await sb.from("messages").select("id, sender, text, created_at, is_aix_generated").eq("conversation_id", conv).lte("created_at", t.at).order("created_at", { ascending: false }).limit(60);
      const ms = ((data ?? []) as Msg[]).reverse();
      let end = ms.length - 1; while (end >= 0 && ms[end].sender !== "customer") end--;
      let start = end; while (start - 1 >= 0 && ms[start - 1].sender === "customer") start--;
      const rowsRaw = ms.slice(Math.max(0, start - 29), end + 1);
      const cut = h.cutBeforeApplicationMaterial(rowsRaw);
      if (cut.cutAt !== null && cut.cutAt < rowsRaw.length) { rec.skip = "書類"; appendFileSync(OUT, JSON.stringify(rec) + "\n"); continue; }
      const nm = addressNamesOf(ms.filter((x) => x.sender !== "customer").map((x) => x.text ?? ""));
      const rows = rowsRaw.map((m) => ({ s: m.sender === "customer" ? "customer" : "staff", t: maskText(m.text ?? "", (cn?.customer_name as string | null) ?? null, nm) || "[画像]", aix: !!m.is_aix_generated }));
      h.assertSceneSafe(rows.map((r) => r.t), t.conv);
      rec.customer = rows.filter((r, i) => i >= rows.length - (end - start + 1)).map((r) => r.t.slice(0, 80));
      rec.pc = await copyPc(conv, yumaPc);
      await h.waitUntilYumaQuiet(own);
      const times = h.sceneTimes(rows.length, { stepSec: 90 });
      const ins = await sb.from("messages").insert(rows.map((m, i) => ({ conversation_id: YUMA, sender: m.s, text: m.t, is_aix_generated: m.aix, line_message_id: `${PREFIX}${randomUUID()}`, created_at: times[i] }))).select("id");
      if (ins.error) throw new Error(ins.error.message);
      own = ((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id);
      writeFloor(new Date(Date.parse(times[0]) - 1000).toISOString());
      await new Promise((r) => setTimeout(r, 1300));
      for (const [label, model] of [["sonnet", null], ["haiku", HAIKU]] as const) {
        modelOverride = model;
        h.assertYuma(YUMA, "brain");
        const m = await analyzeConversation(YUMA, true, "proposing", rec.pc ? yumaPc : null, "brain", { autoSendEnabled: true, customerName: "YUMA", prevPhase: null, prevAix: null, mode: "full", layer: "combined", strategy: null }) as unknown as Record<string, unknown> | null;
        rec[label] = m ? pick(m) : null;
      }
      modelOverride = null;
    } catch (e) { rec.error = e instanceof Error ? e.message : String(e); modelOverride = null; }
    finally { writeFloor(null); await clearOwn(); }
    appendFileSync(OUT, JSON.stringify(rec) + "\n");
    const p = (x: unknown) => { const y = x as { reply_mode?: string; action?: string } | null; return y ? (y.reply_mode === "aix" ? y.action : "返信") : "-"; };
    console.log(`${t.conv} [${t.scene}] 人=${t.staffPath.join(",")} sonnet=${p(rec.sonnet)} haiku=${p(rec.haiku)} ${rec.error ?? rec.skip ?? ""}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  writeFloor(null);
  await clearOwn().catch(() => {});
  await restorePc().catch(() => {});
  if (h) await h.finish();
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
});
