// scripts/audit-r7-style-trend.ts — 7巡目: スタッフの書き方が時期で変わったかを月（半月）ごとに数える（読むだけ・LLM なし）
//   人の文の割れ（50/50 に見える型）が「時期の変化」なら、新しい方に寄せれば一致する＝材料（鮮度）の問題
// 実行: npx tsx --env-file=.env.local scripts/audit-r7-style-trend.ts [--days=240]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "240"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 400_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%`.padStart(4) : "   -");
async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows = await readAll<{ conversation_id: string; created_at: string; text: string | null }>((f, t) => sb.from("messages").select("conversation_id, created_at, text").eq("sender", "staff").or("is_aix_generated.is.null,is_aix_generated.eq.false").gte("created_at", since).order("created_at").range(f, t));
  const texts = rows.filter((r) => !isTestConversation(r.conversation_id) && (r.text ?? "").trim().length > 5 && !/^\[(?:画像|動画|スタンプ|ファイル)\]/.test((r.text ?? "").trim()));
  const bucket = (iso: string) => { const d = new Date(Date.parse(iso) + 9 * 3600_000); return `${d.getUTCMonth() + 1}月${d.getUTCDate() <= 15 ? "前" : "後"}`; };
  const keys: string[] = []; const by = new Map<string, string[]>();
  for (const r of texts) { const k = bucket(r.created_at); if (!by.has(k)) { by.set(k, []); keys.push(k); } by.get(k)!.push(r.text!); }
  const E = "[😊😌🌟✨]";
  const feats: Array<[string, (t: string) => boolean | null]> = [
    ["自己紹介3文を1行", (t) => (/はじめまして/.test(t) && /申します/.test(t)) ? /はじめまして[^\n]*この度[^\n]*申します/.test(t) : null],
    ["呼び名の後で改行", (t) => /^[^\n、！!。]{1,14}さん(?:\n|お世話|、)/.test(t) ? /^[^\n、！!。]{1,14}さん\n/.test(t) : null],
    ["開口語の後に空行", (t) => /^(?:はい|かしこまりました)[😊😌]*！！\n/.test(t) ? /^(?:はい|かしこまりました)[😊😌]*！！\n[ \t　]*\n/.test(t) : null],
    ["開口語に絵文字", (t) => /^(?:はい|かしこまりました)/.test(t) ? /^(?:はい|かしこまりました)[😊😌]/.test(t) : null],
    ["行末が絵文字だけ(！なし)", (t) => { const ls = t.split("\n").filter((l) => new RegExp(`${E}[！!]*$`, "u").test(l.trim())); if (!ls.length) return null; return ls.some((l) => new RegExp(`${E}$`, "u").test(l.trim())); }],
    ["単独の！がある", (t) => /[^！!]！(?![！!])/.test(t.replace(/!/g, "！"))],
    ["頂き(漢字)", (t) => /頂き|いただき/.test(t) ? /頂き/.test(t) : null],
    ["お世話になっております", (t) => /お世話になっております/.test(t)],
    ["何卒よろしくお願い致します", (t) => /何卒よろしくお願い(?:致|いた)します/.test(t)],
    ["かしこまりました始まり", (t) => /^かしこまりました/.test(t.replace(/^[^\n、！!。]{1,14}さん[、\n]?(?:お世話になっております！！\n)?/, ""))],
  ];
  // 直近30日: 人（下書きをそのまま送った物を除く）と AI の下書き（送った時の入力欄＋見張りの案）を同じ物差しで
  const s30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const ex = await readAll<{ ai_draft: string | null; sent_reply: string | null; conversation_id: string }>((f, t) => sb.from("ai_reply_examples").select("ai_draft, sent_reply, conversation_id").eq("entry_source", "line_reply").gte("created_at", s30).range(f, t));
  const wt = await readAll<{ draft_last: string | null; conversation_id: string }>((f, t) => sb.from("line_watch_turns").select("draft_last, conversation_id").gte("customer_turn_at", s30).range(f, t));
  const { cleanDraft } = await import("../app/lib/line-watch-judge");
  const asIs = new Set(ex.filter((e) => e.ai_draft && e.sent_reply && cleanDraft(e.ai_draft).text === e.sent_reply.trim()).map((e) => e.sent_reply!.trim()));
  const human30 = texts.filter((r) => r.created_at >= s30 && !asIs.has(r.text!.trim())).map((r) => r.text!);
  const ai30 = [...ex.map((e) => cleanDraft(e.ai_draft).text), ...wt.map((w) => cleanDraft(w.draft_last).text)].filter((t): t is string => !!t && !isTestConversation("") && t.length > 5);
  by.set("人30日", human30); by.set("AI30日", ai30); keys.push("人30日", "AI30日");
  console.log(`下書きそのままの送信を除いた数: ${asIs.size}通`);
  console.log(`スタッフの手打ち（AIX 以外）${texts.length}通`);
  console.log(["型".padEnd(16), ...keys.map((k) => k.padStart(5))].join(" "));
  console.log(["(通数)".padEnd(16), ...keys.map((k) => String(by.get(k)!.length).padStart(5))].join(" "));
  for (const [name, f] of feats) {
    console.log([name.padEnd(16), ...keys.map((k) => { const v = by.get(k)!.map(f).filter((x) => x !== null); return pct(v.filter(Boolean).length, v.length).padStart(5); })].join(" "));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
