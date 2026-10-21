// scripts/audit-promise-queue-chrono.ts — 約束の並び（buildPromiseQueue）の前の組み立て（PROMISE_QUEUE_CHRONO=off）と時刻の順の組み立てを実データで比べる（読むだけ・LLM なし）
//   2026-10-22: 同じ種類の約束が重なると、新しい約束が「もう並んでいる」で消えていた（1191b1… 10/02）
// 実行: npx tsx --env-file=.env.local scripts/audit-promise-queue-chrono.ts [--days=60] [--n=12] [--conv=1191b1]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { buildPromiseQueue, nextPromiseAix, type PromiseStep, type QueueMsg, type QueueAixLog } from "../app/lib/promise-queue";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "60")); const N = Number(arg("n", "12")); const CONV = arg("conv", "");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
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
type M = { conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null };
type L = { conversation_id: string; aix_type: string; check_pattern: string | null; sent_at: string | null; created_at: string; estimate_sent: boolean | null; generated_text: string | null };
const mask = (s: string) => s.replace(/\d{3,}/g, "#").replace(/[一-龯ァ-ヶー]{2,}(?:様|さん)/g, "〇〇様");
const key = (s: PromiseStep) => `${s.kind}@${s.promisedAt}${s.deferred ? "/d" : ""}`;
const run = (chrono: boolean, msgs: QueueMsg[], logs: QueueAixLog[], now: number, days: number) => {
  const prev = process.env.PROMISE_QUEUE_CHRONO; process.env.PROMISE_QUEUE_CHRONO = chrono ? "on" : "off";
  try { return buildPromiseQueue(msgs, logs, now, { windowDays: days }); } finally { if (prev === undefined) delete process.env.PROMISE_QUEUE_CHRONO; else process.env.PROMISE_QUEUE_CHRONO = prev; }
};
const txt = (s: PromiseStep) => `${s.kind}${s.object ? `(${s.object})` : ""} ${s.promisedAt.slice(5, 16)}「${mask(s.evidence).slice(0, 30)}」→ ${s.status}${s.watch ? "（見張り）" : ""}${s.doneBy ? `/${s.doneBy}@${String(s.doneAt).slice(5, 16)}` : ""}`;

async function main() {
  const now = Date.now();
  const since = new Date(now - DAYS * 86_400_000).toISOString();
  const [msgs, logs, convs] = await Promise.all([
    all<M>((i) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(i, i + 999)),
    all<L>((i) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, sent_at, created_at, estimate_sent, generated_text").gte("created_at", since).order("created_at").range(i, i + 999)),
    all<{ id: string; is_post_apply: boolean | null }>((i) => sb.from("conversations").select("id, is_post_apply").range(i, i + 999)),
  ]);
  const post = new Set(convs.filter((c) => c.is_post_apply).map((c) => c.id));
  const mBy = new Map<string, QueueMsg[]>(); const lBy = new Map<string, QueueAixLog[]>();
  for (const m of msgs) { if (isTestConversation(m.conversation_id)) continue; (mBy.get(m.conversation_id) ?? mBy.set(m.conversation_id, []).get(m.conversation_id)!).push({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: !!m.is_aix_generated }); }
  for (const l of logs) (lBy.get(l.conversation_id) ?? lBy.set(l.conversation_id, []).get(l.conversation_id)!).push({ aixType: l.aix_type, checkPattern: l.check_pattern, sentAt: l.sent_at ?? l.created_at, estimateSent: l.estimate_sent, text: l.generated_text });

  let convN = 0, stepsOld = 0, stepsNew = 0, convDiff = 0;
  const c = { added: 0, addedPending: 0, addedDone: 0, addedDropped: 0, removed: 0, statusChanged: 0, oldPendingNowClosed: 0, oldClosedNowPending: 0, doneByChanged: 0 };
  const addedPendingAges: number[] = []; let nextChanged = 0, nextChangedPost = 0;
  const ex: string[] = []; const exOther: string[] = [];
  for (const [cid, qm] of mBy) {
    if (CONV && !cid.startsWith(CONV)) continue;
    convN++;
    const ql = lBy.get(cid) ?? [];
    const a = run(false, qm, ql, now, DAYS + 1), b = run(true, qm, ql, now, DAYS + 1);
    stepsOld += a.length; stepsNew += b.length;
    const ka = new Map(a.map((s) => [key(s), s])), kb = new Map(b.map((s) => [key(s), s]));
    let diff = false;
    for (const [k, s] of kb) {
      const o = ka.get(k);
      if (!o) {
        diff = true; c.added++;
        if (s.status === "pending") { c.addedPending++; addedPendingAges.push((now - Date.parse(s.promisedAt)) / 3600_000); } else if (s.status === "done") c.addedDone++; else c.addedDropped++;
        if (ex.length < N * 3) ex.push(`${cid.slice(0, 6)}${post.has(cid) ? "（申込以降）" : ""} 新しく並んだ: ${txt(s)}`);
        continue;
      }
      if (o.status !== s.status) {
        diff = true; c.statusChanged++;
        if (o.status === "pending") c.oldPendingNowClosed++;
        if (s.status === "pending") c.oldClosedNowPending++;
        if (exOther.length < N * 3) exOther.push(`${cid.slice(0, 6)} 状態: ${txt(o)}  ⇒  ${s.status}${s.doneBy ? `/${s.doneBy}@${String(s.doneAt).slice(5, 16)}` : ""}`);
      } else if (o.doneBy !== s.doneBy || o.doneAt !== s.doneAt) {
        diff = true; c.doneByChanged++;
        if (exOther.length < N * 3) exOther.push(`${cid.slice(0, 6)} 果たした物: ${txt(o)}  ⇒  ${s.doneBy}@${String(s.doneAt).slice(5, 16)}`);
      }
    }
    for (const k of ka.keys()) if (!kb.has(k)) { diff = true; c.removed++; if (exOther.length < N * 3) exOther.push(`${cid.slice(0, 6)} 消えた: ${txt(ka.get(k)!)}`); }
    if (diff) convDiff++;
    // 今の本番の窓（7日・72時間）で次の AIX が変わるか
    const na = nextPromiseAix(run(false, qm, ql, now, 7), { nowMs: now }), nb = nextPromiseAix(run(true, qm, ql, now, 7), { nowMs: now });
    if (`${na?.next.kind}@${na?.next.promisedAt}` !== `${nb?.next.kind}@${nb?.next.promisedAt}`) {
      nextChanged++; if (post.has(cid)) nextChangedPost++;
      console.log(`  次の AIX が変わる ${cid.slice(0, 6)}${post.has(cid) ? "（申込以降）" : ""}: ${na ? txt(na.next) : "なし"} ⇒ ${nb ? txt(nb.next) : "なし"}`);
    }
  }
  const age = (lo: number, hi: number) => addedPendingAges.filter((h) => h >= lo && h < hi).length;
  console.log(`\n${DAYS}日・会話 ${convN}・約束 前 ${stepsOld} → 後 ${stepsNew}・違いのある会話 ${convDiff}`);
  console.log(JSON.stringify(c));
  console.log(`新しく並んで開いたままの約束の古さ: 72時間以内 ${age(0, 72)}・72時間〜7日 ${age(72, 168)}・7〜14日 ${age(168, 336)}・14日超 ${age(336, 1e9)}`);
  console.log(`今の本番の窓（7日・72時間）で次の AIX が変わる会話 ${nextChanged}（うち申込以降＝要対応は立たない ${nextChangedPost}）`);
  console.log("\n— 新しく並んだ約束（例）"); for (const e of ex) console.log("  " + e);
  console.log("\n— ほかの違い（例）"); for (const e of exOther) console.log("  " + e);
}
main().catch((e) => { console.error(e); process.exit(1); });
