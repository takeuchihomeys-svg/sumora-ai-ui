// scripts/audit-r7-opener-branch.ts — 7巡目: 開口語の決定（greeting.resolveOpener の分岐）× 人の手打ちの開口語（読むだけ・LLM なし）
//   人の文 = お客様の番の後の最初のスタッフの文（AIX・画像だけを除く・AI の下書きをそのまま送った文を除く）
//   AI の文 = ai_reply_examples の ai_draft（その時の決定 reply_context_snapshot.greeting と一緒に）
//   分岐ごとに「人: かしこまりました／はい／本題から」と「AI: 同じ」を並べ、決まりが人の多数派に合うかを見る
// 実行: npx tsx --env-file=.env.local scripts/audit-r7-opener-branch.ts [--days=120] [--samples=6]
import { createClient } from "@supabase/supabase-js";
import { resolveGreeting, detectOpener, classifyReplyBody } from "../app/lib/greeting";
import { analyzeSubstance, classifyCustomerResponse, classifyLastStaffTurn } from "../app/lib/reply-context";
import { resolveReplyScene, REPLY_SCENE_JA } from "../app/lib/reply-scene";
import { isTestConversation } from "../app/lib/test-conversations";
import { cleanDraft } from "../app/lib/line-watch-judge";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "120"));
const SAMPLES = Number(arg("samples", "6"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 400_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
/** 呼び名・挨拶の行を外した後の開口語（なし＝本題から） */
export function openerOfText(t: string): "kashikomari" | "hai" | "none" {
  const rest = t.trim().replace(/^[^\n！!。、]{1,14}(?:さん|様)[、,]?\s*/, "").replace(/^(?:お世話になっております|お世話になります)[😊😌]*[！!。]*\s*/, "").trim();
  const op = detectOpener(rest); return op ? (op.opener === "kashikomari" ? "kashikomari" : op.opener === "hai" ? "hai" : "none") : "none";
}
/** スタッフだけが知る事の報告（③ AIX の番）の語。返信の書き方の多数派を数える時は外す */
export const STAFF_ONLY_RE = /確認(?:させて|致し|いたし)?(?:頂|いただ)?きました(?:ところ|が)|ましたところ|募集(?:中|終了|に出て)(?:と|して|でござい)|お見積書?(?:を)?お送り(?:させて)?(?:頂|いただ)?きました|御見積書となります|本日(?:は)?お時間(?:頂|いただ)き|お待たせ(?:致|いた)?しました|管理会社(?:に確認|より|担当|に電話|にお電話|にご連絡)|とのご(?:連絡|返答|回答)|申込み?完了|審査(?:通過|承認|結果|の結果)|内覧開始|退去予定/;
let skippedStaffOnly = 0;
function stripCallGreeting(t: string): string {
  return t.trim().replace(/^[^\n！!。、]{1,14}(?:さん|様)[、,]?\s*/, "").replace(/^(?:お世話になっております|お世話になります)[😊😌]*[！!。]*\s*/, "");
}
function bodyKindOf(t: string): string {
  const r = stripCallGreeting(t); const op = detectOpener(r);
  return classifyReplyBody(op ? r.slice(op.match.length) : r);
}
type M = { conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null };

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const msgs = await readAll<M>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(f, t));
  const ex = await readAll<{ ai_draft: string | null; sent_reply: string | null; customer_message: string | null; greeting: { opener?: string; openerReason?: string } | null }>((f, t) =>
    sb.from("ai_reply_examples").select("ai_draft, sent_reply, customer_message, greeting:reply_context_snapshot->greeting").eq("entry_source", "line_reply").gte("created_at", since).range(f, t));
  const asIs = new Set(ex.filter((e) => e.ai_draft && e.sent_reply && cleanDraft(e.ai_draft).text === e.sent_reply.trim()).map((e) => e.sent_reply!.trim()));
  const by = new Map<string, M[]>();
  for (const m of msgs) { if (isTestConversation(m.conversation_id)) continue; if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push(m); }
  type Cell = { human: Record<string, number>; ai: Record<string, number>; hEx: string[]; scenes: Record<string, number> };
  const cells = new Map<string, Cell>();
  const cell = (k: string) => { if (!cells.has(k)) cells.set(k, { human: {}, ai: {}, hEx: [], scenes: {} }); return cells.get(k)!; };
  let nH = 0;
  for (const [, list] of by) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].sender !== "customer" || (i > 0 && list[i - 1].sender === "customer")) continue;
      let j = i; while (j + 1 < list.length && list[j + 1].sender === "customer") j++;
      const custText = list.slice(i, j + 1).map((m) => m.text ?? "").join("\n");
      let k = j + 1; let staff: M | null = null;
      for (; k < list.length && list[k].sender !== "customer"; k++) { const t = (list[k].text ?? "").trim(); if (list[k].sender === "staff" && !list[k].is_aix_generated && t && !/^\[(?:画像|動画|スタンプ|ファイル)\]/.test(t)) { staff = list[k]; break; } }
      if (!staff || asIs.has(staff.text!.trim())) continue;
      // スタッフだけが知る事の報告（確認の結果・見積の送付・内覧の後・管理会社の返事）は AIX の番＝返信の物差しから外す
      if (STAFF_ONLY_RE.test(staff.text!)) { skippedStaffOnly++; continue; }
      const hist = list.slice(0, j + 1).map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.created_at, isAix: !!m.is_aix_generated }));
      const lastStaff = [...list.slice(0, i)].reverse().find((m) => m.sender === "staff" && (m.text ?? "").trim() && !/^\[(?:画像|動画)\]/.test(m.text ?? ""));
      const sub = analyzeSubstance(custText);
      const cr = classifyCustomerResponse(sub, classifyLastStaffTurn(lastStaff?.text ?? ""), {});
      const now = Date.parse(staff.created_at) - 1000; const jd = (ms: number) => Math.floor((ms + 9 * 3600_000) / 86_400_000);
      const g = resolveGreeting({ customerName: "X", isFirstEverReply: !hist.some((m) => m.sender === "staff" && !m.isAix && m.text), alreadyGreetedToday: hist.some((m) => m.sender === "staff" && m.text && jd(Date.parse(m.createdAt)) === jd(now)), recentMessages: hist, jstHour: 12, now, isSubstantive: (t) => analyzeSubstance(t).has, customerKind: cr.kind, customerSecondary: cr.secondary, substanceKinds: sub.kinds });
      if (g.kind === "first") continue;
      const bk = bodyKindOf(staff.text!);
      const key = `${g.opener}｜${(g.openerReason ?? "").slice(0, 26)}｜中身:${bk}`;
      const c = cell(key); const o = openerOfText(staff.text!); c.human[o] = (c.human[o] ?? 0) + 1; nH++;
      const sc = REPLY_SCENE_JA[resolveReplyScene({ customerText: custText }).scene]; c.scenes[sc] = (c.scenes[sc] ?? 0) + 1;
      if (o !== g.opener && c.hEx.length < SAMPLES) c.hEx.push(`${o}: C「${custText.replace(/\n/g, " ").slice(0, 40)}」→ 人「${staff.text!.replace(/\n/g, "⏎").slice(0, 60)}」`);
    }
  }
  for (const e of ex) {
    const d = cleanDraft(e.ai_draft).text; if (!d || !e.greeting?.opener) continue;
    const bk = bodyKindOf(d);
    const c = cell(`${e.greeting.opener}｜${(e.greeting.openerReason ?? "").slice(0, 26)}｜中身:${bk}`); const o = openerOfText(d); c.ai[o] = (c.ai[o] ?? 0) + 1;
  }
  console.log(`報告（スタッフだけが知る事）で外した ${skippedStaffOnly}`); console.log(`人の番 ${nH}（${DAYS}日・下書きそのままを除く）`);
  const fmt = (r: Record<string, number>) => { const n = Object.values(r).reduce((a, b) => a + b, 0); return `n=${n} かしこまり ${pct(r.kashikomari ?? 0, n)}・はい ${pct(r.hai ?? 0, n)}・本題 ${pct(r.none ?? 0, n)}`; };
  for (const [k, c] of [...cells].sort((a, b) => Object.values(b[1].human).reduce((x, y) => x + y, 0) - Object.values(a[1].human).reduce((x, y) => x + y, 0))) {
    console.log(`\n■ ${k}\n  人: ${fmt(c.human)}\n  AI: ${fmt(c.ai)}\n  場面: ${Object.entries(c.scenes).sort((a, b) => b[1] - a[1]).map(([s, v]) => `${s}${v}`).join(" ")}`);
    for (const e of c.hEx) console.log(`    ${e}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
