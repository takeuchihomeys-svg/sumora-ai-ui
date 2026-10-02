// scripts/audit-two-stage-matrix.ts
// 2026-10-02 竹内さんの決定（2段の場面）の当て直し: 本番のブレインの判断（brain_decision_logs）に resolveTwoStage を当て、
//   スタッフの実際（返事のまとまりの AIX／手打ち）と比べた一致を、前（AIX のまま）と後（約束の返信に変える）で数える。読むだけ・LLM なし。
//   一致: 判断が返信 ⇔ スタッフが手打ち（AIX を押していない）／判断が AIX ⇔ スタッフがその AIX（物件の AIX は send/recommendation を同じに）
//   送れる物件（pickupReady）＝その判断の時点で売上サポに作られていて、まだ送っていないピックアップがある
// 実行: npx tsx --env-file=.env.local scripts/audit-two-stage-matrix.ts [--days=30]
import { createClient } from "@supabase/supabase-js";
import { staffWindowOf, type WindowMsg, type WindowPress } from "../app/lib/line-watch-judge";
import { resolveTwoStage } from "../app/lib/two-stage";
import { isTestConversation } from "../app/lib/test-conversations";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=30").slice(7));
type M = WindowMsg & { conversation_id: string };
type P = WindowPress & { conversation_id: string };
type D = { conversation_id: string; created_at: string; analyzed_msg_ts: string | null; suggested_action: string | null; suggested_reply_mode: string | null; decision_source: string | null; conversation_status: string | null };
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; for (let i = 0; i < 400_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; } return out;
}
const POST = /^(?:applying|application|screening|contract|approved|closed_won)$/;
const same = (a: string, b: string) => a === b || (/^property_(send|recommendation)$/.test(a) && /^property_(send|recommendation)$/.test(b));
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const [msgs, presses, decs, picks] = await Promise.all([
    readAll<M>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(f, t)),
    readAll<P>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").gte("created_at", since).not("aix_type", "is", null).order("created_at").range(f, t)),
    readAll<D>((f, t) => sb.from("brain_decision_logs").select("conversation_id, created_at, analyzed_msg_ts, suggested_action, suggested_reply_mode, decision_source, conversation_status").gte("created_at", since).order("created_at").range(f, t)),
    readAll<{ conversation_id: string; created_at: string; sent_at: string | null }>((f, t) => sb.from("property_pickups").select("conversation_id, created_at, sent_at").gte("created_at", new Date(Date.now() - (DAYS + 30) * 86_400_000).toISOString()).range(f, t)),
  ]);
  const by = <T extends { conversation_id: string }>(rows: T[]) => { const mp = new Map<string, T[]>(); for (const r of rows) { if (!mp.has(r.conversation_id)) mp.set(r.conversation_id, []); mp.get(r.conversation_id)!.push(r); } return mp; };
  const mBy = by(msgs), pBy = by(presses), kBy = by(picks);
  const last = new Map<string, D>();
  for (const d of decs) { if (!d.analyzed_msg_ts || isTestConversation(d.conversation_id)) continue; last.set(`${d.conversation_id}|${d.analyzed_msg_ts}`, d); }
  const cell = new Map<string, { n: number; before: number; after: number; staffText: number; staffAix: number }>();
  let N = 0, B = 0, A = 0;
  for (const d of last.values()) {
    const ps = pBy.get(d.conversation_id) ?? [];
    if (ps.some((p) => p.aix_type === "application_push" && p.created_at <= d.analyzed_msg_ts!)) continue;
    const ms = mBy.get(d.conversation_id) ?? [];
    const w = staffWindowOf({ customerTurnAt: d.analyzed_msg_ts!, msgs: ms, presses: ps });
    if (!w.closed) continue;
    const bp = [...new Set(w.presses.filter((p) => p.burst).map((p) => p.aix_type))];
    const bt = w.texts.filter((t) => t.burst).map((t) => t.text).join("\n");
    if (!bp.length && !bt) continue; // スタッフが何も送っていない番は数えない
    const brain = d.suggested_reply_mode === "aix" && d.suggested_action ? d.suggested_action : "reply";
    const decAt = Date.parse(d.created_at);
    const pickupReady = (kBy.get(d.conversation_id) ?? []).some((k) => Date.parse(k.created_at) <= decAt + 60_000 && (!k.sent_at || Date.parse(k.sent_at) > decAt));
    const turn = ms.filter((m) => m.sender === "customer" && m.created_at >= d.analyzed_msg_ts!).slice(0, 4).map((m) => m.text ?? "").join("\n");
    const ts = brain === "reply" ? null : resolveTwoStage({ finalAix: brain, decisionSource: d.decision_source, pickupReady, postApply: POST.test(d.conversation_status ?? ""), asksCost: /初期費用|見積|いくら|費用/.test(turn) });
    const after = ts ? "reply" : brain;
    const okOf = (x: string) => (x === "reply" ? bp.length === 0 : bp.some((a) => same(a, x)));
    const k = `${brain}${ts ? `→返信(${ts.kind})` : ""}`;
    const c = cell.get(k) ?? { n: 0, before: 0, after: 0, staffText: 0, staffAix: 0 };
    c.n++; if (okOf(brain)) c.before++; if (okOf(after)) c.after++; if (bp.length) c.staffAix++; else c.staffText++;
    cell.set(k, c); N++; if (okOf(brain)) B++; if (okOf(after)) A++;
  }
  console.log(`本番の判断（${DAYS}日・スタッフが返事をした番）${N}: 一致 前 ${B}（${((B / N) * 100).toFixed(1)}%）→ 後 ${A}（${((A / N) * 100).toFixed(1)}%）`);
  for (const [k, c] of [...cell].sort((a, b) => b[1].n - a[1].n).slice(0, 18)) console.log(`  ${k.padEnd(44)} n=${String(c.n).padStart(3)} 一致 前 ${c.before}→後 ${c.after}（スタッフ 手打ち ${c.staffText}・AIX ${c.staffAix}）`);
})();
