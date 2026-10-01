// scripts/audit-property-send-now.ts — ブレインが AIX【物件ピックアップ／オススメ】を選んだ番で、スタッフはその場で物件を送ったか・探す宣言を手打ちしたか（読むだけ）
// 2026-10-01 YUMA の再生（scripts/yuma-replay-scenarios.ts）: 条件の言い直し（「御堂筋線で1本の場所とか」「家賃を15万円までにした場合」）で
//   ブレインが property_send（reply_mode=aix＝下書きなし）を選び、スタッフは「…新たにピックアップしてお送りさせて頂きます」と手打ちしていた。
//   送る物件（売上サポのピックアップ）がまだ無い時は AIX を押せない＝自動の返信も出ない（ボトルネック）。送れる物件の有無で分けて数える。
// 実行: npx tsx --env-file=.env.local scripts/audit-property-send-now.ts [--days=60] [--show]
import { createClient } from "@supabase/supabase-js";
import { staffWindowOf, type WindowMsg, type WindowPress } from "../app/lib/line-watch-judge";
import { isTestConversation } from "../app/lib/test-conversations";
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "60"));
const SHOW = process.argv.includes("--show");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 400_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}
type Msg = WindowMsg & { conversation_id: string };
type Press = WindowPress & { conversation_id: string };
type Dec = { conversation_id: string; created_at: string; analyzed_msg_ts: string | null; suggested_action: string | null; suggested_reply_mode: string | null; decision_source: string | null };
type Pick = { conversation_id: string; created_at: string; sent_at: string | null };
const DECL_RE = /ピックアップ[^\n]{0,20}(?:お送り|させて)|お探し(?:させて|して)|探させて|お調べさせて|新着[^\n]{0,12}お送り/;
async function main() {
  const since = new Date(Date.now() - (DAYS + 2) * 86_400_000).toISOString();
  const [msgs, presses, decs, picks] = await Promise.all([
    readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(f, t)),
    readAll<Press>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").gte("created_at", since).not("aix_type", "is", null).order("created_at").range(f, t)),
    readAll<Dec>((f, t) => sb.from("brain_decision_logs").select("conversation_id, created_at, analyzed_msg_ts, suggested_action, suggested_reply_mode, decision_source").gte("created_at", since).in("suggested_action", ["property_send", "property_recommendation"]).order("created_at").range(f, t)),
    readAll<Pick>((f, t) => sb.from("property_pickups").select("conversation_id, created_at, sent_at").gte("created_at", new Date(Date.now() - (DAYS + 30) * 86_400_000).toISOString()).range(f, t)),
  ]);
  const by = <T extends { conversation_id: string }>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) { if (!m.has(r.conversation_id)) m.set(r.conversation_id, []); m.get(r.conversation_id)!.push(r); } return m; };
  const mBy = by(msgs), pBy = by(presses), kBy = by(picks);
  const seen = new Set<string>();
  const cell = new Map<string, { n: number; sendNow: number; declText: number; otherText: number; otherAix: number; none: number; ex: string[] }>();
  for (const d of decs) {
    if (isTestConversation(d.conversation_id) || !d.analyzed_msg_ts) continue;
    const key = `${d.conversation_id}|${d.analyzed_msg_ts}`;
    if (seen.has(key)) continue; seen.add(key);
    const ms = mBy.get(d.conversation_id) ?? [];
    const w = staffWindowOf({ customerTurnAt: d.analyzed_msg_ts, msgs: ms, presses: pBy.get(d.conversation_id) ?? [] });
    if (!w.closed) continue;
    const decAt = Date.parse(d.created_at);
    const ready = (kBy.get(d.conversation_id) ?? []).some((p) => Date.parse(p.created_at) <= decAt + 60_000 && (!p.sent_at || Date.parse(p.sent_at) > decAt));
    const k = `${ready ? "送れる物件あり" : "送れる物件なし"}・mode=${d.suggested_reply_mode ?? "-"}`;
    const c = cell.get(k) ?? { n: 0, sendNow: 0, declText: 0, otherText: 0, otherAix: 0, none: 0, ex: [] };
    c.n++;
    const bp = w.presses.filter((p) => p.burst).map((p) => p.aix_type);
    const bt = w.texts.filter((t) => t.burst).map((t) => t.text).join(" / ");
    if (bp.some((a) => a === "property_send" || a === "property_recommendation")) c.sendNow++;
    else if (bp.length) c.otherAix++;
    else if (bt && DECL_RE.test(bt)) c.declText++;
    else if (bt) c.otherText++;
    else c.none++;
    const cust = ms.filter((m) => m.sender === "customer" && m.created_at >= d.analyzed_msg_ts!).slice(0, 2).map((m) => m.text ?? "").join(" ").replace(/\n/g, " ").slice(0, 60);
    if (c.ex.length < 25) c.ex.push(`${bp.join("+") || (bt ? "手打ち" : "なし")}｜C:${cust}｜S:${bt.replace(/\n/g, " ").slice(0, 70)}`);
    cell.set(k, c);
  }
  for (const [k, c] of [...cell].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`${k.padEnd(28)} n=${c.n} その場で物件送付=${c.sendNow} 探す宣言の手打ち=${c.declText} 他の手打ち=${c.otherText} 他のAIX=${c.otherAix} 送らず=${c.none}`);
    if (SHOW) for (const e of c.ex) console.log(`    ${e}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
