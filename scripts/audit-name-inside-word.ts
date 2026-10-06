// scripts/audit-name-inside-word.ts
// 2026-10-06 竹内（し 事例・「か角田こまりま角田た」）の全件監査。DB は読むだけ・LLM は呼ばない。
//   ① 名前が語の途中に入った文（detectNameInsideWord）が、AI 下書き・実送信（スタッフ・AIX）に何通あるか（送られた物があるか）
//   ② 表示名の置き換え（enforceCustomerName の①）を旧（語の境目を見ずに全部）と新（replaceDisplayStandalone）で当て、
//      違いが出る文を目で読む（新で置き換えが残る所も全部出す）
// 実行: npx tsx --env-file=.env.local scripts/audit-name-inside-word.ts [--days=400] [--show=40]
import { createClient } from "@supabase/supabase-js";
import { detectNameInsideWord } from "@/app/lib/name-inside-word";
import { replaceDisplayStandalone, isPlausiblePersonName } from "@/app/lib/validate-reply";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const DAYS = Number(arg("days", "400"));
const SHOW = Number(arg("show", "40"));

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
  type Conv = { id: string; customer_name: string | null; call_name: string | null; property_customer_id: string | null };
  const convs = await pageAll<Conv>((a, b) => sb.from("conversations").select("id, customer_name, call_name, property_customer_id").range(a, b));
  const pcs = await pageAll<{ id: string; customer_name: string | null }>((a, b) => sb.from("property_customers").select("id, customer_name").range(a, b));
  const pcName = new Map(pcs.map((p) => [p.id, (p.customer_name ?? "").trim()]));
  const namesOf = new Map<string, { display: string; names: string[]; canonical: string }>();
  for (const c of convs) {
    const display = (c.customer_name ?? "").trim();
    const pc = c.property_customer_id ? pcName.get(c.property_customer_id) ?? "" : "";
    const call = (c.call_name ?? "").trim();
    const canonical = [call, pc].find((n) => n && isPlausiblePersonName(n)) ?? "";
    namesOf.set(c.id, { display, names: [display, call, pc].filter(Boolean), canonical });
  }

  type Ex = { id: string; conversation_id: string | null; ai_draft: string | null; sent_reply: string | null; created_at: string };
  const exs = await pageAll<Ex>((a, b) => sb.from("ai_reply_examples").select("id, conversation_id, ai_draft, sent_reply, created_at").gte("created_at", since).order("created_at").range(a, b));
  type Msg = { id: string; conversation_id: string; text: string | null; sender: string; is_aix_generated: boolean | null; created_at: string };
  const msgs = await pageAll<Msg>((a, b) => sb.from("messages").select("id, conversation_id, text, sender, is_aix_generated, created_at").neq("sender", "customer").gte("created_at", since).order("created_at").range(a, b));
  const autos = convs.length ? await pageAll<{ id: string; auto_sent_draft: string | null; auto_sent_at: string | null }>((a, b) => sb.from("conversations").select("id, auto_sent_draft, auto_sent_at").not("auto_sent_draft", "is", null).range(a, b)) : [];

  // ① 語の途中の名前
  const rows: { src: string; id: string; at: string; display: string; hit: string; text: string }[] = [];
  const scan = (src: string, id: string, at: string, cid: string | null, text: string | null) => {
    if (!cid || !text) return;
    const n = namesOf.get(cid);
    if (!n) return;
    for (const h of detectNameInsideWord(text, n.names)) rows.push({ src, id, at, display: n.display, hit: `${h.name}｜${h.evidence}`, text });
  };
  for (const e of exs) { scan("下書き", e.id, e.created_at, e.conversation_id, e.ai_draft); scan("送った返信", e.id, e.created_at, e.conversation_id, e.sent_reply); }
  for (const m of msgs) scan(m.is_aix_generated ? "送信(AIX)" : "送信(手打ち)", m.id, m.created_at, m.conversation_id, m.text);
  for (const c of autos) scan("自動送信", c.id, c.auto_sent_at ?? "", c.id, c.auto_sent_draft);
  const bySrc = new Map<string, number>();
  for (const r of rows) bySrc.set(r.src, (bySrc.get(r.src) ?? 0) + 1);
  console.log(`\n=== ① 名前が語の途中（${DAYS}日・下書き/返信 ${exs.length}件・送信 ${msgs.length}通・自動 ${autos.length}件）===`);
  console.log([...bySrc].map(([k, v]) => `${k}: ${v}`).join(" ／ ") || "0件");
  for (const r of rows.slice(0, SHOW)) console.log(`- [${r.src}] ${r.at.slice(0, 16)} 表示名「${r.display}」 ${r.hit}\n    ${r.text.replace(/\n/g, "⏎").slice(0, 160)}`);

  // ② 表示名の置き換え 旧 vs 新
  let oldChanged = 0, newChanged = 0, differ = 0;
  const diffs: string[] = [];
  const kept: string[] = [];
  const sim = (label: string, cid: string | null, text: string | null) => {
    if (!cid || !text) return;
    const n = namesOf.get(cid);
    if (!n || !n.display || !n.canonical || n.display === n.canonical || isPlausiblePersonName(n.display)) return;
    if (!text.includes(n.display)) return;
    const oldT = text.split(n.display).join(n.canonical);
    const nw = replaceDisplayStandalone(text, n.display, n.canonical);
    if (oldT !== text) oldChanged++;
    if (nw.count) { newChanged++; kept.push(`[${label}] 「${n.display}」→「${n.canonical}」 ${nw.text.replace(/\n/g, "⏎").slice(0, 140)}`); }
    if (oldT !== nw.text) { differ++; diffs.push(`[${label}] 「${n.display}」→「${n.canonical}」 旧: ${oldT.replace(/\n/g, "⏎").slice(0, 120)}`); }
  };
  for (const e of exs) { sim("下書き", e.conversation_id, e.ai_draft); sim("送った返信", e.conversation_id, e.sent_reply); }
  for (const m of msgs) sim("送信", m.conversation_id, m.text);
  console.log(`\n=== ② 表示名の置き換え（表示名が名前の形でなく・正の名前がある会話）旧で変わる ${oldChanged}・新で変わる ${newChanged}・旧と新が違う ${differ} ===`);
  console.log("--- 旧だけが書き換えていた（語の途中）---");
  for (const d of diffs.slice(0, SHOW)) console.log("- " + d);
  console.log("--- 新でも置き換える所（目で読む）---");
  for (const d of kept.slice(0, SHOW)) console.log("- " + d);
}
main().catch((e) => { console.error(e); process.exit(1); });
