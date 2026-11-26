// scripts/audit-estimate-unsent-cause.ts — 「済みなのに見積を送っていない見積の予定」を、記録のずれか本当の送り漏れかに分ける（読むだけ・LLM なし・台帳 #580 の続き）
// 2026-11-26 作業員L（竹内さん「他にもAIXツールのブレインと連携ちゃんとさせて質上げる部分はないのか」・統括役の頼み）
//   audit-estimate-done-unsent と同じ予定（calendar_events estimate_sheet・済み・申込以降とテストを外す）のうち、窓（前3日〜後2日）に送った印が無い物を、
//   ①窓の外に見積書ツールの記録がある（日のずれ）②こちらの手打ちの通に御見積書・初期費用の言葉（ツールを通さず送った）③こちらが画像を送った（見積書を画像で）
//   ④同じ会話・同じ日に別の見積の予定があり、そちらは送った印がある（重複の済み）⑤どれも無い＝本当の送り漏れ の順に1つに分ける。出すのは数と会話の頭8字だけ
// 実行: npx tsx --env-file=.env.local scripts/audit-estimate-unsent-cause.ts [--days=30]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation, isNoLineTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const POST = new Set(["applying", "contract", "won", "screening", "approved", "contracted"]);
const D = 864e5;
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const days = Number(arg("days", "30"));
  const since = new Date(Date.now() - days * D).toISOString();
  const { data: ev } = await sb.from("calendar_events").select("id, conversation_id, start_at, is_done").eq("event_type", "estimate_sheet").gte("start_at", since).limit(3000);
  const rows = ((ev ?? []) as Array<{ id: string; conversation_id: string | null; start_at: string; is_done: boolean }>).filter((r) => r.conversation_id && r.is_done && !isTestConversation(r.conversation_id) && !isNoLineTestConversation(r.conversation_id));
  const sentIn = async (c: string, a: number, b: number) => {
    const [rec, aix] = await Promise.all([
      sb.from("estimate_records").select("id", { count: "exact", head: true }).eq("conversation_id", c).gte("created_at", new Date(a).toISOString()).lte("created_at", new Date(b).toISOString()),
      sb.from("aix_usage_logs").select("id", { count: "exact", head: true }).eq("conversation_id", c).gte("sent_at", new Date(a).toISOString()).lte("sent_at", new Date(b).toISOString()).or("aix_type.eq.estimate_sheet,estimate_sent.eq.true"),
    ]);
    return (rec.count ?? 0) + (aix.count ?? 0) > 0;
  };
  const tally = new Map<string, string[]>();
  const put = (k: string, c: string) => tally.set(k, [...(tally.get(k) ?? []), c.slice(0, 8)]);
  for (const r of rows) {
    const c = r.conversation_id!;
    const { data: cv } = await sb.from("conversations").select("status").eq("id", c).maybeSingle();
    if (POST.has(String((cv as { status?: string } | null)?.status ?? ""))) continue;
    const t = Date.parse(r.start_at), a = t - 3 * D, b = t + 2 * D;
    if (await sentIn(c, a, b)) continue;
    if (await sentIn(c, t - 14 * D, t + 14 * D)) { put("①窓の外に見積書ツールの記録（日のずれ）", c); continue; }
    const { data: ms } = await sb.from("messages").select("text, image_url, is_aix_generated").eq("conversation_id", c).eq("sender", "staff").gte("created_at", new Date(a).toISOString()).lte("created_at", new Date(b).toISOString()).limit(200);
    const st = (ms ?? []) as Array<{ text: string | null; image_url: string | null; is_aix_generated: boolean | null }>;
    if (st.some((m) => !m.is_aix_generated && /御見積書となります|お見積(?:り|もり)?(?:を|書を)?お送り(?:させて頂き|致し|いたし)ました|初期費用(?:は|が)[^。]{0,20}(?:円|万)/.test(String(m.text ?? "")))) { put("②手打ちの通で見積を送った（ツールを通さない）", c); continue; }
    if (st.some((m) => m.image_url)) { put("③こちらが画像を送った（見積書を画像で送った疑い）", c); continue; }
    const same = rows.filter((x) => x.conversation_id === c && x.id !== r.id && Math.abs(Date.parse(x.start_at) - t) < D);
    let dupOk = false;
    for (const s of same) if (await sentIn(c, Date.parse(s.start_at) - 3 * D, Date.parse(s.start_at) + 2 * D)) { dupOk = true; break; }
    if (dupOk) { put("④同じ日の別の見積の予定は送った（重複の済み）", c); continue; }
    put("⑤本当の送り漏れ（印が何も無い）", c);
    await new Promise((res) => setTimeout(res, 60));
  }
  const all = [...tally.values()].reduce((s, x) => s + x.length, 0);
  console.log(`# 済みなのに見積を送っていない見積の予定の元（${days}日・${all}件）\n`);
  for (const [k, cs] of tally) console.log(`- ${k}: ${cs.length}件（${new Set(cs).size}会話: ${[...new Set(cs)].join(" ")}）`);
})().catch((e) => { console.error(e); process.exit(1); });
