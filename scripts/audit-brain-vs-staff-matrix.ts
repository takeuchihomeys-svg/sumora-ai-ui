// scripts/audit-brain-vs-staff-matrix.ts
// 2026-10-02 ⑫（YUMA の繰り返しの実送信テスト）: 再生の外れが DeepSeek のブレインの揺れか、本番（Claude）のブレインでも起きる穴かを分けるため、
//   本番のブレインの判断（brain_decision_logs の suggested_action）と、その番のスタッフの実際（返事のまとまりの AIX／手打ち）を突き合わせた表を出す。
//   読むだけ・LLM なし。申込以降（application_push を押した後）の番は除く。
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-vs-staff-matrix.ts [--days=30] [--action=property_check_result] [--show=20]
import { createClient } from "@supabase/supabase-js";
import { staffWindowOf, type WindowMsg, type WindowPress } from "../app/lib/line-watch-judge";
import { classifyStaffTextFacts } from "../app/lib/action-ledger";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "30"));
const ACTION = arg("action", "");
const SHOW = Number(arg("show", "15"));
type Msg = WindowMsg & { conversation_id: string };
type Press = WindowPress & { conversation_id: string };
type Dec = { conversation_id: string; created_at: string; analyzed_msg_ts: string | null; suggested_action: string | null; suggested_reply_mode: string | null; decision_source: string | null };

async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 400_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const [msgs, presses, decs] = await Promise.all([
    readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(f, t)),
    readAll<Press>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").gte("created_at", since).not("aix_type", "is", null).order("created_at").range(f, t)),
    readAll<Dec>((f, t) => sb.from("brain_decision_logs").select("conversation_id, created_at, analyzed_msg_ts, suggested_action, suggested_reply_mode, decision_source").gte("created_at", since).order("created_at").range(f, t)),
  ]);
  const by = <T extends { conversation_id: string }>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) { if (!m.has(r.conversation_id)) m.set(r.conversation_id, []); m.get(r.conversation_id)!.push(r); } return m; };
  const mBy = by(msgs), pBy = by(presses);
  // 番ごとに最後の判断だけ
  const last = new Map<string, Dec>();
  for (const d of decs) { if (!d.analyzed_msg_ts || isTestConversation(d.conversation_id)) continue; last.set(`${d.conversation_id}|${d.analyzed_msg_ts}`, d); }
  const cell = new Map<string, { n: number; ex: string[] }>();
  const rowTot = new Map<string, number>();
  for (const d of last.values()) {
    const ps = pBy.get(d.conversation_id) ?? [];
    const applyAt = ps.find((p) => p.aix_type === "application_push")?.created_at;
    if (applyAt && Date.parse(d.analyzed_msg_ts!) >= Date.parse(applyAt)) continue;
    const ms = mBy.get(d.conversation_id) ?? [];
    const w = staffWindowOf({ customerTurnAt: d.analyzed_msg_ts!, msgs: ms, presses: ps });
    if (!w.closed) continue;
    const bp = [...new Set(w.presses.filter((p) => p.burst).map((p) => p.aix_type))];
    const bt = w.texts.filter((t) => t.burst).map((t) => t.text).join(" / ");
    const brain = d.suggested_reply_mode === "aix" && d.suggested_action ? d.suggested_action : "reply";
    const staff = bp.length ? bp.join("+") : bt ? (classifyStaffTextFacts(bt, null).some((e) => e.kind === "pickup_declared" && e.status === "promised") ? "reply(探す宣言)" : "reply") : "送らず";
    if (ACTION && brain !== ACTION) continue;
    const k = `${brain} → ${staff}`;
    const c = cell.get(k) ?? { n: 0, ex: [] };
    c.n++;
    const cust = ms.filter((m) => m.sender === "customer" && m.created_at >= d.analyzed_msg_ts!).slice(0, 2).map((m) => m.text ?? "").join(" ").replace(/\n/g, " ").slice(0, 50);
    if (c.ex.length < SHOW) c.ex.push(`${d.conversation_id.slice(0, 8)} src=${d.decision_source ?? "-"}｜C:${cust}｜S:${bt.replace(/\n/g, " ").slice(0, 60)}`);
    cell.set(k, c);
    rowTot.set(brain, (rowTot.get(brain) ?? 0) + 1);
  }
  console.log(`本番のブレインの判断（${DAYS}日・番ごとの最後の判断・申込以降を除く）× スタッフの実際`);
  for (const [b, n] of [...rowTot].sort((a, b) => b[1] - a[1])) {
    const rows = [...cell].filter(([k]) => k.startsWith(`${b} → `)).sort((a, b) => b[1].n - a[1].n);
    console.log(`\n■ ブレイン=${b} n=${n}: ${rows.map(([k, c]) => `${k.split(" → ")[1]} ${c.n}`).join("・")}`);
    if (ACTION) for (const [k, c] of rows) { console.log(`  [${k}]`); for (const e of c.ex) console.log(`    ${e}`); }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
