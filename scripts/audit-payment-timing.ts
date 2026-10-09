// scripts/audit-payment-timing.ts — 申込→審査通過→初期費用のお振込の期日の実際の日数を、スタッフの実送信から数える（読むだけ・LLM なし）
//   10/08 竹内「初期費用の振込が12月下旬以降になるように逆算して申込していく」の数字の根拠（app/lib/payment-timing.ts の定数）。
//   ①スタッフの送信で「審査通過／承認／審査OK」を伝えた時刻 → 同じ会話で「お振込（期日・期限・までに）」を伝えた送信の時刻と、文中の期日
//   ②申込（deal_outcomes.applied_at）→ 審査通過の送信
//   ③「お振込」と「申込」の時期の言い回しの実物（逆算の型があるか）
// 実行: npx tsx --env-file=.env.local scripts/audit-payment-timing.ts [--days=365] [--n=30]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "365")); const N = Number(arg("n", "30"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
type M = { conversation_id: string; sender: string; created_at: string; text: string | null; staff_writer: string | null };
const PASS_RE = /審査(?:の結果)?[^。\n]{0,12}(?:通過|承認|OK|ＯＫ|通りました|可決)|(?:無事|ご)?審査通過/;
const PAY_RE = /(?:お振込|お振り込み|振込|ご入金|入金)/;
const DUE_RE = /(\d{1,2})[\/月](\d{1,2})日?[^。\n]{0,20}(?:まで|迄|期日|期限)|(?:期日|期限)[^。\n]{0,10}(\d{1,2})[\/月](\d{1,2})/;
const BACK_RE = /(?:お申込|申込|お申し込み)[^。\n]{0,40}(?:お振込|振込|ご入金|初期費用)[^。\n]{0,30}(?:頃|以降|になります|となります)|(?:お振込|振込|ご入金)[^。\n]{0,30}(?:以降|頃)[^。\n]{0,30}(?:お申込|申込)/;
const jst = (iso: string) => new Date(Date.parse(iso) + 9 * 3600e3);
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN; };
(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const msgs: M[] = [];
  for (let i = 0; i < 600_000; i += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, created_at, text, staff_writer").neq("sender", "customer").gte("created_at", since).or("text.ilike.%審査%,text.ilike.%振込%,text.ilike.%入金%,text.ilike.%振り込み%").order("created_at").range(i, i + 999);
    if (error) throw error; msgs.push(...(data ?? []) as M[]); if ((data ?? []).length < 1000) break;
  }
  const by = new Map<string, M[]>(); for (const m of msgs) { if (isTestConversation(m.conversation_id)) continue; (by.get(m.conversation_id) ?? by.set(m.conversation_id, []).get(m.conversation_id)!).push(m); }
  const outs: Array<{ conversation_id: string; applied_at: string | null }> = [];
  for (let i = 0; ; i += 1000) { const { data } = await sb.from("deal_outcomes").select("conversation_id, applied_at").not("applied_at", "is", null).range(i, i + 999); outs.push(...(data ?? []) as any); if ((data ?? []).length < 1000) break; }
  const applied = new Map(outs.map((o) => [o.conversation_id, o.applied_at!]));
  const passToPay: number[] = [], passToDue: number[] = [], applyToPass: number[] = [], applyToDue: number[] = [];
  const ex: string[] = [], back: string[] = [];
  for (const [cid, list] of by) {
    const pass = list.find((m) => PASS_RE.test(m.text ?? ""));
    for (const m of list) if (BACK_RE.test(m.text ?? "") && back.length < N) back.push(`${m.created_at.slice(0, 10)} ${cid.slice(0, 6)} ${m.staff_writer ?? "-"}: ${(m.text ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
    if (!pass) continue;
    const pt = Date.parse(pass.created_at);
    const ap = applied.get(cid); if (ap && Date.parse(ap) <= pt) applyToPass.push((pt - Date.parse(ap)) / 864e5);
    const pay = list.find((m) => Date.parse(m.created_at) >= pt && PAY_RE.test(m.text ?? "") && Date.parse(m.created_at) - pt < 30 * 864e5);
    if (!pay) continue;
    passToPay.push((Date.parse(pay.created_at) - pt) / 864e5);
    const d = (pay.text ?? "").normalize("NFKC").match(DUE_RE);
    if (d) {
      const mo = Number(d[1] ?? d[3]), da = Number(d[2] ?? d[4]); const pj = jst(pass.created_at);
      let due = Date.UTC(pj.getUTCFullYear(), mo - 1, da); if (due < Date.UTC(pj.getUTCFullYear(), pj.getUTCMonth(), pj.getUTCDate()) - 30 * 864e5) due = Date.UTC(pj.getUTCFullYear() + 1, mo - 1, da);
      const days = (due - Date.UTC(pj.getUTCFullYear(), pj.getUTCMonth(), pj.getUTCDate())) / 864e5;
      if (days >= 0 && days <= 40) { passToDue.push(days); if (ap) applyToDue.push((due - Date.parse(ap) - 9 * 3600e3) / 864e5); }
    }
    if (ex.length < N) ex.push(`${cid.slice(0, 6)} 通過 ${pass.created_at.slice(0, 10)}「${(pass.text ?? "").replace(/\s+/g, " ").slice(0, 70)}」→ 振込の連絡 ${pay.created_at.slice(0, 10)}「${(pay.text ?? "").replace(/\s+/g, " ").slice(0, 110)}」`);
  }
  const line = (k: string, a: number[]) => console.log(`${k.padEnd(28)} n=${a.length} 中央 ${med(a).toFixed(1)}日・25% ${q(a, 0.25).toFixed(1)}・75% ${q(a, 0.75).toFixed(1)}・90% ${q(a, 0.9).toFixed(1)}`);
  line("申込→審査通過の連絡", applyToPass); line("審査通過→振込の連絡", passToPay); line("審査通過→文中の振込期日", passToDue); line("申込→文中の振込期日", applyToDue);
  console.log("\n== 実物（審査通過→振込）"); for (const e of ex) console.log("  " + e);
  console.log("\n== 申込と振込の時期を結ぶ言い回し"); for (const b of back) console.log("  " + b);
})();
