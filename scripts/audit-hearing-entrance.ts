// scripts/audit-hearing-entrance.ts — 「条件がそろっていないのに物件ピックアップ」を条件ヒアリングに変える入口（brain-core rule:conditions_incomplete_hearing）を
//   本番のブレインの判断に当てる（読むだけ・LLM なし）。2026-10-02 竹内さんの決定。
//   ブレインが property_send を選んだ番のうち、まだ物件を1件も送っていない（AIX の物件送付・🌟の資料・物件の画像の送付なし）＋条件がそろっていない番を数え、
//   その番でスタッフが実際にしたこと（条件ヒアリングの AIX・フォームの手打ち・物件ピックアップ・手打ち）を見る。
// 実行: npx tsx --env-file=.env.local scripts/audit-hearing-entrance.ts [--days=120] [--show]
import { createClient } from "@supabase/supabase-js";
import { staffWindowOf, type WindowMsg, type WindowPress } from "../app/lib/line-watch-judge";
import { isTestConversation } from "../app/lib/test-conversations";
import { pickupConditionsReady, type HearingKnown } from "../app/lib/hearing-form";
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "120"));
const SHOW = process.argv.includes("--show");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 400_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}
type Msg = WindowMsg & { conversation_id: string };
type Press = WindowPress & { conversation_id: string };
const FIELDS = "id, created_at, desired_area, commute_station, rent_min, rent_max";
const HEAR_FORM_RE = /ご希望のお部屋探しご条件|①[^\n]{0,4}入居/;
async function main() {
  const since = new Date(Date.now() - (DAYS + 2) * 86_400_000).toISOString();
  const [msgs, presses, decs, convs, pcs, hist] = await Promise.all([
    readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", new Date(Date.now() - (DAYS + 200) * 86_400_000).toISOString()).order("created_at").order("id").range(f, t)),
    readAll<Press>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").gte("created_at", new Date(Date.now() - (DAYS + 200) * 86_400_000).toISOString()).not("aix_type", "is", null).order("created_at").range(f, t)),
    readAll<{ conversation_id: string; created_at: string; analyzed_msg_ts: string | null; suggested_action: string | null; decision_source: string | null }>((f, t) => sb.from("brain_decision_logs").select("conversation_id, created_at, analyzed_msg_ts, suggested_action, decision_source").gte("created_at", since).eq("suggested_action", "property_send").order("created_at").range(f, t)),
    readAll<{ id: string; property_customer_id: string | null }>((f, t) => sb.from("conversations").select("id, property_customer_id").range(f, t)),
    readAll<Record<string, unknown> & { id: string; created_at: string }>((f, t) => sb.from("property_customers").select(FIELDS).range(f, t)),
    readAll<{ property_customer_id: string; changed_field: string; old_value: string | null; created_at: string }>((f, t) => sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, created_at").range(f, t)),
  ]);
  const by = <T extends { conversation_id: string }>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) { if (!m.has(r.conversation_id)) m.set(r.conversation_id, []); m.get(r.conversation_id)!.push(r); } return m; };
  const mBy = by(msgs), pBy = by(presses);
  const pcById = new Map(pcs.map((p) => [p.id, p])); const convPc = new Map(convs.map((c) => [c.id, c.property_customer_id]));
  const stateAt = (cid: string, at: string): HearingKnown | null => {
    const pc = pcById.get(convPc.get(cid) ?? ""); if (!pc || String(pc.created_at) > at) return null;
    const s: Record<string, unknown> = { ...pc };
    for (const h of hist.filter((h) => h.property_customer_id === pc.id && h.created_at > at).sort((a, b) => b.created_at.localeCompare(a.created_at))) s[h.changed_field] = h.changed_field.startsWith("rent") ? Number(h.old_value) || null : h.old_value;
    return s as HearingKnown;
  };
  const seen = new Set<string>();
  let total = 0, sentBefore = 0, ready = 0, flip = 0;
  const staff = new Map<string, number>(); const ex: string[] = [];
  for (const d of decs) {
    if (isTestConversation(d.conversation_id) || !d.analyzed_msg_ts || (d.decision_source ?? "").startsWith("promise")) continue;
    const key = `${d.conversation_id}|${d.analyzed_msg_ts}`; if (seen.has(key)) continue; seen.add(key);
    total++;
    const ms = mBy.get(d.conversation_id) ?? []; const ps = pBy.get(d.conversation_id) ?? [];
    const before = ms.filter((m) => m.created_at <= d.created_at);
    const sent = ps.some((p) => p.created_at <= d.created_at && (p.aix_type === "property_send" || p.aix_type === "property_recommendation"))
      || before.some((m) => m.sender !== "customer" && /🌟|[0-9０-９]{2,4}号室|ご査収/.test(m.text ?? ""));
    if (sent) { sentBefore++; continue; }
    const rd = pickupConditionsReady(stateAt(d.conversation_id, d.created_at), before.filter((m) => m.sender === "customer").map((m) => m.text ?? ""));
    if (rd.ready) { ready++; continue; }
    flip++;
    const w = staffWindowOf({ customerTurnAt: d.analyzed_msg_ts, msgs: ms, presses: ps });
    const bp = w.presses.filter((p) => p.burst).map((p) => p.aix_type);
    const bt = w.texts.filter((t) => t.burst).map((t) => t.text).join(" / ");
    const k = bp.includes("condition_hearing") || HEAR_FORM_RE.test(bt) ? "条件ヒアリング（AIX/フォーム）"
      : bp.some((a) => a === "property_send" || a === "property_recommendation") ? "物件を送った"
      : bp.length ? `他のAIX(${bp.join("+")})` : bt ? "手打ち" : "何もしない/未";
    staff.set(k, (staff.get(k) ?? 0) + 1);
    if (SHOW && ex.length < 40) {
      const cust = ms.filter((m) => m.sender === "customer" && m.created_at >= d.analyzed_msg_ts!).slice(0, 2).map((m) => m.text ?? "").join(" ").replace(/\n/g, " ").slice(0, 80);
      ex.push(`${d.conversation_id.slice(0, 8)} ${d.created_at.slice(0, 10)} 足りない=${rd.missing.join("+")}(${rd.source})｜${k}｜C:${cust}｜S:${bt.replace(/\n/g, " ").slice(0, 80)}`);
    }
  }
  console.log(`ブレインの property_send（約束の宣言を除く）${total}番: 既に物件を送った後 ${sentBefore}・条件そろった ${ready}・**ヒアリングに変わる ${flip}**`);
  for (const [k, v] of [...staff].sort((a, b) => b[1] - a[1])) console.log(`  スタッフ: ${k} ${v}`);
  for (const e of ex) console.log("   ", e);
}
main().catch((e) => { console.error(e); process.exit(1); });
