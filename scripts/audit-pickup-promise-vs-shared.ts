// scripts/audit-pickup-promise-vs-shared.ts
// 2026-10-02 ⑫ 22巡の分類（B: flow2_t02）: 前のピックアップの約束（promise:pickup・signal:pending_pickup）で物件ピックアップを出した番を、
//   お客様が今回自分で物件（URL・画像・物件の共有文）を送ってきたかで分け、スタッフの実際（物件の AIX／確認・見積書／手打ち）を数える。読むだけ・LLM なし
// 実行: npx tsx --env-file=.env.local scripts/audit-pickup-promise-vs-shared.ts [--days=60]
import { createClient } from "@supabase/supabase-js";
import { staffWindowOf, type WindowMsg, type WindowPress } from "../app/lib/line-watch-judge";
import { isTestConversation } from "../app/lib/test-conversations";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=60").slice(7));
type M = WindowMsg & { conversation_id: string };
type P = WindowPress & { conversation_id: string };
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; for (let i = 0; i < 400_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; } return out;
}
export const CUSTOMER_SHARED_PROPERTY_RE = /https?:\/\/|\[画像\]|物件種目|suumo|homes\.co\.jp|athome|chintai/i;
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const picks = await readAll<{ conversation_id: string; created_at: string; sent_at: string | null }>((f, t) => sb.from("property_pickups").select("conversation_id, created_at, sent_at").gte("created_at", new Date(Date.now() - (DAYS + 30) * 86_400_000).toISOString()).range(f, t));
  const [msgs, presses, decs] = await Promise.all([
    readAll<M>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(f, t)),
    readAll<P>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").gte("created_at", since).not("aix_type", "is", null).order("created_at").range(f, t)),
    readAll<{ conversation_id: string; analyzed_msg_ts: string | null; suggested_action: string | null; decision_source: string | null }>((f, t) => sb.from("brain_decision_logs").select("conversation_id, analyzed_msg_ts, suggested_action, decision_source").gte("created_at", since).in("suggested_action", ["property_send", "property_recommendation"]).order("created_at").range(f, t)),
  ]);
  const by = <T extends { conversation_id: string }>(rows: T[]) => { const mp = new Map<string, T[]>(); for (const r of rows) { if (!mp.has(r.conversation_id)) mp.set(r.conversation_id, []); mp.get(r.conversation_id)!.push(r); } return mp; };
  const mBy = by(msgs), pBy = by(presses); const seen = new Set<string>();
  const cells: Record<string, { n: number; prop: number; check: number; text: number; ex: string[] }> = {};
  for (const d of decs) {
    if (!d.analyzed_msg_ts || isTestConversation(d.conversation_id) || !/^(?:promise:pickup|signal:pending_pickup)/.test(d.decision_source ?? "")) continue;
    const key = `${d.conversation_id}|${d.analyzed_msg_ts}`; if (seen.has(key)) continue; seen.add(key);
    const ms = mBy.get(d.conversation_id) ?? [];
    const w = staffWindowOf({ customerTurnAt: d.analyzed_msg_ts, msgs: ms, presses: pBy.get(d.conversation_id) ?? [] });
    if (!w.closed) continue;
    const bp = w.presses.filter((p) => p.burst).map((p) => p.aix_type);
    const bt = w.texts.filter((t) => t.burst);
    if (!bp.length && !bt.length) continue;
    const turn = ms.filter((m) => m.sender === "customer" && m.created_at >= d.analyzed_msg_ts!).slice(0, 6).map((m) => m.text ?? "").join("\n");
    const at = Date.parse(d.analyzed_msg_ts);
    const ready = picks.some((k) => k.conversation_id === d.conversation_id && Date.parse(k.created_at) <= at + 30 * 60_000 && (!k.sent_at || Date.parse(k.sent_at) > at));
    const k = `${ready ? "送れる物件あり" : "送れる物件なし"}×${CUSTOMER_SHARED_PROPERTY_RE.test(turn) ? "お客様が物件を送った" : "送っていない"}`;
    const c = (cells[k] ??= { n: 0, prop: 0, check: 0, text: 0, ex: [] });
    c.n++;
    if (bp.some((a) => a === "property_send" || a === "property_recommendation")) c.prop++;
    else if (bp.some((a) => a === "property_check_result" || a === "estimate_sheet")) c.check++;
    else c.text++;
    if (c.ex.length < 3) c.ex.push(`${bp.join("+") || "手打ち"} | ${turn.replace(/\n/g, " ").slice(0, 50)} → ${bt.map((t) => t.text).join(" ").replace(/\n/g, " ").slice(0, 60)}`);
  }
  console.log(`本番 ${DAYS}日・前のピックアップの約束で物件の AIX を出した番（スタッフが返事をした番）`);
  for (const [k, c] of Object.entries(cells)) { console.log(`  ${k}: ${c.n}番 → 物件の AIX ${c.prop}・物件確認した/見積書 ${c.check}・手打ちだけ ${c.text}`); for (const e of c.ex) console.log(`     ${e}`); }
})();
