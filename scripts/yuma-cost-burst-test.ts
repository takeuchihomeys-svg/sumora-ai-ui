// scripts/yuma-cost-burst-test.ts — ブレインの回数を減らす案①「連投の途中の発言では LLM を呼ばない」を YUMA で確かめる（2026-10-07 竹内「この3つもはかって！！質は絶対に落ちないように」）
//   本番: 連投の途中の発言を見た brain_fresh が 104回／538回（申込前・14.5日・audit-brain-cost-levers）。その結果は次の発言の分析ですぐ上書きされるが、
//   次の分析の「局面の候補（前回のフェーズ・前回の AIX＝アクション別ルールの組）」に入る＝最後の判断に間接に効きうる。これを測る:
//     P   = 連投の前の状態（場面の前の会話だけ）での判断 → その conversation_direction（フェーズ・AIX）
//     A1  = 連投の1通目だけを見た判断（P の状態から）＝今の「途中の呼び出し」
//     今  = 連投全体の判断（A1 の状態から）       … 今の形
//     案  = 連投全体の判断（P の状態から・A1 なし）… 途中を呼ばない形
//   A1 の状態が P と同じ番は入力が1文字も変わらない（＝同じ）。違う番だけ「今」と「案」を各 REPS 回流して、道（返信か・どの AIX か・2段の約束）の一致と揺れを比べる。
//   手順書 memory/test_protocol_brain.md どおり: YUMA だけ・共通の入口・未来の時刻・申込の書類の手前で切る・名前は YUMA・自分の行だけ消す・YUMA の条件の行を写したら戻す。
// 実行: TEST_CLOCK_JST_HOUR=14 REPLAY_FLOOR_FILE=<floor> LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-cost-burst-test.ts \
//        --floor=<floor> [--src=scripts/.replay-out/cost-levers-turns.jsonl] [--n=24] [--reps=3] [--out=scripts/.replay-out/cost-burst.jsonl]
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
const SRC = arg("src", "scripts/.replay-out/cost-levers-turns.jsonl");
const N = Number(arg("n", "24"));
const REPS = Math.max(1, Number(arg("reps", "3")));
const OUT = arg("out", "scripts/.replay-out/cost-burst.jsonl");
const GAP_MS = Number(arg("gap-ms", "3000"));
const PC_BACKUP = "scripts/.replay-out/.cost-burst-yuma-pc-backup.json";
const PREFIX = "costburst-";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const PC_FIELDS = ["desired_area", "floor_plan", "rent_min", "rent_max", "move_in_time", "preferences", "ng_points", "walk_minutes", "pet", "floor_area_min", "floor_area_max", "commute_station", "commute_minutes", "area_mode", "initial_cost_limit", "building_age", "other_requests", "occupants", "property_send_count", "last_property_sent_at", "ai_summary", "ai_summary_json", "ai_summary_at", "personality_profile"] as const;
const PC_BLANK = new Set(["ai_summary", "ai_summary_json", "ai_summary_at", "personality_profile"]);
let h: LlmTestHarness | null = null;
let own: string[] = [];
let pcRestore: { id: string; row: Record<string, unknown> } | null = null;
type Msg = { id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
type Src = { conv: string; at: string; scene: string; callsMid: number; staff: string[]; prev: { action: string | null; mode: string | null; src: string | null } | null };

function writeFloor(floor: string | null) {
  if (!FLOOR_FILE) return;
  writeFileSync(FLOOR_FILE, JSON.stringify(floor ? { conversationId: YUMA, floor, status: "proposing", messageIdPrefix: PREFIX, keepPropertyCustomer: true } : {}));
}
async function yumaPcId(): Promise<string> {
  const { data } = await sb.from("conversations").select("property_customer_id").eq("id", YUMA).maybeSingle();
  const id = (data?.property_customer_id as string | null) ?? null;
  if (!id) throw new Error("YUMA の条件の行が無い");
  return id;
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
  writeFileSync(PC_BACKUP, "");
  console.log("=== YUMA の条件の行を元に戻した ===");
  pcRestore = null;
}
async function clearOwn() {
  if (!own.length) return;
  const del = await sb.from("messages").delete().in("id", own);
  if (del.error) { console.warn(`  行の片付けに失敗 → 頭 ${PREFIX} の行を消し直す: ${del.error.message}`); await sb.from("messages").delete().eq("conversation_id", YUMA).like("line_message_id", `${PREFIX}%`); }
  own = [];
}

async function main() {
  if (!process.env.TEST_CLOCK_JST_HOUR) console.warn("⚠ TEST_CLOCK_JST_HOUR が無い＝今の時刻で流す");
  if (!process.env.REPLAY_FLOOR_FILE || process.env.REPLAY_FLOOR_FILE.replace(/\\/g, "/") !== FLOOR_FILE.replace(/\\/g, "/")) throw new Error("REPLAY_FLOOR_FILE と --floor を同じにしてください");
  h = await setupLlmTest("cost-burst");
  const analyzeConversation = (await import("../app/lib/brain-core")).analyzeConversation;
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  const yumaPc = await yumaPcId();
  if (existsSync(PC_BACKUP) && readFileSync(PC_BACKUP, "utf8").trim()) {
    const bk = JSON.parse(readFileSync(PC_BACKUP, "utf8")) as { id: string; row: Record<string, unknown> };
    const r = await sb.from("property_customers").update(bk.row).eq("id", bk.id);
    if (r.error) throw new Error(`前回の控えから戻せない: ${r.error.message}`);
    writeFileSync(PC_BACKUP, "");
    console.warn("=== 前回の控えから YUMA の条件の行を戻した ===");
  }
  // 番: 本番で連投の途中に呼ばれた番（スタッフの返事あり）。会話ごとに1番・新しい順
  const all = readFileSync(SRC, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Src).filter((r) => r.callsMid > 0 && r.staff.length);
  const seenConv = new Set<string>();
  const turns = all.sort((a, b) => (a.at < b.at ? 1 : -1)).filter((r) => { if (seenConv.has(r.conv)) return false; seenConv.add(r.conv); return true; }).slice(0, N);
  console.log(`番 ${turns.length}（候補 ${all.length}）: ${[...new Set(turns.map((t) => t.scene))].map((s) => `${s}=${turns.filter((t) => t.scene === s).length}`).join(" ")}`);
  writeFileSync(OUT, "");
  const dirOf = (m: Record<string, unknown> | null) => {
    const d = (m?.conversation_direction ?? null) as { current_phase?: string; suggested_aix_button?: string } | null;
    return { phase: typeof d?.current_phase === "string" ? d.current_phase : null, aix: typeof d?.suggested_aix_button === "string" ? d.suggested_aix_button : null };
  };
  const pick = (m: Record<string, unknown>) => ({ action: (m.action as string) ?? null, reply_mode: (m.reply_mode as string) ?? null, src: ((m as { decision_source?: string }).decision_source ?? null), dir: String(m.reply_direction ?? "").slice(0, 160), ...dirOf(m) });
  for (const t of turns) {
    const rec: Record<string, unknown> = { conv: t.conv.slice(0, 8), at: t.at, scene: t.scene, staffPath: t.staff, prodPrev: t.prev };
    try {
      const { data: conv } = await sb.from("conversations").select("customer_name").eq("id", t.conv).maybeSingle();
      const { data } = await sb.from("messages").select("id, sender, text, created_at, is_aix_generated").eq("conversation_id", t.conv).lte("created_at", t.at).order("created_at", { ascending: false }).limit(50);
      const ms = ((data ?? []) as Msg[]).reverse();
      let end = ms.length - 1; while (end >= 0 && ms[end].sender !== "customer") end--;
      let start = end; while (start - 1 >= 0 && ms[start - 1].sender === "customer") start--;
      if (end - start < 1) { rec.skip = "連投でない"; appendFileSync(OUT, JSON.stringify(rec) + "\n"); continue; }
      const ctx = ms.slice(Math.max(0, start - 29), start), burst = ms.slice(start, end + 1);
      const cut = h.cutBeforeApplicationMaterial([...ctx, ...burst]);
      if (cut.cutAt !== null && cut.cutAt < ctx.length + burst.length) { rec.skip = "書類"; appendFileSync(OUT, JSON.stringify(rec) + "\n"); continue; }
      const nm = addressNamesOf(ms.filter((x) => x.sender !== "customer").map((x) => x.text ?? ""));
      const mask = (s: string | null) => maskText(s ?? "", (conv?.customer_name as string | null) ?? null, nm);
      const rows = [...ctx, ...burst].map((m) => ({ s: m.sender === "customer" ? "customer" : "staff", t: mask(m.text) || "[画像]", aix: !!m.is_aix_generated }));
      h.assertSceneSafe(rows.map((r) => r.t), t.conv.slice(0, 8));
      rec.burst = burst.map((m) => mask(m.text).slice(0, 80));
      rec.pc = await copyPc(t.conv, yumaPc);
      await h.waitUntilYumaQuiet(own);
      const times = h.sceneTimes(rows.length, { stepSec: 90 });
      // 1段目: 場面の前の会話＋連投の1通目（P と A1 用）。2段目で残りの連投を足す
      const firstLen = ctx.length + 1;
      const ins1 = await sb.from("messages").insert(rows.slice(0, firstLen).map((m, i) => ({ conversation_id: YUMA, sender: m.s, text: m.t, is_aix_generated: m.aix, line_message_id: `${PREFIX}${randomUUID()}`, created_at: times[i] }))).select("id");
      if (ins1.error) throw new Error(ins1.error.message);
      own = ((ins1.data ?? []) as Array<{ id: string }>).map((r) => r.id);
      writeFloor(new Date(Date.parse(times[0]) - 1000).toISOString());
      await new Promise((r) => setTimeout(r, 1300));
      const run = async (prev: { phase: string | null; aix: string | null }) => {
        h!.assertYuma(YUMA, "brain");
        for (let attempt = 0; attempt < 2; attempt++) {
          const m = await runInDeepseekScope(async () => { setDeepseekScope({ conversationId: YUMA, mark: { kind: "all" } }); return analyzeConversation(YUMA, true, "proposing", rec.pc ? yumaPc : null, "brain", { autoSendEnabled: true, customerName: "YUMA", prevPhase: prev.phase, prevAix: prev.aix, mode: "full", layer: "combined", strategy: null }); }) as unknown as Record<string, unknown> | null;
          if (m) return m;
        }
        throw new Error("ブレインが null");
      };
      // P: 連投の前（1通目を一時的に隠す＝1通目の行を消して流し、戻す）
      const firstId = own[own.length - 1];
      const firstRow = rows[firstLen - 1];
      await sb.from("messages").delete().in("id", [firstId]); own = own.slice(0, -1);
      const P = await run({ phase: null, aix: t.prev?.action ?? null });
      rec.P = pick(P);
      const re = await sb.from("messages").insert({ conversation_id: YUMA, sender: firstRow.s, text: firstRow.t, is_aix_generated: firstRow.aix, line_message_id: `${PREFIX}${randomUUID()}`, created_at: times[firstLen - 1] }).select("id");
      if (re.error) throw new Error(re.error.message);
      own.push(((re.data ?? []) as Array<{ id: string }>)[0].id);
      await new Promise((r) => setTimeout(r, 800));
      const pDir = dirOf(P);
      const A1s: Array<Record<string, unknown>> = [];
      for (let k = 0; k < REPS; k++) A1s.push(await run(pDir));
      rec.A1 = A1s.map(pick);
      // 2段目: 残りの連投
      const ins2 = await sb.from("messages").insert(rows.slice(firstLen).map((m, i) => ({ conversation_id: YUMA, sender: m.s, text: m.t, is_aix_generated: m.aix, line_message_id: `${PREFIX}${randomUUID()}`, created_at: times[firstLen + i] }))).select("id");
      if (ins2.error) throw new Error(ins2.error.message);
      own.push(...((ins2.data ?? []) as Array<{ id: string }>).map((r) => r.id));
      await new Promise((r) => setTimeout(r, 800));
      const now: unknown[] = [], prop: unknown[] = [];
      for (let k = 0; k < REPS; k++) {
        const a1 = dirOf(A1s[k]);
        rec[`same_state_${k}`] = a1.phase === pDir.phase && a1.aix === pDir.aix;
        now.push(pick(await run(a1)));
        prop.push(pick(await run(pDir)));
      }
      rec.now = now; rec.prop = prop;
    } catch (e) { rec.error = e instanceof Error ? e.message : String(e); }
    finally { writeFloor(null); await clearOwn(); }
    appendFileSync(OUT, JSON.stringify(rec) + "\n");
    const show = (xs: unknown) => ((xs as Array<{ reply_mode: string; action: string }> | undefined) ?? []).map((x) => (x.reply_mode === "aix" ? x.action : "返信")).join(",");
    console.log(`${rec.conv} [${rec.scene}] 人=${t.staff.join(",")} P=${show([rec.P])} A1=${show(rec.A1)} 今=${show(rec.now)} 案=${show(rec.prop)} ${rec.error ?? rec.skip ?? ""}`);
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  console.log(`書き出し: ${OUT}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  writeFloor(null);
  await clearOwn().catch(() => {});
  await restorePc().catch((e) => console.warn("restorePc:", String(e)));
  if (h) await h.finish();
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
});
