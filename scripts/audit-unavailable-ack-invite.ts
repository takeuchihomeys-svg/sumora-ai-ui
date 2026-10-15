// scripts/audit-unavailable-ack-invite.ts — 「募集終了・募集に出ていない・見送りの報告の後のお礼」の番で、内覧・申込の誘いが出たかを数える（読むだけ・LLM なし・DB に書かない）
//
// 2026-10-15 竹内さん（ゆなまるさん 10/09・会話 63fa0c26）: スタッフ「お送り頂きましたメゾンデリアン…現在募集に出ていないお部屋…引き続き新着で…出次第お送り」
//   → お客様「ありがとうございます！」→ AI の下書き「お世話になっております！！ はい😊！！ お気に召されましたらご都合よろしいお日にち御座いますでしょうか！！ご案内させて頂きます！！」
//   「募集していないとなっているのに。何の話をしているのかの軸が分からない」。
//   ①実送信: 同じ型の番でスタッフ（竹内さん・従業員）は内覧・申込の誘いを書いたか
//   ②下書き: line_watch_turns（draft_first／draft_last）と ai_reply_examples（ai_draft）で誘いを書いた回
// 実行: npx tsx --env-file=.env.local scripts/audit-unavailable-ack-invite.ts [--from=2026-06-01] [--show=10]
import { createClient } from "@supabase/supabase-js";
import { isAckOnlyTurn } from "../app/lib/ack-topic-scope";
import { unavailableReportOf, inviteSentenceOf } from "../app/lib/unavailable-ack";
import { YUMA_CONVERSATION_ID, isTestOnlyConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const FROM = arg("from", "2026-06-01");
const SHOW = Number(arg("show", "10"));
const MEDIA_ONLY_RE = /^\[(?:画像|動画|スタンプ|ファイル)\]$/;
const mask = (s: string) => s.replace(/[^\s、。！!？?\n]{1,12}(?:さん|様|さま)/g, "〇〇さん").replace(/\n/g, " ／ ").slice(0, 160);

type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
async function readAll<T>(fn: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, cap = 600_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += 1000) {
    const { data, error } = await fn(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

async function main() {
  const convs = await readAll<{ id: string; line_source_type: string | null }>((f, t) => sb.from("conversations").select("id, line_source_type").range(f, t));
  const skip = new Set(convs.filter((c) => c.line_source_type === "group" || c.id === YUMA_CONVERSATION_ID || isTestOnlyConversation(c.id)).map((c) => c.id));
  const msgs = await readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").gte("created_at", FROM).order("created_at").order("id").range(f, t));
  const by = new Map<string, Msg[]>();
  for (const m of msgs) { if (skip.has(m.conversation_id)) continue; const a = by.get(m.conversation_id) ?? []; a.push(m); by.set(m.conversation_id, a); }
  type Turn = { conv: string; at: string; staffText: string; reply: string };
  const turns: Turn[] = [];
  for (const [conv, ms] of by) {
    for (let i = 1; i < ms.length; i++) {
      if (ms[i].sender !== "customer" || ms[i - 1].sender === "customer") continue;
      let j = i; const turn: Msg[] = [];
      // 番＝続けて送った分（6時間より空いたお客様の発言は次の番。10/09 のお礼の後 10/11 に次の発言が来た）
      while (j < ms.length && ms[j].sender === "customer" && (!turn.length || Date.parse(ms[j].created_at) - Date.parse(turn[turn.length - 1].created_at) < 6 * 3600_000)) { turn.push(ms[j]); j++; }
      if (!isAckOnlyTurn(turn.map((x) => x.text ?? "").join("\n"))) continue;
      let k = i - 1; const staff: Msg[] = [];
      while (k >= 0 && ms[k].sender !== "customer") { staff.unshift(ms[k]); k--; }
      const staffText = staff.map((x) => String(x.text ?? "").trim()).filter((t) => t && !MEDIA_ONLY_RE.test(t)).join("\n");
      if (!staffText || !unavailableReportOf(staffText)) continue;
      if (Date.parse(ms[i].created_at) - Date.parse(staff[staff.length - 1].created_at) > 72 * 3600_000) continue;
      // その後 24時間以内・次のお客様の発言までのスタッフの文字の返事
      const lastCustAt = Date.parse(turn[turn.length - 1].created_at);
      const reply: string[] = [];
      for (let r = j; r < ms.length && ms[r].sender !== "customer" && Date.parse(ms[r].created_at) - lastCustAt < 24 * 3600_000; r++) {
        const t = String(ms[r].text ?? "").trim(); if (t && !MEDIA_ONLY_RE.test(t)) reply.push(t);
      }
      turns.push({ conv, at: turn[0].created_at, staffText, reply: reply.join("\n") });
    }
  }
  const replied = turns.filter((t) => t.reply);
  const staffInvite = replied.filter((t) => inviteSentenceOf(t.reply));
  console.log(`=== 募集終了・募集に出ていない報告の後のお礼の番（${FROM}〜・グループ・テストの会話を除く）: ${turns.length}番（会話 ${new Set(turns.map((t) => t.conv)).size}）`);
  console.log(`  ①実送信: スタッフが文字で返した ${replied.length}／返さない ${turns.length - replied.length}・誘い（お気に召されましたら…ご案内／お申込みで抑える）を書いた ${staffInvite.length}`);
  for (const t of staffInvite.slice(0, SHOW)) console.log(`    ${t.conv.slice(0, 8)} ${t.at.slice(0, 16)} 前「${mask(t.staffText)}」→「${mask(t.reply)}」`);
  for (const t of replied.filter((x) => !inviteSentenceOf(x.reply)).slice(0, SHOW)) console.log(`    （誘いなし）${t.conv.slice(0, 8)} ${t.at.slice(0, 16)} →「${mask(t.reply)}」`);

  // ②下書き
  const keyOf = (conv: string, at: string) => `${conv}|${at.slice(0, 19)}`;
  const want = new Map(turns.map((t) => [keyOf(t.conv, t.at), t]));
  const wt = await readAll<{ conversation_id: string; customer_turn_at: string; draft_first: string | null; draft_last: string | null; draft_first_at: string | null }>((f, t) => sb.from("line_watch_turns").select("conversation_id, customer_turn_at, draft_first, draft_last, draft_first_at").order("customer_turn_at").range(f, t));
  let nW = 0, nWInv = 0; const wInv: string[] = [];
  for (const w of wt) {
    const t = want.get(keyOf(w.conversation_id, new Date(w.customer_turn_at).toISOString()));
    if (!t) continue;
    const drafts = [w.draft_first, w.draft_last].filter((x): x is string => !!x && !!x.trim());
    if (!drafts.length) continue;
    nW++;
    const inv = drafts.find((d) => inviteSentenceOf(d));
    if (inv) { nWInv++; wInv.push(`    ${w.conversation_id.slice(0, 8)} ${t.at.slice(0, 16)}（${(w.draft_first_at ?? "").slice(0, 10)}）「${mask(inv)}」`); }
  }
  console.log(`  ②下書き（見張り line_watch_turns・10/01〜）: 下書きのある番 ${nW}・誘いを書いた ${nWInv}`);
  for (const s of wInv.slice(0, SHOW)) console.log(s);
  const ex = await readAll<{ conversation_id: string | null; ai_draft: string | null; created_at: string }>((f, t) => sb.from("ai_reply_examples").select("conversation_id, ai_draft, created_at").gte("created_at", FROM).not("ai_draft", "is", null).order("created_at").range(f, t));
  // 例は「送った時」に残る＝番の後の最初の例を同じ番とみなす（24時間以内）
  let nE = 0, nEInv = 0; const eInv: string[] = [];
  const exBy = new Map<string, typeof ex>();
  for (const e of ex) { if (!e.conversation_id) continue; const a = exBy.get(e.conversation_id) ?? []; a.push(e); exBy.set(e.conversation_id, a); }
  for (const t of turns) {
    const e = (exBy.get(t.conv) ?? []).find((x) => Date.parse(x.created_at) >= Date.parse(t.at) && Date.parse(x.created_at) - Date.parse(t.at) < 24 * 3600_000);
    if (!e?.ai_draft) continue;
    nE++;
    if (inviteSentenceOf(e.ai_draft)) { nEInv++; eInv.push(`    ${t.conv.slice(0, 8)} ${t.at.slice(0, 16)}「${mask(e.ai_draft)}」`); }
  }
  console.log(`  ②下書き（送った例 ai_reply_examples）: 下書きのある番 ${nE}・誘いを書いた ${nEInv}`);
  for (const s of eInv.slice(0, SHOW)) console.log(s);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
