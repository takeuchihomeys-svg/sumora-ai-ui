// scripts/audit-time-greeting.ts
// 2026-10-08 竹内さん（り 8f705d16「こんばんは。この時間に送るのおかしい」「お客さんに送る挨拶は『お世話になっております』」）
//   時刻の挨拶（app/lib/time-greeting.ts）の線を実送信で引き、出口と画面の直しが人の文を変える通（誤削除）を目で読む。読むだけ・LLM なし。
//   A. 手打ち（AIX を除く・テストの会話を除く）の時刻の挨拶の書き出し: 書き手（takeuchi／employee／記録なし）× お客様の直前の挨拶
//   B. 生成の出口（stripHeadTimeGreeting）を人の手打ちに当てる → 変わる通＝出口が人の文を変える数（全件を出す）
//   C. 画面の直し（refreshDraftGreetingForNow）を人の手打ちに「その送信の時刻で開いた下書き」として当てる → 変わる通を出す
//   D. 画面の直しを AI の下書き（ai_reply_examples.ai_draft・送った時刻で開いた）に当てる → 変わった下書きと実際に送った文を並べる
// 実行: npx tsx --env-file=.env.local scripts/audit-time-greeting.ts [--days=365] [--show=40]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { findHeadTimeGreeting, stripHeadTimeGreeting, refreshDraftGreetingForNow } from "../app/lib/time-greeting";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const DAYS = Number(arg("days", "365"));
const SHOW = Number(arg("show", "40"));
const one = (t: string | null | undefined, n = 90) => (t ?? "").replace(/\d{2,4}-?\d{3,4}-?\d{3,4}/g, "***").replace(/\n/g, "⏎").slice(0, n);
const OSEWA_HEAD = (t: string) => /お世話になっております/.test(t.split("\n").filter((l) => l.trim()).slice(0, 2).join("\n").slice(0, 60));

type Row = { id: string; conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null; staff_writer: string | null };

(async () => {
  const since = new Date(Date.now() - (DAYS + 7) * 86_400_000).toISOString();
  const all: Row[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, sender, created_at, text, is_aix_generated, staff_writer")
      .gte("created_at", since).order("created_at").order("id").range(f, f + 999);
    if (error) throw error;
    all.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  const byConv = new Map<string, Row[]>();
  for (const m of all) { if (isTestConversation(m.conversation_id)) continue; (byConv.get(m.conversation_id) ?? byConv.set(m.conversation_id, []).get(m.conversation_id)!).push(m); }
  const evalSince = Date.now() - DAYS * 86_400_000;
  const toMsg = (m: Row) => ({ sender: m.sender, text: m.text, rawCreatedAt: m.created_at });

  // A・B・C
  const a = new Map<string, { n: number; tg: number; custTg: number; custTgOsewa: number; custTgTg: number }>();
  const bChanged: string[] = [];
  const cChanged: { writer: string; before: string; after: string; fix: string }[] = [];
  let handTotal = 0;
  for (const [, msgs] of byConv) {
    msgs.forEach((m, i) => {
      if (m.sender !== "staff" || m.is_aix_generated || !m.text || /^\[/.test(m.text.trim())) return;
      if (Date.parse(m.created_at) < evalSince) return;
      handTotal++;
      const w = m.staff_writer ?? "記録なし";
      const s = a.get(w) ?? { n: 0, tg: 0, custTg: 0, custTgOsewa: 0, custTgTg: 0 };
      s.n++;
      const isTg = !!findHeadTimeGreeting(m.text);
      if (isTg) s.tg++;
      const prevCust = [...msgs.slice(0, i)].reverse().find((x) => x.text && !/^\[/.test(x.text.trim()));
      if (prevCust?.sender === "customer" && /^\s*(?:こんばんは|こんばんわ|こんにちは|こんにちわ|おはよう)/.test(prevCust.text ?? "")) {
        s.custTg++;
        if (OSEWA_HEAD(m.text)) s.custTgOsewa++;
        if (isTg) s.custTgTg++;
      }
      a.set(w, s);
      const st = stripHeadTimeGreeting(m.text);
      if (st.removed) bChanged.push(`[${w}] ${m.created_at.slice(0, 16)} 「${one(m.text)}」→「${one(st.text)}」`);
      const before = msgs.slice(0, i).map(toMsg);
      const r = refreshDraftGreetingForNow(m.text, { messages: before, name: "", now: Date.parse(m.created_at) });
      if (r.text !== m.text) cChanged.push({ writer: w, before: one(m.text), after: one(r.text), fix: r.fixes.join("／") });
    });
  }
  console.log(`\n== A. 手打ちの書き出し（${DAYS}日・AIX を除く・${handTotal}通）`);
  for (const [w, s] of a) console.log(`  ${w}: ${s.n}通・時刻の挨拶から ${s.tg}通／お客様が時刻の挨拶で始めた番 ${s.custTg}通 → お世話になっております ${s.custTgOsewa}・時刻の挨拶 ${s.custTgTg}`);
  console.log(`\n== B. 出口（時刻の挨拶を剥がす）が人の手打ちを変える通: ${bChanged.length}`);
  bChanged.forEach((l) => console.log("  " + l));
  const cByW = new Map<string, number>(); cChanged.forEach((c) => cByW.set(c.writer, (cByW.get(c.writer) ?? 0) + 1));
  console.log(`\n== C. 画面の直しを人の手打ちに当てた時に変わる通: ${cChanged.length}（${[...cByW].map(([w, n]) => `${w} ${n}`).join("・")}）`);
  cChanged.slice(0, SHOW).forEach((c) => console.log(`  [${c.writer}] 「${c.before}」\n      →「${c.after}」（${c.fix}）`));

  // D. AI の下書き（ai_reply_examples）
  type Ex = { id: string; conversation_id: string | null; ai_draft: string | null; sent_reply: string | null; sent_at: string | null; created_at: string };
  const exs: Ex[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("ai_reply_examples").select("id, conversation_id, ai_draft, sent_reply, sent_at, created_at")
      .not("ai_draft", "is", null).gte("created_at", since).order("created_at").range(f, f + 999);
    if (error) throw error;
    exs.push(...((data ?? []) as Ex[]));
    if ((data ?? []).length < 1000) break;
  }
  let dTotal = 0; const dChanged: string[] = []; let agree = 0, disagree = 0;
  for (const e of exs) {
    if (!e.conversation_id || !e.ai_draft || !e.sent_reply || isTestConversation(e.conversation_id)) continue;
    const msgs = byConv.get(e.conversation_id); if (!msgs) continue;
    const at = Date.parse(e.sent_at ?? e.created_at);
    const before = msgs.filter((m) => Date.parse(m.created_at) < at - 3000).map(toMsg);
    dTotal++;
    const r = refreshDraftGreetingForNow(e.ai_draft, { messages: before, name: "", now: at });
    if (r.text === e.ai_draft) continue;
    const sentGreets = OSEWA_HEAD(e.sent_reply) || !!findHeadTimeGreeting(e.sent_reply);
    const afterGreets = OSEWA_HEAD(r.text);
    const ok = sentGreets === afterGreets;
    if (ok) agree++; else disagree++;
    dChanged.push(`${ok ? "合う" : "外れ"} 下書き「${one(e.ai_draft, 70)}」\n      直し「${one(r.text, 70)}」\n      送信「${one(e.sent_reply, 70)}」`);
  }
  console.log(`\n== D. 画面の直しを AI の下書きに当てる（${dTotal}件）: 変わる ${dChanged.length}件・送信の挨拶の有無と合う ${agree}／外れ ${disagree}`);
  dChanged.slice(0, SHOW).forEach((l) => console.log("  " + l));
})().catch((e) => { console.error(e); process.exit(1); });
