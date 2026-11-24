// scripts/audit-aix-state-doc-preview.ts — 札の資料の読み（AIX_STATE_CARD_DOC）を on にできるかの下見（台帳 #688・読むだけ・LLM なし・費用 0）
// 2026-11-25 作業員A（統括役の頼み・朝8時までの手空き）:
//   ① 本番の直近 N 日のブレインの番ごとに、今の読み（brain-core の property_pickups・30日・20件・pdf_text 込み）で届く件数・字数と、読みの時間（DB と計算）
//   ② 軽い形（先に時刻だけ20件→最後の束の id だけ pdf_text を読む）の時間
//   ③ 60日の竹内さん本人の番で「確認した／物件確認した」の取り違えの番（竹内さんかブレインのどちらかが確認した・物件確認した・二人が違う）に、札の doc 欄が分かれ目になっているか
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-state-doc-preview.ts [--days=7] [--sample=40] [--mix-days=60]
import { createClient } from "@supabase/supabase-js";
import { performance } from "node:perf_hooks";
import { isTestConversation } from "../app/lib/test-conversations";
import { docFactsOf, DOC_TOPICS, type DocPickup } from "../app/lib/aix-state-doc";
import { detectContractTermTopics } from "../app/lib/contract-terms-question";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "7")), SAMPLE = Number(arg("sample", "40")), MIX_DAYS = Number(arg("mix-days", "60"));
const COLS = "property_name, room_no, created_at, terms, pdf_text, image_lines";
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };

async function fetchNow(conv: string, at: number) {
  return sb.from("property_pickups").select(COLS).eq("conversation_id", conv).eq("status", "sent").lte("created_at", new Date(at).toISOString())
    .gte("created_at", new Date(at - 30 * 86_400_000).toISOString()).order("created_at", { ascending: false }).limit(20);
}
async function fetchLight(conv: string, at: number) {
  const { data: hd } = await sb.from("property_pickups").select("id, created_at").eq("conversation_id", conv).eq("status", "sent").lte("created_at", new Date(at).toISOString())
    .gte("created_at", new Date(at - 30 * 86_400_000).toISOString()).order("created_at", { ascending: false }).limit(20);
  const xs = (hd ?? []) as Array<{ id: string; created_at: string }>;
  if (!xs.length) return [];
  const t0 = Date.parse(xs[0].created_at);
  const ids = xs.filter((r) => t0 - Date.parse(r.created_at) <= 30 * 60_000).map((r) => r.id);
  const { data } = await sb.from("property_pickups").select(COLS).in("id", ids);
  return (data ?? []) as DocPickup[];
}

async function partTime() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const { data } = await sb.from("brain_decision_logs").select("conversation_id, created_at").gte("created_at", since).order("created_at", { ascending: false }).limit(5000);
  const turns = ((data ?? []) as Array<{ conversation_id: string; created_at: string }>).filter((t) => !isTestConversation(t.conversation_id));
  const step = Math.max(1, Math.floor(turns.length / SAMPLE));
  const pick = turns.filter((_, i) => i % step === 0).slice(0, SAMPLE);
  const msNow: number[] = [], msLight: number[] = [], msCalc: number[] = [], kb: number[] = [];
  let withRows = 0;
  for (const t of pick) {
    const at = Date.parse(t.created_at);
    const a = performance.now(); const { data: r1 } = await fetchNow(t.conversation_id, at); const b = performance.now();
    const rows = (r1 ?? []) as DocPickup[];
    msNow.push(b - a);
    kb.push(JSON.stringify(rows).length / 1024);
    if (rows.length) withRows++;
    const c = performance.now(); docFactsOf(rows, at); msCalc.push(performance.now() - c);
    const d = performance.now(); await fetchLight(t.conversation_id, at); msLight.push(performance.now() - d);
  }
  console.log(`■ ① 読みの時間（直近${DAYS}日のブレインの番 ${turns.length} から ${pick.length} 番・送った物件のある番 ${withRows}）`);
  console.log(`  今の読み（20件・pdf_text 込み）: DB p50 ${q(msNow, 0.5).toFixed(0)}ms・p90 ${q(msNow, 0.9).toFixed(0)}ms・最大 ${Math.max(...msNow).toFixed(0)}ms／届く大きさ p50 ${q(kb, 0.5).toFixed(0)}KB・p90 ${q(kb, 0.9).toFixed(0)}KB・最大 ${Math.max(...kb).toFixed(0)}KB`);
  console.log(`  計算（docFactsOf・9項目）: p50 ${q(msCalc, 0.5).toFixed(1)}ms・p90 ${q(msCalc, 0.9).toFixed(1)}ms・最大 ${Math.max(...msCalc).toFixed(1)}ms`);
  console.log(`  軽い形（時刻だけ20件→最後の束だけ pdf_text）: DB p50 ${q(msLight, 0.5).toFixed(0)}ms・p90 ${q(msLight, 0.9).toFixed(0)}ms・最大 ${Math.max(...msLight).toFixed(0)}ms`);
}

type Turn = { id: number; conversation_id: string; customer_turn_at: string; customer_last_at: string | null; brain_action: string | null; brain_reply_mode: string | null; staff_aix: Array<{ at: string; aix_type: string; burst: boolean }> | null; verdict_detail: Record<string, unknown> | null };
const C = new Set(["acknowledge_check", "property_check_result"]);
const JA: Record<string, string> = { acknowledge_check: "確認した", property_check_result: "物件確認した", 返信: "返信" };
const ja = (k: string) => JA[k] ?? k;

async function partMix() {
  const since = new Date(Date.now() - MIX_DAYS * 86_400_000).toISOString();
  const turns: Turn[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, customer_last_at, brain_action, brain_reply_mode, staff_aix, verdict_detail").gte("customer_turn_at", since).order("id").range(f, f + 999);
    if (error) throw new Error(error.message);
    turns.push(...((data ?? []) as Turn[]));
    if ((data ?? []).length < 1000) break;
  }
  const base = turns.filter((t) => !isTestConversation(t.conversation_id) && !["duplicate_turn", "out_of_scope"].includes(String((t.verdict_detail ?? {}).reason ?? "")) && t.brain_reply_mode);
  const brainOf = (t: Turn) => (t.brain_reply_mode === "aix" && t.brain_action ? t.brain_action : "返信");
  const staffOf = (t: Turn) => (t.staff_aix ?? []).find((a) => a.burst)?.aix_type ?? "返信";
  const cand = base.filter((t) => (C.has(brainOf(t)) || C.has(staffOf(t))) && brainOf(t) !== staffOf(t));
  type Out = { pair: string; tk: string; br: string; asked: string[]; cls: string; props: number };
  const out: Out[] = [];
  let notTk = 0, noMove = 0;
  for (const t of cand) {
    const last = Date.parse(t.customer_last_at ?? t.customer_turn_at);
    const { data: ms } = await sb.from("messages").select("sender, staff_writer, text, created_at").eq("conversation_id", t.conversation_id)
      .gte("created_at", t.customer_turn_at).lte("created_at", new Date(last + 6 * 3_600_000).toISOString()).order("created_at");
    const xs = (ms ?? []) as Array<{ sender: string; staff_writer: string | null; text: string | null; created_at: string }>;
    const firstStaff = xs.find((m) => m.sender === "staff" && Date.parse(m.created_at) > last);
    if (!firstStaff) { noMove++; continue; }
    if (firstStaff.staff_writer !== "takeuchi") { notTk++; continue; }
    const cust = xs.filter((m) => m.sender === "customer" && Date.parse(m.created_at) <= last).map((m) => m.text ?? "").join("\n");
    const { data: pk } = await fetchNow(t.conversation_id, last);
    const facts = docFactsOf((pk ?? []) as DocPickup[], last);
    const asked = detectContractTermTopics(cust).filter((tp) => (DOC_TOPICS as readonly string[]).includes(tp));
    let cls: string;
    if (!facts) cls = "送った物件なし";
    else if (!asked.length) cls = "資料の項目を聞いていない";
    else {
      const all = asked.every((tp) => { const c = facts.topics[tp]; return !!c && c.material === facts.properties; });
      const none = asked.some((tp) => { const c = facts.topics[tp]; return !c || c.material === 0; });
      cls = all ? "聞いた項目が全部資料にある" : none ? "聞いた項目が資料に無い" : "一部の物件だけ資料にある";
    }
    out.push({ pair: `竹内さん ${ja(staffOf(t))}／ブレイン ${ja(brainOf(t))}`, tk: staffOf(t), br: brainOf(t), asked, cls, props: facts?.properties ?? 0 });
  }
  console.log(`\n■ ③ 竹内さん本人の番の「確認した／物件確認した」の取り違え（${MIX_DAYS}日・見張りの番 ${base.length}・候補 ${cand.length}・竹内さんの番 ${out.length}・従業員の番 ${notTk}・スタッフの一手なし ${noMove}）`);
  const pairs = [...new Set(out.map((o) => o.pair))].sort();
  const clsAll = ["聞いた項目が全部資料にある", "一部の物件だけ資料にある", "聞いた項目が資料に無い", "資料の項目を聞いていない", "送った物件なし"];
  console.log(`| 組 | n | ${clsAll.join(" | ")} |\n|---|---|${clsAll.map(() => "---").join("|")}|`);
  for (const p of pairs) { const xs = out.filter((o) => o.pair === p); console.log(`| ${p} | ${xs.length} | ${clsAll.map((c) => xs.filter((o) => o.cls === c).length).join(" | ")} |`); }
  // 分かれ目: 資料の項目を聞いた番で「全部資料にある→返信・資料に無い→確認した」と竹内さんが合うか
  const ask = out.filter((o) => o.cls === "聞いた項目が全部資料にある" || o.cls === "聞いた項目が資料に無い");
  const docSays = (o: Out) => (o.cls === "聞いた項目が全部資料にある" ? "返信" : "acknowledge_check");
  const agreeTk = ask.filter((o) => docSays(o) === o.tk).length, agreeBr = ask.filter((o) => docSays(o) === o.br).length;
  console.log(`\n資料の項目を聞いた番 ${ask.length}: 札の doc の向き（全部ある→返信・無い→確認した）が 竹内さんと合う ${agreeTk}・ブレインと合う ${agreeBr}`);
  const topics = new Map<string, number>(); for (const o of out) for (const tp of o.asked) topics.set(tp, (topics.get(tp) ?? 0) + 1);
  console.log(`聞いた項目: ${[...topics].map(([k, v]) => `${k} ${v}`).join("・") || "なし"}`);
}

// ④ 60日の竹内さん本人の番のうち、お客様が資料の項目（礼金・保証会社・駐車場…）を聞いた番で、doc 欄の向きと竹内さんの一手が合うか（取り違えに限らない）＋聞いた番の割合（読む番を聞いた番に絞った時の数）
async function partAsked() {
  const since = new Date(Date.now() - MIX_DAYS * 86_400_000).toISOString();
  const turns: Turn[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, customer_last_at, brain_action, brain_reply_mode, staff_aix, verdict_detail").gte("customer_turn_at", since).order("id").range(f, f + 999);
    if (error) throw new Error(error.message);
    turns.push(...((data ?? []) as Turn[]));
    if ((data ?? []).length < 1000) break;
  }
  const base = turns.filter((t) => !isTestConversation(t.conversation_id) && !["duplicate_turn", "out_of_scope"].includes(String((t.verdict_detail ?? {}).reason ?? "")));
  let tkN = 0, askedN = 0;
  const tab = new Map<string, number>();
  for (const t of base) {
    const last = Date.parse(t.customer_last_at ?? t.customer_turn_at);
    const { data: ms } = await sb.from("messages").select("sender, staff_writer, text, created_at").eq("conversation_id", t.conversation_id)
      .gte("created_at", t.customer_turn_at).lte("created_at", new Date(last + 6 * 3_600_000).toISOString()).order("created_at");
    const xs = (ms ?? []) as Array<{ sender: string; staff_writer: string | null; text: string | null; created_at: string }>;
    const fs0 = xs.find((m) => m.sender === "staff" && Date.parse(m.created_at) > last);
    if (!fs0 || fs0.staff_writer !== "takeuchi") continue;
    tkN++;
    const cust = xs.filter((m) => m.sender === "customer" && Date.parse(m.created_at) <= last).map((m) => m.text ?? "").join("\n");
    const asked = detectContractTermTopics(cust).filter((tp) => (DOC_TOPICS as readonly string[]).includes(tp));
    if (!asked.length) continue;
    askedN++;
    const { data: pk } = await fetchNow(t.conversation_id, last);
    const facts = docFactsOf((pk ?? []) as DocPickup[], last);
    const cls = !facts ? "送った物件なし" : asked.every((tp) => { const c = facts.topics[tp]; return !!c && c.material === facts.properties; }) ? "全部ある" : asked.some((tp) => { const c = facts.topics[tp]; return !c || c.material === 0; }) ? "無い" : "一部";
    const tk = (t.staff_aix ?? []).find((a) => a.burst)?.aix_type ?? "返信";
    const br = t.brain_reply_mode === "aix" && t.brain_action ? t.brain_action : t.brain_reply_mode ? "返信" : "記録なし";
    const k = `${cls}｜竹内さん ${ja(tk)}｜ブレイン ${ja(br)}｜${asked.join("+")}`; tab.set(k, (tab.get(k) ?? 0) + 1);
  }
  console.log(`\n■ ④ 資料の項目を聞いた竹内さん本人の番（${MIX_DAYS}日・竹内さんの番 ${tkN}・資料の項目を聞いた番 ${askedN}＝${tkN ? Math.round((askedN / tkN) * 100) : 0}%）`);
  for (const [k, v] of [...tab].sort()) console.log(`  ${k}: ${v}`);
}

(async () => {
  const has = (k: string) => process.argv.includes(k);
  if (!has("--mix-only") && !has("--asked-only")) await partTime();
  if (!has("--time-only") && !has("--asked-only")) await partMix();
  if (has("--asked") || has("--asked-only")) await partAsked();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
