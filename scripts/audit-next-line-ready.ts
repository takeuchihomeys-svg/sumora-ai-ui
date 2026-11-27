// scripts/audit-next-line-ready.ts — 「次に来やすい通の種類の上位2つ」（判断の後の記録 digest.nl）の備えが当たったかを数える（2026-11-27 作業員A）
//   予想の当て物ではなく備えの当たり: 判断の番の後、48時間の内にお客様の次の通が来た番で、その通の種類（classifyCustomerBurst・#804 と同じ）が digest.nl の2つに入ったか。
//   48時間に来なければ「返事なし」として数える（#804 の表と同じ）。物差し: どの場面でも同じ2つ（NEXT_LINE_BASE）を言った時の当たり＝場面で分けた値打ちがあるか。
//   読むのは brain_decision_logs（digest.nl のある行）と、その会話の番の後のお客様の通だけ（軽い読み）。書かない・LLM なし。
//   実行: npx tsx --env-file=.env.local scripts/audit-next-line-ready.ts [--days=14]
import { createClient } from "@supabase/supabase-js";
import { classifyCustomerBurst, REACTION_JA } from "../app/lib/customer-reaction-predict";
import { NEXT_LINE_BASE } from "../app/lib/after-decision-records";

const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "14");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "", { auth: { persistSession: false } });

async function main() {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const { data, error } = await sb.from("brain_decision_logs").select("conversation_id, analyzed_msg_ts, digest").gte("created_at", since).not("digest->>nl", "is", null).limit(2000);
  if (error) throw error;
  let n = 0, hit = 0, baseHit = 0, open = 0;
  const byKind: Record<string, { n: number; hit: number }> = {};
  for (const r of (data ?? []) as Array<{ conversation_id: string; analyzed_msg_ts: string | null; digest: { nl?: string } | null }>) {
    const top = String(r.digest?.nl ?? "").split("・").filter(Boolean);
    if (!top.length || !r.analyzed_msg_ts) continue;
    const t0 = Date.parse(r.analyzed_msg_ts);
    if (Date.now() - t0 < 48 * 36e5) { open++; continue; } // まだ48時間たっていない＝数えない
    const { data: ms } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", r.conversation_id).gt("created_at", r.analyzed_msg_ts).lte("created_at", new Date(t0 + 48 * 36e5).toISOString()).order("created_at", { ascending: true }).limit(30);
    const rows = (ms ?? []) as Array<{ sender: string; text: string | null }>;
    const k = rows.findIndex((m) => m.sender === "customer");
    const burst: string[] = []; if (k >= 0) for (let j = k; j < rows.length && rows[j].sender === "customer"; j++) burst.push(String(rows[j].text ?? ""));
    const kind = k >= 0 ? REACTION_JA[classifyCustomerBurst(burst)] : REACTION_JA.silent;
    n++; if (top.includes(kind)) hit++; if (NEXT_LINE_BASE.includes(kind)) baseHit++;
    const o = (byKind[kind] ??= { n: 0, hit: 0 }); o.n++; if (top.includes(kind)) o.hit++;
  }
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "—");
  console.log(JSON.stringify({ 日: DAYS, 数えた番: n, 備えが当たった: `${hit}（${pct(hit, n)}）`, 同じ2つの物差し: `${baseHit}（${pct(baseHit, n)}）`, まだ48時間たっていない: open, 次の通の種類ごと: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, `${v.hit}/${v.n}`])) }));
}
main().catch((e) => { console.error(e); process.exit(1); });
