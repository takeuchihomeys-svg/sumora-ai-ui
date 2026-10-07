// scripts/audit-unpressed-aix-text.ts — 押されない AIX（保証会社について／物件を探す／内覧挨拶）の「なぜ押されないか」を実物で（読むだけ・LLM なし）
//
// 2026-10-07 竹内「文の質をあげてボタンとしてつかっていく」（AIX の判断のずれの調査: guarantor_info 提案20・押下0／property_search 37・0／greeting_viewing 9・0）
//   --check=g  : お客様の保証会社の問い（200日）の後に、スタッフが手で何を送ったか（1件の答え／一覧）を並べる
//   --check=ps : スタッフの手打ちの「ピックアップしてお送りさせて頂きます」の型の数（120日）と、出口の注意（propertySearchTextIssues）が手打ちに当たる数（0 であること）
//   --check=gv : AIX【内覧挨拶】の生成（aix_generate_log）が30分以内にそのまま／直して／送らずのどれか・崩れ（形の記号・「お客様」呼び）
//   押下（aix_usage_logs）・生成（aix_generate_log）・ブレインの提案（brain_decision_logs）の数も出す
// 実行: npx tsx --env-file=.env.local scripts/audit-unpressed-aix-text.ts --check=g,ps,gv [--days=200]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { propertySearchTextIssues } from "../app/lib/property-search-promise";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const CHECK = arg("check", "g,ps,gv").split(",");
const DAYS = Number(arg("days", "200"));
const since = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();
const flat = (s: string, n = 200) => s.replace(/\s+/g, " ").slice(0, n);
const norm = (s: string) => s.replace(/\s+/g, "");
function dice(a: string, b: string): number {
  const g = (s: string) => { const m = new Map<string, number>(); const t = norm(s); for (let i = 0; i < t.length - 1; i++) { const k = t.slice(i, i + 2); m.set(k, (m.get(k) ?? 0) + 1); } return m; };
  const A = g(a), B = g(b); let inter = 0, tot = 0;
  for (const [k, v] of A) { inter += Math.min(v, B.get(k) ?? 0); tot += v; }
  for (const [, v] of B) tot += v;
  return tot ? (2 * inter) / tot : 0;
}
type Row = { conversation_id: string; created_at: string; text: string | null; is_aix_generated: boolean | null; sender: string };
async function readMessages(sender: "customer" | "staff", like: string, days: number): Promise<Row[]> {
  const out: Row[] = [];
  for (let f = 0; f < 400_000; f += 1000) {
    let q = sb.from("messages").select("conversation_id, created_at, text, is_aix_generated, sender").ilike("text", like).gte("created_at", since(days)).order("created_at").range(f, f + 999);
    q = sender === "customer" ? q.eq("sender", "customer") : q.neq("sender", "customer");
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Row[]) if (!isTestConversation(r.conversation_id) && r.text) out.push(r);
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function counts() {
  for (const t of ["guarantor_info", "property_search", "greeting_viewing"]) {
    const a = await sb.from("brain_decision_logs").select("id", { count: "exact", head: true }).eq("suggested_action", t);
    const u = await sb.from("aix_usage_logs").select("id", { count: "exact", head: true }).eq("aix_type", t);
    const g = await sb.from("aix_generate_log").select("id", { count: "exact", head: true }).eq("action_type", t);
    console.log(`${t}: ブレインの提案 ${a.count}・押下（aix_usage_logs）${u.count}・生成（aix_generate_log）${g.count}`);
  }
}

async function checkGuarantor() {
  const cs = (await readMessages("customer", "%保証会社%", DAYS)).filter((r) => /[？?]|どこ|ですか|ますか|でしょうか|厳し|きつ|通り|通る|大丈夫/.test(r.text!) && r.text!.length < 200);
  console.log(`\n== 保証会社の問い ${cs.length}（${DAYS}日）→ 24時間以内のスタッフの「保証」を含む最初の文`);
  let answered = 0;
  for (const r of cs) {
    const { data } = await sb.from("messages").select("text, is_aix_generated, sender, created_at").eq("conversation_id", r.conversation_id).gt("created_at", r.created_at).lt("created_at", new Date(Date.parse(r.created_at) + 24 * 3600_000).toISOString()).order("created_at").limit(6);
    const g = ((data ?? []) as Row[]).find((m) => m.sender !== "customer" && /保証/.test(String(m.text)));
    if (g) answered++;
    console.log(`● ${r.created_at.slice(0, 16)} ${r.conversation_id.slice(0, 8)} 客「${flat(r.text!, 100)}」\n  人${g?.is_aix_generated ? "(AIX)" : ""}「${g ? flat(String(g.text), 220) : "（なし）"}」${g ? ` 遅れ=${Math.round((Date.parse(g.created_at) - Date.parse(r.created_at)) / 60000)}分` : ""}`);
  }
  console.log(`保証の話で答えた番 ${answered}/${cs.length}`);
}

async function checkPropertySearch() {
  const rows = (await readMessages("staff", "%ピックアップ%", 120)).filter((r) => !r.is_aix_generated && /させて(頂|いただ)きます|お送り/.test(r.text!) && !/🌟|号室|━|【1】|はじめまして|募集状況|否決|ご入力/.test(r.text!) && r.text!.length < 260);
  const c = (re: RegExp) => rows.filter((r) => re.test(r.text!)).length;
  console.log(`\n== 手打ちの探す約束 ${rows.length}（120日）`);
  console.log({ "😊": c(/😊/), "ピックアップ(し|して)お送り": c(/ピックアップ(し|して)お送り/), "かしこまりました": c(/^.{0,20}かしこまりました/), "ピックアップさせて頂きます": c(/ピックアップさせて(頂|いただ)きます/), "全域": c(/全域/), "オススメできるお部屋": c(/オススメ(でき|出来)るお部屋/), "全力でサポート": c(/全力でサポート/), "新たに": c(/新たに/), "とんでもございません/全然大丈夫": c(/とんでもございません|全然大丈夫/) });
  const hits = rows.map((r) => ({ r, is: propertySearchTextIssues(r.text!) })).filter((x) => x.is.length);
  console.log(`出口の注意が手打ちに当たる: ${hits.length}/${rows.length}`);
  for (const h of hits) console.log(`  ${h.is.join("・")} ${flat(h.r.text!, 150)}`);
}

async function checkGreeting() {
  const { data } = await sb.from("aix_generate_log").select("conversation_id, created_at, generated_text").eq("action_type", "greeting_viewing").order("created_at");
  const b: Record<string, number> = {}; const broken: string[] = [];
  for (const r of (data ?? []) as Array<{ conversation_id: string | null; created_at: string; generated_text: string | null }>) {
    if (!r.conversation_id || isTestConversation(r.conversation_id)) continue;
    const g = String(r.generated_text ?? "");
    if (/[①②③]\s*「|」\s*\n/.test(g)) broken.push(`形の記号: ${flat(g, 110)}`);
    if (/^お客様/.test(g)) broken.push(`「お客様」呼び: ${flat(g, 110)}`);
    if (/^ご連絡頂きありがとうございます/.test(g)) broken.push(`初回の挨拶: ${flat(g, 110)}`);
    const kind = /ありがとうございました/.test(g) ? "後" : "前";
    const { data: ms } = await sb.from("messages").select("text").eq("conversation_id", r.conversation_id).neq("sender", "customer").gte("created_at", r.created_at).lt("created_at", new Date(Date.parse(r.created_at) + 30 * 60000).toISOString()).limit(4);
    const best = ((ms ?? []) as Array<{ text: string | null }>).map((m) => ({ t: String(m.text ?? ""), s: dice(g, String(m.text ?? "")) })).sort((x, y) => y.s - x.s)[0];
    const k = !best || best.s < 0.5 ? "送らず" : norm(best.t) === norm(g) ? "そのまま" : "直して";
    b[`${kind}:${k}`] = (b[`${kind}:${k}`] ?? 0) + 1;
  }
  console.log(`\n== 内覧挨拶の生成 → 30分以内の送信（YUMA 除く）`, b);
  for (const x of broken) console.log(`  ${x}`);
}

(async () => {
  await counts();
  if (CHECK.includes("g")) await checkGuarantor();
  if (CHECK.includes("ps")) await checkPropertySearch();
  if (CHECK.includes("gv")) await checkGreeting();
})().catch((e) => { console.error(e); process.exitCode = 1; });
