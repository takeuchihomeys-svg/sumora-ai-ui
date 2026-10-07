// scripts/audit-estimate-promise-first.ts — 3巡目（10/07）: 見積の依頼（物件の初期費用を聞かれた番）にスタッフは
//   ①先に約束の手打ち（「御見積書作成しお送り…」）→後で AIX【見積書送る】 ②何も打たずに AIX【見積書送る】だけ ③他 のどれか（読むだけ・LLM なし）
//   2段の決まり（10/02 見積書送る→いつも約束の返信が先）が 10/03〜の道の違い（初期費用の場面 1/8）の出所かを確かめる
// 実行: npx tsx --env-file=.env.local scripts/audit-estimate-promise-first.ts [--days=120] [--show]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { resolveReplyScene } from "../app/lib/reply-scene";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=120").slice(7));
const SHOW = process.argv.includes("--show");
type M = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
type P = { conversation_id: string; aix_type: string; created_at: string };
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; for (let i = 0; i < 1_000_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; } return out;
}
const PROMISE_EST_RE = /見積[^\n。！!]{0,20}(?:作成|お送り|ご用意|お出し)|最大限割引[^\n]{0,20}(?:作成|お送り)/;
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const [msgs, presses] = await Promise.all([
    readAll<M>((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").gte("created_at", since).order("conversation_id").order("created_at").range(f, t)),
    readAll<P>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at").gte("created_at", since).not("aix_type", "is", null).order("created_at").range(f, t)),
  ]);
  const pBy = new Map<string, P[]>(); for (const p of presses) (pBy.get(p.conversation_id) ?? pBy.set(p.conversation_id, []).get(p.conversation_id)!).push(p);
  const by = new Map<string, M[]>(); for (const m of msgs) { if (isTestConversation(m.conversation_id)) continue; (by.get(m.conversation_id) ?? by.set(m.conversation_id, []).get(m.conversation_id)!).push(m); }
  const t = { promiseFirst: 0, aixOnly: 0, other: 0, promiseGapH: [] as number[], aixGapH: [] as number[] };
  const shows: string[] = [];
  for (const [cid, ms] of by) {
    const ps = pBy.get(cid) ?? [];
    for (let i = 1; i < ms.length; i++) {
      if (ms[i].sender !== "customer" || ms[i - 1].sender === "customer") continue;
      let j = i; while (j + 1 < ms.length && ms[j + 1].sender === "customer") j++;
      const turn = ms.slice(i, j + 1).map((x) => x.text ?? "").join("\n");
      if (resolveReplyScene({ customerText: turn }).scene !== "cost") continue;
      if (ps.some((p) => p.aix_type === "application_push" && p.created_at <= ms[j].created_at)) continue;
      // こちらが前に物件を送っている（AIX の物件・資料）か、お客様が物件を指している
      const sentBefore = ps.some((p) => /^(?:property_send|property_recommendation|property_check_result)$/.test(p.aix_type) && p.created_at <= ms[j].created_at);
      if (!sentBefore) continue;
      const next = ms.slice(j + 1).find((x) => x.sender !== "customer");
      const nextCust = ms.slice(j + 1).find((x) => x.sender === "customer");
      const est = ps.find((p) => p.aix_type === "estimate_sheet" && p.created_at > ms[j].created_at && (!nextCust || p.created_at < nextCust.created_at));
      if (!next) continue;
      const gapH = (Date.parse(next.created_at) - Date.parse(ms[j].created_at)) / 3_600_000;
      if (!next.is_aix_generated && PROMISE_EST_RE.test(next.text ?? "")) { t.promiseFirst++; t.promiseGapH.push(gapH); if (SHOW && shows.length < 20) shows.push(`約束→ 客「${turn.replace(/\n/g, " ").slice(0, 50)}」人「${(next.text ?? "").replace(/\n/g, " / ").slice(0, 70)}」${gapH.toFixed(1)}h`); }
      else if (est && Math.abs(Date.parse(est.created_at) - Date.parse(next.created_at)) < 10 * 60_000) { t.aixOnly++; t.aixGapH.push(gapH); if (SHOW && shows.length < 40) shows.push(`AIX→ 客「${turn.replace(/\n/g, " ").slice(0, 50)}」${gapH.toFixed(1)}h`); }
      else t.other++;
    }
  }
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)].toFixed(1) : "-");
  const n = t.promiseFirst + t.aixOnly + t.other;
  console.log(`初期費用の場面（物件を送った後・申込前・${DAYS}日）${n}番: 先に約束の手打ち ${t.promiseFirst}（中央 ${med(t.promiseGapH)}h）／打たずに AIX【見積書送る】 ${t.aixOnly}（中央 ${med(t.aixGapH)}h）／他 ${t.other}`);
  for (const s of shows) console.log("  " + s);
})().catch((e) => { console.error(e); process.exit(1); });
