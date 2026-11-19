// scripts/audit-aix-record-gaps.ts — AIX の記録の土台と細分化の数え（読むだけ・LLM なし・営業時間（JST 9〜22時）は DB を読まない）
//   2026-11-13 作業員1（統括役の頼み・竹内さん「記録、AIX の種類なども、土台を作って、細かい部分は細分化して強化する」「AIX ボタンは竹内基準で」）
//   ① 見張りの番（直近 --days 日）の staff_aix が空の理由: none（AIX 無し）／next_turn（次のお客様の発言の後に押した）／unknown（窓が開いている）／
//      記録が無いのに AIX の文が送られた番（記録の穴）。next_turn の AIX を 種類×下の種類 で数える
//   ② 送った AIX（直近 --mismatch-days 日・sent_at あり）でブレインの勧めと違う物を5つに分ける（押した人ごと・物差しは竹内さんの分だけ）:
//      (1) 同じまとまりの2通目以降 (2) 勧めは none（返信）で、竹内さんは返信→AIX の組 (3) 似た種類の取り違え (4) ブレインの読み違い (5) 勧めが記録されていない
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-record-gaps.ts [--days=14] [--mismatch-days=30] [--env2=<鍵のある .env.local>]
import { createClient } from "@supabase/supabase-js";
import { pickerSub } from "../app/lib/aix-record";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
{ const e2 = arg("env2", ""); if (e2 && !process.env.SUPABASE_SERVICE_ROLE_KEY) process.loadEnvFile(e2); }
const DAYS = Number(arg("days", "14")), MDAYS = Number(arg("mismatch-days", "30"));
const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hour12: false }).format(new Date()));
if (h >= 9 && h < 22 && !process.argv.includes("--force")) { console.log(`営業時間（JST ${h}時）は DB を読まない（22時以降に）`); process.exit(0); }
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const P = (s: string) => Date.parse(s);
async function pages<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += 1000) { const { data, error } = await q(f, f + 999); if (error) throw new Error(error.message); const d = (data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}
type Log = { conversation_id: string; aix_type: string | null; check_pattern: string | null; created_at: string; sent_at: string | null; picker_choices: Record<string, unknown> | null; suggested_action: string | null; line_message_id: string | null };
type Msg = { conversation_id: string; sender: string; created_at: string; is_aix_generated: boolean | null; line_message_id: string | null; staff_writer: string | null };
(async () => {
  const since = new Date(Date.now() - Math.max(DAYS, MDAYS) * 86_400_000).toISOString();
  const turns = await pages<{ id: number; conversation_id: string; customer_last_at: string; staff_aix: unknown[] | null; verdict: string | null }>((f, t) =>
    sb.from("line_watch_turns").select("id, conversation_id, customer_last_at, staff_aix, verdict").gte("customer_turn_at", new Date(Date.now() - DAYS * 86_400_000).toISOString()).order("id").range(f, t));
  const convs = [...new Set(turns.map((x) => x.conversation_id))];
  const logs: Log[] = [], msgs: Msg[] = [];
  const mLogs = await pages<Log>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at, sent_at, picker_choices, suggested_action, line_message_id").gte("created_at", since).not("aix_type", "is", null).order("created_at").range(f, t));
  logs.push(...mLogs);
  const allConvs = [...new Set([...convs, ...mLogs.map((l) => l.conversation_id)])];
  for (let i = 0; i < allConvs.length; i += 100) {
    msgs.push(...await pages<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, is_aix_generated, line_message_id, staff_writer").in("conversation_id", allConvs.slice(i, i + 100)).gte("created_at", since).order("created_at").range(f, t)));
  }
  const byConv = <T extends { conversation_id: string }>(xs: T[]) => { const m = new Map<string, T[]>(); for (const x of xs) { const a = m.get(x.conversation_id) ?? []; a.push(x); m.set(x.conversation_id, a); } return m; };
  const L = byConv(logs), M = byConv(msgs);
  const writerOf = new Map(msgs.filter((m) => m.line_message_id).map((m) => [m.line_message_id!, m.staff_writer ?? null]));

  // ① staff_aix が空の理由
  const st = { pressed: 0, none: 0, next_turn: 0, unknown: 0, aix_text_no_log: 0 };
  const nextTypes = new Map<string, number>();
  for (const w of turns) {
    if (!w.verdict || w.verdict === "na") continue;
    if ((w.staff_aix ?? []).length) { st.pressed++; continue; }
    const last = P(w.customer_last_at);
    const nextCust = (M.get(w.conversation_id) ?? []).find((m) => m.sender === "customer" && P(m.created_at) > last)?.created_at;
    const end = Math.min(nextCust ? P(nextCust) : Infinity, last + 86_400_000);
    if (!nextCust && Date.now() < last + 86_400_000) { st.unknown++; continue; }
    const aixText = (M.get(w.conversation_id) ?? []).some((m) => m.is_aix_generated && P(m.created_at) > last && P(m.created_at) < end);
    if (aixText) { st.aix_text_no_log++; continue; }
    const later = (L.get(w.conversation_id) ?? []).filter((l) => P(l.created_at) >= end && P(l.created_at) < last + 86_400_000);
    if (later.length) { st.next_turn++; for (const l of later.slice(0, 1)) { const k = `${l.aix_type}｜${l.check_pattern ?? pickerSub(l.picker_choices) ?? "-"}`; nextTypes.set(k, (nextTypes.get(k) ?? 0) + 1); } }
    else st.none++;
  }
  console.log(`■ ① 見張りの番（直近 ${DAYS} 日・na を除く）の staff_aix: 押した ${st.pressed}・AIX 無し ${st.none}・次の番の一手 ${st.next_turn}・窓が開いている ${st.unknown}・AIX の文があるのに記録が無い ${st.aix_text_no_log}`);
  console.log("  次の番の一手の AIX（種類｜下の種類）:");
  for (const [k, n] of [...nextTypes].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`    ${k}: ${n}`);

  // ② 勧めと違う AIX の5つの分け（押した人ごと）
  const SIMILAR = [["property_send", "property_recommendation"], ["property_check_result", "acknowledge_check"], ["viewing_invite", "meeting_place"], ["estimate_sheet", "cost_breakdown"]];
  const similar = (a: string, b: string) => SIMILAR.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
  const mStart = Date.now() - MDAYS * 86_400_000;
  const tab = new Map<string, Map<string, number>>(); // by → cat → n
  const top4 = new Map<string, number>();
  let sent = 0, diff = 0;
  for (const [cid, ls] of L) {
    const sentLogs = ls.filter((l) => l.sent_at && P(l.created_at) >= mStart).sort((a, b) => P(a.created_at) - P(b.created_at));
    for (let i = 0; i < sentLogs.length; i++) {
      const l = sentLogs[i]; sent++;
      const s = String(l.suggested_action ?? "");
      if (s && s === l.aix_type) continue;
      diff++;
      const prev = sentLogs[i - 1];
      let cat: string;
      if (!l.suggested_action) cat = "(5) 勧めが記録されていない";
      else if (prev && P(l.created_at) - P(prev.created_at) <= 10 * 60_000) cat = "(1) 同じまとまりの2通目以降";
      else if (s === "none" && (M.get(cid) ?? []).some((m) => m.sender !== "customer" && !m.is_aix_generated && P(m.created_at) < P(l.created_at) && P(l.created_at) - P(m.created_at) <= 30 * 60_000)) cat = "(2) 勧めは返信・返信→AIX の組";
      else if (similar(s, String(l.aix_type))) cat = "(3) 似た種類の取り違え";
      else { cat = "(4) ブレインの読み違い"; }
      const by = (l.line_message_id && writerOf.get(l.line_message_id)) || "unknown";
      const byKey = by === "takeuchi" || by === "employee" ? by : "unknown";
      const m = tab.get(byKey) ?? new Map<string, number>(); m.set(cat, (m.get(cat) ?? 0) + 1); tab.set(byKey, m);
      if (cat.startsWith("(4)") && byKey === "takeuchi") { const k = `勧め ${s} → 押した ${l.aix_type}｜${l.check_pattern ?? pickerSub(l.picker_choices) ?? "-"}`; top4.set(k, (top4.get(k) ?? 0) + 1); }
    }
  }
  console.log(`\n■ ② 送った AIX（直近 ${MDAYS} 日）${sent}件のうち、勧めと違う ${diff}件（押した人ごと・物差しは竹内さんの分だけ）`);
  console.log("| 分け | 竹内さん | 従業員（参考） | 押した人が分からない |");
  console.log("|---|---|---|---|");
  for (const c of ["(1) 同じまとまりの2通目以降", "(2) 勧めは返信・返信→AIX の組", "(3) 似た種類の取り違え", "(4) ブレインの読み違い", "(5) 勧めが記録されていない"])
    console.log(`| ${c} | ${tab.get("takeuchi")?.get(c) ?? 0} | ${tab.get("employee")?.get(c) ?? 0} | ${tab.get("unknown")?.get(c) ?? 0} |`);
  console.log("\n  (4) の上位の型（竹内さんの分だけ）:");
  for (const [k, n] of [...top4].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`    ${k}: ${n}`);
})().catch((e) => { console.error(e); process.exit(1); });
