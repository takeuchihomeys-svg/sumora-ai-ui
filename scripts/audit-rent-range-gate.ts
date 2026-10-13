// scripts/audit-rent-range-gate.ts — 2026-10-13 見積金額内訳ゲートの家賃の幅の誤検知を測る（読むだけ・LLM なし）
//   竹内さんの手打ち（staff_writer=takeuchi・AIX でない・申込前）と AI の下書き（ai_reply_examples.ai_draft）を、
//   本番と同じ enforceAixGates（groundText＝その前の25通・今の連投・直前のこちらの文）に通し、見積金額内訳で消える文を数える。
//   RENT_RANGE_NOT_ESTIMATE=off（旧）と既定（新）の差＝家賃の幅の文の免除で残るようになった文。
// 実行: npx tsx --env-file=.env.local scripts/audit-rent-range-gate.ts [--days=60] [--show=12]
import { createClient } from "@supabase/supabase-js";
import { enforceAixGates, GROUND_SEP } from "../app/lib/validate-reply";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "60"));
const SHOW = Number(arg("show", "12"));
const one = (s: string | null | undefined, n = 110) => (s ?? "").replace(/\s+/g, " ").slice(0, n);
type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string; staff_writer: string | null; is_aix_generated: boolean | null };

async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 400_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}

function gateRemoved(text: string, o: { customerMessage: string; lastStaffMsg: string; groundText: string }, rentOff: boolean): string[] {
  const prev = process.env.RENT_RANGE_NOT_ESTIMATE;
  if (rentOff) process.env.RENT_RANGE_NOT_ESTIMATE = "off"; else delete process.env.RENT_RANGE_NOT_ESTIMATE;
  try {
    const r = enforceAixGates(text, { ...o, estimateAllowed: false });
    return r.edits.filter((e) => e.rule === "見積金額内訳").map((e) => e.before);
  } finally { if (prev === undefined) delete process.env.RENT_RANGE_NOT_ESTIMATE; else process.env.RENT_RANGE_NOT_ESTIMATE = prev; }
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const applyAt = new Map<string, string>();
  for (const p of await readAll<{ conversation_id: string; created_at: string }>((f, t) => sb.from("aix_usage_logs").select("conversation_id, created_at").eq("aix_type", "application_push").order("created_at").range(f, t)))
    if (!applyAt.has(p.conversation_id)) applyAt.set(p.conversation_id, p.created_at);
  const tk = (await readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at, staff_writer, is_aix_generated").eq("sender", "staff").eq("staff_writer", "takeuchi").gte("created_at", since).order("created_at").range(f, t)))
    .filter((m) => !m.is_aix_generated && (m.text ?? "").trim() && !isTestConversation(m.conversation_id) && !(applyAt.has(m.conversation_id) && m.created_at >= applyAt.get(m.conversation_id)!));
  const exs = (await readAll<{ conversation_id: string; created_at: string; ai_draft: string | null; sent_reply: string | null }>((f, t) => sb.from("ai_reply_examples").select("conversation_id, created_at, ai_draft, sent_reply").eq("entry_source", "line_reply").gte("created_at", since).not("ai_draft", "is", null).order("created_at").range(f, t)))
    .filter((e) => !isTestConversation(e.conversation_id) && !(applyAt.has(e.conversation_id) && e.created_at >= applyAt.get(e.conversation_id)!));
  const cids = [...new Set([...tk.map((m) => m.conversation_id), ...exs.map((e) => e.conversation_id)])];
  const hist = new Map<string, Msg[]>();
  for (let i = 0; i < cids.length; i += 60) {
    const part = cids.slice(i, i + 60);
    for (const m of await readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at, staff_writer, is_aix_generated").in("conversation_id", part).gte("created_at", new Date(Date.parse(since) - 30 * 86_400_000).toISOString()).order("created_at").range(f, t))) {
      if (!hist.has(m.conversation_id)) hist.set(m.conversation_id, []);
      hist.get(m.conversation_id)!.push(m);
    }
  }
  const ctxOf = (cid: string, at: string) => {
    const before = (hist.get(cid) ?? []).filter((m) => m.created_at < at).slice(-25);
    const cust: string[] = []; for (let i = before.length - 1; i >= 0 && before[i].sender === "customer"; i--) cust.unshift(before[i].text ?? "");
    const lastStaff = [...before].reverse().find((m) => m.sender !== "customer")?.text ?? "";
    return { customerMessage: cust.join("\n"), lastStaffMsg: lastStaff, groundText: before.map((m) => m.text ?? "").join(GROUND_SEP) };
  };
  for (const [label, items] of [["竹内さんの手打ち", tk.map((m) => ({ cid: m.conversation_id, at: m.created_at, text: m.text ?? "", sent: null as string | null }))],
    ["AI の下書き", exs.map((e) => ({ cid: e.conversation_id, at: e.created_at, text: e.ai_draft ?? "", sent: e.sent_reply }))]] as const) {
    let oldHit = 0, newHit = 0; const freed: Array<{ s: string; sent: string | null; cid: string }> = []; const still: string[] = [];
    for (const it of items) {
      const o = ctxOf(it.cid, it.at);
      const a = gateRemoved(it.text, o, true), b = gateRemoved(it.text, o, false);
      oldHit += a.length; newHit += b.length;
      for (const s of a) if (!b.includes(s)) freed.push({ s, sent: it.sent, cid: it.cid });
      for (const s of b) still.push(`${s}　〔会話の万の数字: ${[...new Set((o.groundText.normalize("NFKC").match(/[0-9.]+\s*万|[0-9.]+\s*[〜~～ー-]\s*[0-9.]+/g) ?? []))].slice(0, 8).join(" ")}〕`);
    }
    console.log(`\n■ ${label} ${items.length}通（${DAYS}日）: 見積金額内訳で消える文 旧 ${oldHit} → 新 ${newHit}（家賃の幅の免除で残る ${freed.length}）`);
    for (const f of freed.slice(0, SHOW)) console.log(`  残る: ${f.cid.slice(0, 8)} 「${one(f.s)}」${f.sent != null ? ` ／実送信に同じ数字=${/[0-9]/.test(f.s) && (f.s.match(/[0-9.]+\s*万/g) ?? []).every((x) => (f.sent ?? "").normalize("NFKC").includes(x.replace(/\s/g, ""))) ? "あり" : "なし"}` : ""}`);
    for (const s of still.slice(0, Math.min(SHOW, 6))) console.log(`  まだ消える: 「${one(s)}」`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
