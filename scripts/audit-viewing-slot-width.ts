// scripts/audit-viewing-slot-width.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-viewing-slot-width.ts     （DAYS=180 既定・読み取りのみ）
//       DUMP=1 …… 11:00 より前／18:30 より後／3時間超の枠の実物を並べる
//
// 2026-09-30 竹内さん「内覧は1件なら1〜2時間の枠・始まり11:00〜終了18:30」
// スタッフが実際に送った内覧の候補の枠（「10/2(金) 13:00〜16:00」）の長さ・開始・終了の分布を数える。
//   対象: スタッフの実送信のうち、日付＋時刻の範囲の行があり、案内の語（ご案内可能・ご案内出来・ご都合）がある文
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 180);
const DUMP = process.env.DUMP === "1";
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

type Msg = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string };
type Aix = { conversation_id: string; aix_type: string; created_at: string; sent_at: string | null };

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 300; p++) { const { data, error } = await q(p * 1000, p * 1000 + 999); if (error) throw new Error(error.message); const r = data ?? []; out.push(...r); if (r.length < 1000) break; }
  return out;
}
const toHalf = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/：/g, ":").replace(/[～~]/g, "〜");
const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
function hist(label: string, vals: number[], fmt: (n: number) => string) {
  const m = new Map<number, number>(); for (const v of vals) m.set(v, (m.get(v) ?? 0) + 1);
  console.log(`\n--- ${label}（${vals.length}）---`);
  for (const [k, n] of [...m.entries()].sort((a, b) => a[0] - b[0])) console.log(`  ${fmt(k).padStart(6)}  ${String(n).padStart(4)}  ${pct(n, vals.length)}`);
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const convs = await pageAll<{ id: string; line_source_type: string | null }>((a, b) => sb.from("conversations").select("id, line_source_type").range(a, b));
  const ok = new Set(convs.filter((c) => c.id !== YUMA && c.line_source_type !== "group").map((c) => c.id));
  const msgs = (await pageAll<Msg>((a, b) => sb.from("messages").select("id, conversation_id, sender, text, created_at").eq("sender", "staff").gte("created_at", since).order("created_at", { ascending: true }).range(a, b))).filter((m) => ok.has(m.conversation_id));
  const aix = (await pageAll<Aix>((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at, sent_at").eq("aix_type", "viewing_invite").gte("created_at", since).range(a, b))).filter((r) => ok.has(r.conversation_id));
  const isAix = (m: Msg) => aix.some((r) => r.conversation_id === m.conversation_id && Math.abs(Date.parse(r.sent_at ?? r.created_at) - Date.parse(m.created_at)) < 5 * 60_000);

  type Slot = { start: number; end: number; line: string; msg: Msg; perMsg: number; aix: boolean };
  const slots: Slot[] = []; let nMsg = 0; let nAixMsg = 0;
  for (const m of msgs) {
    const t = toHalf(m.text ?? "");
    if (!/ご案内(?:可能|出来|でき)|ご都合/.test(t)) continue;
    const found: Array<{ start: number; end: number; line: string }> = [];
    for (const line of t.split("\n")) {
      if (!/(\d{1,2})\s*[\/月]\s*(\d{1,2})|本日|明日|明後日/.test(line)) continue;
      for (const r of line.matchAll(/(\d{1,2}):(\d{2})\s*〜\s*(\d{1,2}):(\d{2})/g)) {
        const s = Number(r[1]) * 60 + Number(r[2]); const e = Number(r[3]) * 60 + Number(r[4]);
        if (e > s && s >= 6 * 60 && e <= 23 * 60) found.push({ start: s, end: e, line: line.trim() });
      }
    }
    if (found.length === 0) continue;
    nMsg++; const a = isAix(m); if (a) nAixMsg++;
    for (const f of found) slots.push({ ...f, msg: m, perMsg: found.length, aix: a });
  }
  console.log(`=== 内覧の候補の枠（直近${DAYS}日・スタッフの実送信）===`);
  console.log(`候補の枠のある文 ${nMsg} 通（うち AIX【内覧調整】の前後5分 ${nAixMsg} 通）・枠 ${slots.length} 個`);
  const n = slots.length;
  hist("枠の長さ（30分刻みに丸め）", slots.map((s) => Math.round((s.end - s.start) / 30) * 30), (k) => `${k / 60}h`);
  hist("開始時刻（時）", slots.map((s) => Math.floor(s.start / 60)), (k) => `${k}時台`);
  hist("終了時刻（時）", slots.map((s) => Math.floor((s.end - 1) / 60)), (k) => `〜${k + 1}時`);
  hist("1通あたりの枠の数", [...new Map(slots.map((s) => [s.msg.id, s.perMsg])).values()], (k) => `${k}個`);
  const w = (f: (s: Slot) => boolean) => slots.filter(f);
  const len = (s: Slot) => s.end - s.start;
  console.log(`\n--- 線 ---`);
  console.log(`長さ 1時間以下 ${w((s) => len(s) <= 60).length}（${pct(w((s) => len(s) <= 60).length, n)}）／1時間超〜2時間 ${w((s) => len(s) > 60 && len(s) <= 120).length}（${pct(w((s) => len(s) > 60 && len(s) <= 120).length, n)}）／2時間超〜3時間 ${w((s) => len(s) > 120 && len(s) <= 180).length}（${pct(w((s) => len(s) > 120 && len(s) <= 180).length, n)}）／3時間超 ${w((s) => len(s) > 180).length}（${pct(w((s) => len(s) > 180).length, n)}）`);
  console.log(`開始が 11:00 より前 ${w((s) => s.start < 660).length}（${pct(w((s) => s.start < 660).length, n)}）／終了が 18:30 より後 ${w((s) => s.end > 1110).length}（${pct(w((s) => s.end > 1110).length, n)}）`);
  const byMonth = new Map<string, Slot[]>(); for (const s of slots) { const k = s.msg.created_at.slice(0, 7); (byMonth.get(k) ?? byMonth.set(k, []).get(k)!).push(s); }
  console.log(`\n--- 月ごと（枠の数・長さの中央値・2時間以下の割合・11:00前・18:30後）---`);
  for (const [k, v] of [...byMonth.entries()].sort()) { const ls = v.map(len).sort((a, b) => a - b); console.log(`  ${k}  ${String(v.length).padStart(4)}  中央 ${ls[Math.floor(ls.length / 2)] / 60}h  2h以下 ${pct(v.filter((s) => len(s) <= 120).length, v.length)}  11前 ${v.filter((s) => s.start < 660).length}  18:30後 ${v.filter((s) => s.end > 1110).length}`); }
  if (DUMP) {
    const show = (title: string, list: Slot[]) => { console.log(`\n### ${title}（${list.length}）`); for (const s of list.slice(0, 40)) console.log(`  ${s.msg.created_at.slice(0, 10)} ${s.msg.conversation_id.slice(0, 8)} ${s.aix ? "AIX" : "手 "} ${hm(s.start)}〜${hm(s.end)} | ${s.line.slice(0, 70)}`); };
    show("11:00 より前に始まる枠", w((s) => s.start < 660));
    show("18:30 より後に終わる枠", w((s) => s.end > 1110));
    show("3時間超の枠", w((s) => len(s) > 180));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
