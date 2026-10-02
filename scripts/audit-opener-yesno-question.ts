// scripts/audit-opener-yesno-question.ts
// 2026-10-02 夜 竹内さん「かしこまりましたとか違う。ここの最初の言い回しで文がかなり違うようになるから。原因見つけて改善する」（ゆいと・スモラ）:
//   お客様の最後の発言が「はい／いいえで答える確かめの質問」（〜ってことですかね？・〜ですか？・〜できますか？）の時、
//   スタッフの手打ちの返事（AIX を除く）の開口語を数える。①人の実送信 ②AI の下書き（ai_reply_examples）で かしこまりました が付いた割合。読むだけ・LLM なし
// 実行: npx tsx --env-file=.env.local scripts/audit-opener-yesno-question.ts [--days=180]
import { createClient } from "@supabase/supabase-js";
import { isYesNoConfirmQuestion } from "../app/lib/opener-question";
import { enforceOpener } from "../app/lib/greeting";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=180").slice(7));
const openerOf = (t: string) => { const s = t.replace(/^[^\n]{0,20}(?:さん|様)\s*\n?/, "").replace(/^お世話になっております[！!]*\s*/, "").trim(); if (/^かしこまりました/.test(s)) return "かしこまりました"; if (/^はい/.test(s)) return "はい"; if (/^(?:そうなんです|そうです|そうですね)/.test(s)) return "そうなんです等"; if (/^(?:いえ|いいえ)/.test(s)) return "いえ"; return "なし（本題から）"; };
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const tally: Record<string, number> = {}; let n = 0; const ex: string[] = []; let changed = 0;
  const D = { opener: "none" as const, openerAllowed: ["none", "kashikomari", "hai"] as ("none" | "kashikomari" | "hai")[], openerBodyRule: true, openerStrict: false, openerConfirmQuestion: true };
  for (let f = 0; f < 40_000; f += 1000) {
    const { data } = await sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("conversation_id").order("created_at").range(f, f + 999);
    const rows = data ?? [];
    for (let i = 1; i < rows.length; i++) {
      const c = rows[i - 1], s = rows[i];
      if (c.conversation_id !== s.conversation_id || c.sender !== "customer" || s.sender === "customer" || s.is_aix_generated) continue;
      if (!isYesNoConfirmQuestion(String(c.text ?? ""))) continue;
      n++; const o = openerOf(String(s.text ?? "")); tally[o] = (tally[o] ?? 0) + 1;
      const body0 = String(s.text ?? "").replace(/^[^\n]{0,20}(?:さん|様)\s*\n?/, "").replace(/^お世話になっております[！!]*\s*/, "").trim();
      if (enforceOpener(body0, D).fixes.length) { changed++; console.log("   人の文が変わる:", body0.slice(0, 60)); }
      if (o === "かしこまりました" && ex.length < 6) ex.push(`${String(c.text).replace(/\n/g, " ").slice(0, 40)} → ${String(s.text).replace(/\n/g, " ").slice(0, 60)}`);
    }
    if (rows.length < 1000) break;
  }
  console.log(`① 人の手打ち（${DAYS}日）: はい／いいえの確かめの質問への返事 ${n}: ${JSON.stringify(tally)}・出口で変わる人の文 ${changed}`);
  for (const e of ex) console.log("   かしこまりました:", e);
  const { data: exs } = await sb.from("ai_reply_examples").select("customer_message, ai_draft, sent_reply").gte("created_at", since).not("ai_draft", "is", null).limit(1000);
  let dn = 0, dk = 0, sk = 0;
  for (const r of exs ?? []) { if (!isYesNoConfirmQuestion(String(r.customer_message ?? ""))) continue; dn++; if (openerOf(String(r.ai_draft)) === "かしこまりました") { dk++; if (openerOf(String(r.sent_reply ?? "")) === "かしこまりました") sk++; } }
  console.log(`② AI の下書き: 確かめの質問 ${dn}・かしこまりました で始まる ${dk}（スタッフが送った文も かしこまりました ${sk}）`);
})();
