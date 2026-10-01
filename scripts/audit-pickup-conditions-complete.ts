// scripts/audit-pickup-conditions-complete.ts — 「条件がそろった」の線を実データで引く（読むだけ・LLM なし）
// 2026-10-02 竹内さんの決定「物件ピックアップは条件がそろってから。そろっていなければ AIX【条件ヒアリング】」:
//   スタッフが**最初の物件ピックアップを送った時点**で、お客様の条件のどの項目が分かっていたかを数える。
//   ①property_customers（最新値しか持たないので property_condition_history で巻き戻す。※履歴は 8/20〜・変更の一部だけ＝上ぶれする）
//   ②お客様のその時点までの発言で各項目に触れていたか（粗い正規表現・測るためだけ）
//   あわせて、スタッフが条件ヒアリング（AIX またはフォームの手打ち）を送った時点も数える（＝そろっていない時の形）。
// 実行: npx tsx --env-file=.env.local scripts/audit-pickup-conditions-complete.ts [--days=180] [--show]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { pickupConditionsReady, type HearingKnown } from "../app/lib/hearing-form";
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "180"));
const SHOW = process.argv.includes("--show");
const SHOW_NOT_READY = process.argv.includes("--not-ready");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 400_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}
const FIELDS = ["desired_area", "rent_max", "rent_min", "floor_plan", "move_in_time", "walk_minutes", "building_age", "initial_cost_limit", "preferences", "other_requests", "commute_station"] as const;
type PcRow = Record<string, unknown> & { id: string; created_at: string };
type Hist = { property_customer_id: string; changed_field: string; old_value: string | null; new_value: string | null; created_at: string };
function stateAt(pc: PcRow | undefined, hist: Hist[], at: string): Record<string, unknown> | null {
  if (!pc || pc.created_at > at) return null;
  const s: Record<string, unknown> = { ...pc };
  for (const h of hist.filter((h) => h.created_at > at).sort((a, b) => b.created_at.localeCompare(a.created_at))) s[h.changed_field] = h.old_value;
  return s;
}
/** お客様の発言で各項目に触れているか（測るためだけの粗い線） */
function textItems(t: string): Set<string> {
  const s = new Set<string>();
  if (/区|市内|駅|線|エリア|周辺|付近|辺り|あたり|梅田|難波|なんば|心斎橋|天王寺|本町|京橋|堀江|福島|中津|天満|谷町|江坂|十三|新大阪|上本町|北浜/.test(t)) s.add("area");
  if (/[0-9０-９.．]+\s*万|[0-9,，]{5,}\s*円|家賃/.test(t)) s.add("rent");
  if (/[1-4１-４]\s*(?:S?LDK|DK|K|ldk|dk|k|Ｋ|ＬＤＫ|ＤＫ)|ワンルーム|1R|１R|[0-9０-９]+\s*畳|㎡|平米|間取り/.test(t)) s.add("plan");
  if (/入居|[0-9０-９]+\s*月|年内|すぐ|いつでも|未定|急ぎ|最短|引っ越し|引越/.test(t)) s.add("move");
  return s;
}
const filled = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== "" && String(v) !== "0";
async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const [convs, presses, pcs, hist, hearMsgs, custMsgs] = await Promise.all([
    readAll<{ id: string; property_customer_id: string | null }>((f, t) => sb.from("conversations").select("id, property_customer_id").range(f, t)),
    readAll<{ conversation_id: string; aix_type: string; created_at: string }>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at").gte("created_at", since).in("aix_type", ["property_send", "property_recommendation", "condition_hearing"]).order("created_at").range(f, t)),
    readAll<PcRow>((f, t) => sb.from("property_customers").select(`id, created_at, ${FIELDS.join(", ")}`).range(f, t)),
    readAll<Hist>((f, t) => sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, new_value, created_at").range(f, t)),
    readAll<{ conversation_id: string; created_at: string; text: string }>((f, t) => sb.from("messages").select("conversation_id, created_at, text").neq("sender", "customer").gte("created_at", since).ilike("text", "%①%入居%").order("created_at").range(f, t)),
    readAll<{ conversation_id: string; created_at: string; text: string | null }>((f, t) => sb.from("messages").select("conversation_id, created_at, text").eq("sender", "customer").gte("created_at", new Date(Date.now() - (DAYS + 60) * 86_400_000).toISOString()).order("created_at").order("id").range(f, t)),
  ]);
  const pcById = new Map(pcs.map((p) => [p.id, p]));
  const histBy = new Map<string, Hist[]>(); for (const h of hist) { if (!histBy.has(h.property_customer_id)) histBy.set(h.property_customer_id, []); histBy.get(h.property_customer_id)!.push(h); }
  const custBy = new Map<string, { created_at: string; text: string | null }[]>(); for (const m of custMsgs) { if (!custBy.has(m.conversation_id)) custBy.set(m.conversation_id, []); custBy.get(m.conversation_id)!.push(m); }
  const convPc = new Map(convs.map((c) => [c.id, c.property_customer_id]));
  const firstPick = new Map<string, string>();
  for (const p of presses) if ((p.aix_type === "property_send" || p.aix_type === "property_recommendation") && !firstPick.has(p.conversation_id)) firstPick.set(p.conversation_id, p.created_at);
  const hearAt = new Map<string, string>();
  for (const p of presses) if (p.aix_type === "condition_hearing" && !hearAt.has(p.conversation_id)) hearAt.set(p.conversation_id, p.created_at);
  for (const m of hearMsgs) if (!hearAt.has(m.conversation_id)) hearAt.set(m.conversation_id, m.created_at);
  const tally = (label: string, events: Map<string, string>) => {
    let n = 0, noPc = 0; const cnt: Record<string, number> = {}; const combos = new Map<string, number>(); const textCombos = new Map<string, number>(); const ready = new Map<string, number>(); const ex: string[] = [];
    for (const [cid, at] of events) {
      if (isTestConversation(cid)) continue;
      n++;
      const ctext = (custBy.get(cid) ?? []).filter((m) => m.created_at < at).map((m) => m.text ?? "").join("\n");
      const tk = textItems(ctext);
      const tkKey = ["area", "rent", "plan", "move"].map((k) => tk.has(k) ? "1" : "0").join("");
      textCombos.set(tkKey, (textCombos.get(tkKey) ?? 0) + 1);
      const s = stateAt(pcById.get(convPc.get(cid) ?? ""), histBy.get(convPc.get(cid) ?? "") ?? [], at);
      const rd = pickupConditionsReady(s as HearingKnown | null, (custBy.get(cid) ?? []).filter((m) => m.created_at < at).map((m) => m.text ?? ""));
      const rk = `${rd.ready ? "そろった" : "足りない"}(${rd.source}${rd.missing.length ? ":" + rd.missing.join("+") : ""})`;
      ready.set(rk, (ready.get(rk) ?? 0) + 1);
      if (SHOW_NOT_READY && !rd.ready && label.startsWith("最初")) console.log(`  [足りない] ${cid.slice(0, 8)} ${at.slice(0, 16)} ${rk}｜${(custBy.get(cid) ?? []).filter((m) => m.created_at < at).slice(-4).map((m) => (m.text ?? "").replace(/\n/g, " ")).join(" / ").slice(0, 200)}`);
      if (SHOW && ex.length < 40) ex.push(`${cid.slice(0, 8)} ${at.slice(0, 10)} text=${tkKey} pc=${s ? `area=${s.desired_area ?? "-"} rent=${s.rent_max ?? "-"} plan=${s.floor_plan ?? "-"} move=${s.move_in_time ?? "-"}` : "なし"}`);
      if (!s) { noPc++; continue; }
      const has = FIELDS.filter((f) => filled(s[f]));
      for (const f of has) cnt[f] = (cnt[f] ?? 0) + 1;
      const core = ["desired_area|commute_station", "rent_max", "floor_plan", "move_in_time"].map((k) => k.split("|").some((f) => filled(s[f])) ? "1" : "0").join("");
      combos.set(core, (combos.get(core) ?? 0) + 1);
    }
    const withPc = n - noPc;
    console.log(`\n=== ${label}: n=${n}（条件の行なし ${noPc}・あり ${withPc}）`);
    for (const f of FIELDS) console.log(`  ${f.padEnd(20)} ${cnt[f] ?? 0}/${withPc} = ${withPc ? (((cnt[f] ?? 0) / withPc) * 100).toFixed(0) : 0}%`);
    console.log("  条件の行の組み合わせ（エリアor通勤先・家賃上限・間取り・入居）:");
    for (const [k, v] of [...combos].sort((a, b) => b[1] - a[1])) console.log(`    ${k} ${v}`);
    console.log("  お客様の発言（その時点まで）で読める項目（エリア・家賃・間取り・入居）:");
    for (const [k, v] of [...textCombos].sort((a, b) => b[1] - a[1])) console.log(`    ${k} ${v}`);
    console.log("  pickupConditionsReady:");
    for (const [k, v] of [...ready].sort((a, b) => b[1] - a[1])) console.log(`    ${k} ${v}`);
    for (const e of ex) console.log("   ", e);
  };
  tally("最初の物件ピックアップ（AIX 物件ピックアップ／オススメの最初の押下）", firstPick);
  tally("条件ヒアリングを送った時（AIX 押下 or フォームの手打ち）", hearAt);
}
main().catch((e) => { console.error(e); process.exit(1); });
