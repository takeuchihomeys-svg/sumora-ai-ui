// scripts/audit-pickup-promise-timing.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-pickup-promise-timing.ts      （DAYS=180 既定・読み取りのみ・何も書かない）
//       DUMP=<型> …… その型の約束を1件ずつ（約束の文・次に送るまでの時間・次の送付の形）
//       GROUP=1   …… 型（today／date／new_arrival／after_customer／when_period）でまとめる（既定は 型/理由）
//
// 2026-10-01 竹内「『引き続き新着で…お送り』という約束は『新着が出たら送る』約束として扱う形、これはLINEみていてもそうなっている。
//   このように法則性見つけたらもっと質よくなる」
//   スタッフの物件ピックアップの約束（送信時の記録と同じ classifyStaffTextFacts の pickup_declared）を、その後に実際に起きた事で分ける:
//     ・次に物件を送ったのはいつか（AIX 物件ピックアップ／物件オススメ・手打ちの物件送付）
//     ・同じ日（JST）のうちか・3日以内か・14日以内か
//     ・その送付の前にお客様が何か言ったか（お客様の依頼に答えた送付か、こちらから送った送付か）
//     ・次の送付が「新着」の1件（物件オススメ・本文に新着）か
import { createClient } from "@supabase/supabase-js";
import { classifyStaffTextFacts } from "../app/lib/action-ledger";
import { isTestConversation } from "../app/lib/test-conversations";
import { classifyPickupPromiseTiming } from "../app/lib/promise-timing";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 180);
const DUMP = process.env.DUMP ?? "";
const GROUP = process.env.GROUP === "1";
const SINCE = new Date(Date.now() - DAYS * 86400_000).toISOString();
const PICKUP_AIX = new Set(["property_send", "property_recommendation"]);

type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
type Aix = { conversation_id: string; aix_type: string; created_at: string; sent_at: string | null };

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 400; p++) { const { data, error } = await q(p * 1000, p * 1000 + 999); if (error) throw new Error(error.message); const r = data ?? []; out.push(...r); if (r.length < 1000) break; }
  return out;
}
const jstDay = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const jst = (iso: string) => { const d = new Date(Date.parse(iso) + 9 * 3600_000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
const median = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const pct = (a: number, b: number) => (b ? `${Math.round(100 * a / b)}%` : "-");

async function main() {
  const staff = (await pageAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").neq("sender", "customer").gte("created_at", SINCE).order("created_at").range(f, t)))
    .filter((m) => !isTestConversation(m.conversation_id));
  const promises: Array<{ m: Msg; sentence: string; watch: boolean }> = [];
  for (const m of staff) {
    if (m.is_aix_generated) continue;   // 手で書いた約束だけ（AIX の定型の締めは別に数えない）
    for (const e of classifyStaffTextFacts(m.text ?? "", m.created_at)) {
      if (e.kind === "pickup_declared" && e.status === "promised") promises.push({ m, sentence: (e.detail?.sentence ?? e.evidence ?? "").trim(), watch: !!e.detail?.watch });
    }
  }
  const convIds = [...new Set(promises.map((p) => p.m.conversation_id))];
  const msgs: Msg[] = [], aix: Aix[] = [];
  for (let i = 0; i < convIds.length; i += 80) {
    const ids = convIds.slice(i, i + 80);
    msgs.push(...await pageAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").in("conversation_id", ids).gte("created_at", SINCE).order("created_at").range(f, t)));
    aix.push(...await pageAll<Aix>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at, sent_at").in("conversation_id", ids).gte("created_at", SINCE).order("created_at").range(f, t)));
  }
  const by = <T extends { conversation_id: string }>(rows: T[]) => { const mm = new Map<string, T[]>(); for (const r of rows) (mm.get(r.conversation_id) ?? mm.set(r.conversation_id, []).get(r.conversation_id)!).push(r); return mm; };
  const msgBy = by(msgs), aixBy = by(aix);
  const aixAt = (a: Aix) => Date.parse(a.sent_at ?? a.created_at);

  type Row = { cls: string; sentence: string; at: string; conv: string; nextH: number | null; sameDay: boolean; custBefore: boolean; nextKind: string; newArrival: boolean; burst: boolean };
  const rows: Row[] = [];
  for (const p of promises) {
    const t0 = Date.parse(p.m.created_at);
    const cid = p.m.conversation_id;
    // 次の物件送付: AIX（物件ピックアップ・物件オススメ）か、手打ちの物件送付（台帳の properties_sent）
    const BURST = 15 * 60_000;
    // 約束の文が物件送付の締め（同じ送付の前後15分）か: 「引き続き…お探しさせて頂きます」で送付を締めた通
    const burst = (aixBy.get(cid) ?? []).some((a) => PICKUP_AIX.has(a.aix_type) && Math.abs(aixAt(a) - t0) <= BURST)
      || (msgBy.get(cid) ?? []).some((m) => m.sender !== "customer" && !(m.created_at === p.m.created_at && m.text === p.m.text) && Math.abs(Date.parse(m.created_at) - t0) <= BURST && classifyStaffTextFacts(m.text ?? "", m.created_at).some((e) => e.kind === "properties_sent"));
    const aNext = (aixBy.get(cid) ?? []).filter((a) => PICKUP_AIX.has(a.aix_type) && aixAt(a) > t0 + BURST).sort((a, b) => aixAt(a) - aixAt(b))[0];
    const sNext = (msgBy.get(cid) ?? []).find((m) => m.sender !== "customer" && Date.parse(m.created_at) > t0 + BURST
      && classifyStaffTextFacts(m.text ?? "", m.created_at).some((e) => e.kind === "properties_sent"));
    const cand: Array<{ ms: number; kind: string; text: string }> = [];
    if (aNext) cand.push({ ms: aixAt(aNext), kind: `AIX:${aNext.aix_type}`, text: "" });
    if (sNext) cand.push({ ms: Date.parse(sNext.created_at), kind: sNext.is_aix_generated ? "AIX本文" : "手打ち", text: sNext.text ?? "" });
    cand.sort((a, b) => a.ms - b.ms);
    const nx = cand[0] && cand[0].ms - t0 < 30 * 86400_000 ? cand[0] : null;
    const custBefore = !!nx && (msgBy.get(cid) ?? []).some((m) => m.sender === "customer" && Date.parse(m.created_at) > t0 && Date.parse(m.created_at) < nx.ms);
    // 新着の送付か: 物件オススメ（1件）か、送付の近くの本文に「新着」
    const near = nx ? (msgBy.get(cid) ?? []).filter((m) => m.sender !== "customer" && Math.abs(Date.parse(m.created_at) - nx.ms) < 10 * 60_000).map((m) => m.text ?? "").join("\n") : "";
    const newArrival = !!nx && (nx.kind === "AIX:property_recommendation" || /新着/.test(near));
    const ct = classifyPickupPromiseTiming(p.sentence); const cls = GROUP ? ct.timing : `${ct.timing}/${ct.reason}`;
    rows.push({ cls, sentence: p.sentence, at: p.m.created_at, conv: cid, nextH: nx ? (nx.ms - t0) / 3600_000 : null, sameDay: !!nx && jstDay(nx.ms) === jstDay(t0), custBefore, nextKind: nx?.kind ?? "(30日送付なし)", newArrival, burst });
  }

  console.log(`\n== 物件ピックアップの約束（手打ち・${DAYS}日・テスト会話除く） ${rows.length}件 ==`);
  console.log("型 | 件数 | 同じ日に送付 | 3日以内 | 14日以内 | 送付なし30日 | 中央値(時間) | 送付の前にお客様の発言 | 次の送付が新着 | 同じ日・お客様より先に送付 | 送付の締め（前後15分に送付）");
  const classes = [...new Set(rows.map((r) => r.cls))];
  for (const c of classes) {
    const rs = rows.filter((r) => r.cls === c);
    const sent = rs.filter((r) => r.nextH !== null);
    console.log(`${c} | ${rs.length} | ${pct(rs.filter((r) => r.sameDay).length, rs.length)} | ${pct(sent.filter((r) => r.nextH! <= 72).length, rs.length)} | ${pct(sent.filter((r) => r.nextH! <= 336).length, rs.length)} | ${pct(rs.length - sent.length, rs.length)} | ${median(sent.map((r) => r.nextH!)).toFixed(1)} | ${pct(sent.filter((r) => r.custBefore).length, sent.length)} | ${pct(sent.filter((r) => r.newArrival).length, sent.length)} | ${pct(rs.filter((r) => r.sameDay && !r.custBefore).length, rs.length)} | ${pct(rs.filter((r) => r.burst).length, rs.length)}`);
  }
  if (DUMP) {
    for (const r of rows.filter((x) => DUMP === "all" || x.cls === DUMP)) {
      console.log(`  [${r.cls}] ${jst(r.at)} ${r.conv.slice(0, 8)} → ${r.nextH === null ? "送付なし" : `${r.nextH.toFixed(1)}h ${r.sameDay ? "同日" : ""} ${r.nextKind}${r.custBefore ? "・お客様が先" : ""}${r.newArrival ? "・新着" : ""}`}${r.burst ? "［締め］" : ""}｜${r.sentence.replace(/\n/g, " ").slice(0, 90)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
