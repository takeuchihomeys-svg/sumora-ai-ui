// scripts/audit-wording-exits-1002.ts — 10/02 の出口3つが人の文と AI の下書きで何を変えるか（読むだけ・LLM なし）
// 2026-10-02 竹内さんの指摘（YUMA の LINE）:
//   ⑤ 一括確認／空きがございましたら → fixBulkCheckWording（app/lib/bulk-check-wording.ts）
//   ⑥ それより前に…ございません（言い切り）／ご入金でお部屋を押さえ → fixPaymentTimingWording（app/lib/payment-timing-wording.ts）
//   ⑧ 絵文字の場面の使い分け → applySituationalEmoji（app/lib/emoji-situational.ts）
// ①本番のスタッフの送信（人の手打ち・AIX）で変わる通（⑤⑥は 0 でなければ入れない）
// ②AI の下書き（ai_reply_examples.ai_draft・line_reply）で変わる通と、⑧の前後の「絵文字なし」の割合（人の手打ちの割合と比べる）
// 実行: npx tsx --env-file=.env.local scripts/audit-wording-exits-1002.ts [--days=365] [--show]
import { createClient } from "@supabase/supabase-js";
import { fixBulkCheckWording } from "../app/lib/bulk-check-wording";
import { fixPaymentTimingWording } from "../app/lib/payment-timing-wording";
import { applySituationalEmoji, emojiSituationOf } from "../app/lib/emoji-situational";
import { isTestConversation } from "../app/lib/test-conversations";
import { draftToSendableText } from "../app/lib/draft-text";

const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "365");
const SHOW = process.argv.includes("--show");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const EMO = /\p{Extended_Pictographic}/u;
const one = (s: string) => s.replace(/\n/g, "⏎").slice(0, 200);

async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; ; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const msgs = await readAll<{ conversation_id: string; created_at: string; text: string | null; is_aix_generated: boolean | null }>((f, t) => sb.from("messages").select("conversation_id, created_at, text, is_aix_generated").eq("sender", "staff").gte("created_at", since).order("created_at").range(f, t));
  const c = { human: 0, aix: 0, bulkH: 0, bulkA: 0, payH: 0, payA: 0, emoH: 0 };
  for (const m of msgs) {
    if (!m.text || isTestConversation(m.conversation_id) || /^\[(?:画像|動画|スタンプ|ファイル|通話)/.test(m.text)) continue;
    const isA = !!m.is_aix_generated; if (isA) c.aix++; else c.human++;
    const b = fixBulkCheckWording(m.text), p = fixPaymentTimingWording(m.text);
    if (b.changes.length) { isA ? c.bulkA++ : c.bulkH++; console.log(`⑤ ${isA ? "AIX" : "人"} ${m.created_at.slice(0, 10)} ${b.changes.join("・")} ｜ ${one(m.text)}`); }
    if (p.changes.length) { isA ? c.payA++ : c.payH++; console.log(`⑥ ${isA ? "AIX" : "人"} ${m.created_at.slice(0, 10)} ${p.changes.join("・")} ｜ ${one(m.text)}`); }
    if (!isA && emojiSituationOf(m.text, { seed: m.conversation_id }).drop) c.emoH++;
  }
  console.log(`\n① 本番のスタッフの送信 ${DAYS}日: 人の手打ち ${c.human}通（⑤ 変わる ${c.bulkH}・⑥ 変わる ${c.payH}）／AIX ${c.aix}通（⑤ ${c.bulkA}・⑥ ${c.payA}）`);
  console.log(`   ⑧ 参考: 人の手打ちで場面が「外す」に当たる通 ${c.emoH}（人の文には当てない・下書きだけ）`);

  const ex = await readAll<{ conversation_id: string; ai_draft: string | null; sent_reply: string | null; was_ai_used: boolean | null; was_ai_modified: boolean | null; entry_source: string | null; created_at: string }>((f, t) => sb.from("ai_reply_examples").select("conversation_id, ai_draft, sent_reply, was_ai_used, was_ai_modified, entry_source, created_at").eq("entry_source", "line_reply").gte("created_at", "2026-06-15").range(f, t));
  const d = { n: 0, bulk: 0, pay: 0, emoBefore: 0, emoAfter: 0, humanN: 0, humanNo: 0 };
  const reasons: Record<string, number> = {};
  for (const r of ex) {
    if (isTestConversation(r.conversation_id)) continue;
    if (r.was_ai_used === false && r.sent_reply) { d.humanN++; if (!EMO.test(r.sent_reply)) d.humanNo++; }
    const draft = draftToSendableText(r.ai_draft);
    if (!draft) continue;
    d.n++;
    const b = fixBulkCheckWording(draft), p = fixPaymentTimingWording(draft);
    if (b.changes.length) { d.bulk++; if (SHOW) console.log(`⑤下書き ${b.changes.join("・")} ｜ ${one(draft)}`); }
    if (p.changes.length) { d.pay++; if (SHOW) console.log(`⑥下書き ${p.changes.join("・")} ｜ ${one(draft)}`); }
    if (!EMO.test(draft)) d.emoBefore++;
    const e = applySituationalEmoji(draft, { seed: r.conversation_id });
    if (e.reason) reasons[e.reason] = (reasons[e.reason] ?? 0) + 1;
    if (!EMO.test(e.text)) d.emoAfter++;
    if (SHOW && e.reason && Math.random() < 0.05) console.log(`⑧下書き [${e.reason}] ${one(draft)}\n   → ${one(e.text)}`);
  }
  const pct = (a: number, b: number) => `${(a / Math.max(1, b) * 100).toFixed(1)}%`;
  console.log(`\n② AI の下書き（line_reply・6/15〜）${d.n}通: ⑤ 変わる ${d.bulk}・⑥ 変わる ${d.pay}`);
  console.log(`   ⑧ 絵文字なし: 出口の前 ${pct(d.emoBefore, d.n)} → 後 ${pct(d.emoAfter, d.n)}（人の手打ち ${d.humanN}通は ${pct(d.humanNo, d.humanN)}）・外した理由 ${JSON.stringify(reasons)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
