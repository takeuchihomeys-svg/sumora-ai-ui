// scripts/audit-promise-order-pickup.ts — 約束が2つ以上残った時、人はピックアップ（物件の AIX）を先に送ったか、確認・見積を先にしたか（読むだけ・LLM なし）
//   2026-10-09 竹内さん「ピックアップが必要なお客様（まだ物件を送っていない・送った物件が合わない/出し切り・『他にも送って』）はピックアップの優先度を上げる」の線を実データで決める
// 実行: npx tsx --env-file=.env.local scripts/audit-promise-order-pickup.ts [--days=120] [--show=1]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { buildPromiseQueue, pickupNeedSignals, PROMISE_KIND_JA, type QueueAixLog } from "../app/lib/promise-queue";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "120")); const SHOW = arg("show", "") === "1";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function all<T>(q: (from: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 1_000_000; i += 1000) {
    let r = await q(i);
    for (let t = 0; t < 3 && r.error && /timeout/i.test(r.error.message); t++) { await new Promise((z) => setTimeout(z, 3000)); r = await q(i); }
    if (r.error) throw new Error(r.error.message);
    const rows = (r.data ?? []) as T[]; out.push(...rows); if (rows.length < 1000) break;
  }
  return out;
}
type M = { conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null; staff_writer: string | null };
type L = { conversation_id: string; aix_type: string; check_pattern: string | null; sent_at: string | null; created_at: string; estimate_sent: boolean | null; generated_text: string | null };
async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const [msgs, logs] = await Promise.all([
    all<M>((i) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated, staff_writer").gte("created_at", since).order("created_at").order("id").range(i, i + 999)),
    all<L>((i) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, sent_at, created_at, estimate_sent, generated_text").gte("created_at", since).order("created_at").range(i, i + 999)),
  ]);
  const by = new Map<string, M[]>(); for (const m of msgs) { if (isTestConversation(m.conversation_id)) continue; (by.get(m.conversation_id) ?? by.set(m.conversation_id, []).get(m.conversation_id)!).push(m); }
  const lb = new Map<string, L[]>(); for (const l of logs) (lb.get(l.conversation_id) ?? lb.set(l.conversation_id, []).get(l.conversation_id)!).push(l);
  type Row = { cid: string; at: string; pickupFirst: boolean; sig: ReturnType<typeof pickupNeedSignals>; others: string; writer: string | null };
  const rows: Row[] = [];
  for (const [cid, list] of by) {
    const qMsgs = list.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: !!m.is_aix_generated }));
    const qLogs: QueueAixLog[] = (lb.get(cid) ?? []).map((l) => ({ aixType: l.aix_type, checkPattern: l.check_pattern, sentAt: l.sent_at ?? l.created_at, estimateSent: l.estimate_sent, text: l.generated_text }));
    const q = buildPromiseQueue(qMsgs, qLogs, Date.now(), { windowDays: DAYS });
    const groups = new Map<string, typeof q>(); for (const s of q) (groups.get(s.promisedAt) ?? groups.set(s.promisedAt, []).get(s.promisedAt)!).push(s);
    for (const [at, g] of groups) {
      const pk = g.find((s) => s.kind === "pickup" && !s.watch && s.status === "done");
      const ot = g.filter((s) => s.kind !== "pickup" && s.status === "done");
      if (!pk || !ot.length) continue;
      const firstOther = Math.min(...ot.map((s) => Date.parse(s.doneAt!)));
      if (Date.parse(pk.doneAt!) === firstOther) continue;
      const atMs = Date.parse(at);
      const sig = pickupNeedSignals(qMsgs.filter((m) => Date.parse(m.createdAt) <= atMs), qLogs.filter((l) => Date.parse(l.sentAt) <= atMs));
      rows.push({ cid, at, pickupFirst: Date.parse(pk.doneAt!) < firstOther, sig, others: ot.map((s) => PROMISE_KIND_JA[s.kind]).join("・"), writer: list.find((m) => m.created_at === at)?.staff_writer ?? null });
    }
  }
  const any = (r: Row) => r.sig.noPropertiesSent || r.sig.sentNotFit || r.sig.customerAskedMore;
  const pf = (x: Row[]) => `${x.filter((r) => r.pickupFirst).length}/${x.length}`;
  const tab = (name: string, f: (r: Row) => boolean, rs = rows) => console.log(`${name}: 当てはまる ピックアップ先 ${pf(rs.filter(f))} ／ 当てはまらない ${pf(rs.filter((r) => !f(r)))}`);
  console.log(`== ${DAYS}日・ピックアップと他を同じ通で約束し両方果たした組 ${rows.length}（竹内さん ${rows.filter((r) => r.writer === "takeuchi").length}）・ピックアップを先に ${rows.filter((r) => r.pickupFirst).length}`);
  tab("まだ物件を送っていない", (r) => r.sig.noPropertiesSent);
  tab("送った物件が合わない・出し切り", (r) => r.sig.sentNotFit);
  tab("お客様が他にも・探してと頼んだ", (r) => r.sig.customerAskedMore);
  tab("どれか", any);
  tab("竹内さんの番だけ・どれか", any, rows.filter((r) => r.writer === "takeuchi"));
  if (SHOW) for (const r of rows) console.log(`  ${r.cid.slice(0, 6)} ${r.at.slice(5, 16)} ${r.writer ?? "-"} ピックアップ${r.pickupFirst ? "先" : "後"}（他=${r.others}） 未送付=${r.sig.noPropertiesSent} 合わない=${r.sig.sentNotFit} 頼んだ=${r.sig.customerAskedMore}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
