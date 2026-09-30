// scripts/audit-viewing-cancel-calendar.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-viewing-cancel-calendar.ts     （DAYS=180 既定・読み取りのみ・何も消さない）
//
// 2026-09-30 竹内: お客様が決まった内覧を取りやめた時、カレンダーの決まった内覧の予定を自動で消す（app/lib/viewing-cancel-calendar.ts）。
// 過去の会話のお客様の連投の終わりごとに本番と同じ判定（decideViewingCancelFromLedgerInput）を当て、
//   A. 取りやめと読んだ回を全部並べる（発言の実物・決まっていた日・その時点のカレンダーで消す対象がどれに決まるか）
//   B. 参考: 確定の後に「キャンセル・中止・延期・行けなく」の語があるのに取りやめと読まなかった回（変更の扱い等）も並べる
// 件数だけでなく実物を読む。カレンダーは今の行しか無い（過去に人が消した予定は見えない）ので、対象の決まり方は「今残っている行」で見る
import { createClient } from "@supabase/supabase-js";
import type { LedgerAixRow, LedgerMessage } from "../app/lib/action-ledger";
import { decideViewingCancelFromLedgerInput, pickViewingEventsToCancel, currentCustomerTurnStart, type CalEventRow } from "../app/lib/viewing-cancel-calendar";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 180);

type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string };
type Aix = LedgerAixRow & { conversation_id: string; created_at: string; sent_at: string | null };
async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 300; p++) { const { data, error } = await q(p * 1000, p * 1000 + 999); if (error) throw new Error(error.message); const r = data ?? []; out.push(...r); if (r.length < 1000) break; }
  return out;
}
const one = (s: string | null | undefined, n = 160) => (s ?? "").replace(/\n+/g, " / ").slice(0, n);
const jst = (iso: string) => { const d = new Date(Date.parse(iso) + 9 * 3600_000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const convs = await pageAll<{ id: string; line_source_type: string | null }>((a, b) => sb.from("conversations").select("id, line_source_type").range(a, b));
  const ok = new Set(convs.filter((c) => c.line_source_type !== "group").map((c) => c.id));
  const aixAll = await pageAll<Aix>((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at, sent_at, generated_text, check_pattern, property_names, estimate_sent, template_name, line_message_id, prop_statuses").gte("created_at", since).order("created_at", { ascending: true }).range(a, b));
  const msgs = await pageAll<Msg>((a, b) => sb.from("messages").select("conversation_id, sender, text, created_at").gte("created_at", since).order("created_at", { ascending: true }).range(a, b));
  const evs = await pageAll<CalEventRow & { created_at?: string }>((a, b) => sb.from("calendar_events").select("id, conversation_id, event_type, title, start_at, end_at, all_day, notes, is_done, created_at").eq("event_type", "viewing").range(a, b));
  const byConv = new Map<string, Msg[]>(); for (const m of msgs) if (ok.has(m.conversation_id)) (byConv.get(m.conversation_id) ?? byConv.set(m.conversation_id, []).get(m.conversation_id)!).push(m);
  const aixByConv = new Map<string, Aix[]>(); for (const r of aixAll) (aixByConv.get(r.conversation_id) ?? aixByConv.set(r.conversation_id, []).get(r.conversation_id)!).push(r);

  let turns = 0, hits = 0, picked = 0, near = 0;
  const pickWhy: Record<string, number> = {};
  const nearLines: string[] = [];
  console.log(`=== 確定の後のお客様の取りやめ（直近${DAYS}日・お客様の連投の終わりごとに本番と同じ判定）===\n`);
  for (const [cid, ms] of byConv) {
    const ax = aixByConv.get(cid) ?? [];
    for (let i = 0; i < ms.length; i++) {
      if (ms[i].sender !== "customer" || (i + 1 < ms.length && ms[i + 1].sender === "customer")) continue;   // 連投の終わりだけ
      turns++;
      const tMs = Date.parse(ms[i].created_at) + 1000;
      const hist: LedgerMessage[] = ms.slice(Math.max(0, i - 59), i + 1).map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.created_at }));
      const turnText = hist.slice(currentCustomerTurnStart(hist)).map((m) => m.text).join("\n");
      if (!/キャンセル|中止|延期|行けなく|やめ|見送/.test(turnText)) continue;   // 速さのため: 取りやめの語が無い連投は判定が立たない（CANCEL_RE の語）
      const rows = ax.filter((r) => Date.parse(r.sent_at ?? r.created_at) < tMs);
      const d = decideViewingCancelFromLedgerInput({ messages: hist, recentAixRows: rows, lineTasks: [] }, tMs);
      if (!d.cancel) {
        if (d.why === "not_cancel" || d.why === "not_confirmed_before") { near++; nearLines.push(`  ${jst(ms[i].created_at)} ${cid.slice(0, 8)} [${d.why}] ${one(turnText, 130)}`); }
        continue;
      }
      hits++;
      // その時点のカレンダー（今残っている行のうち、その時点より前に作られた物）で消す対象を選ぶ
      const at = evs.filter((e) => e.conversation_id === cid && (!e.created_at || Date.parse(e.created_at) < tMs)).map((e) => ({ ...e, is_done: false }));
      const p = pickViewingEventsToCancel({ events: at, conversationId: cid, day: d.day, time: d.time, nowMs: tMs });
      pickWhy[p.why] = (pickWhy[p.why] ?? 0) + 1; if (p.deleteIds.length > 0) picked++;
      const next = ms.slice(i + 1, i + 3).map((m) => `${m.sender === "customer" ? "客" : "ス"}: ${one(m.text, 90)}`).join(" ／ ");
      console.log(`■ ${jst(ms[i].created_at)} ${cid.slice(0, 8)} 決まっていた内覧=${d.day ?? "?"} ${d.time ?? ""}`);
      console.log(`   発言: ${one(d.triggerText, 200)}`);
      console.log(`   消す対象: ${p.why} ${p.deleteIds.length ? p.deleteIds.map((id) => { const e = at.find((x) => x.id === id)!; return `#${id} ${jst(e.start_at)} ${one(e.notes, 60)}`; }).join(" | ") : `（その会話の内覧の予定 ${at.length} 件・候補 ${p.candidates.length} 件）`}`);
      console.log(`   その後: ${next || "（なし）"}\n`);
    }
  }
  console.log(`--- B. 取りやめの語はあるが取りやめと読まなかった回（${near}）---`);
  for (const l of nearLines.slice(0, 80)) console.log(l);
  console.log(`\nお客様の連投 ${turns}・取りやめと読んだ ${hits}・消す対象が1件に決まった ${picked}・内訳 ${JSON.stringify(pickWhy)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
