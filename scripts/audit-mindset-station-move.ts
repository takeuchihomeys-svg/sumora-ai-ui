// scripts/audit-mindset-station-move.ts — 台帳 #795 ①: 今の気持ち（12状態）× 地図の駅 → 竹内さん本人の次の一手 の表（読むだけ・LLM なし・申込以降は読まない）
// 2026-11-26 作業員L（竹内さん 11/26「地図のなかで相手を読む部分…」「ここ細分化して連携できるように・必要な土台はつくっておく形で」・統括役の割り振り）
//   mindset-move-table（状態×一手→反応・180日）に駅の軸を足す。行の形は作業員A の次の石（app/lib/route-next-stone）に重ねる { station, state, stone:{to,reply,aix}, n, share }。
//   番＝ブレインの判断の記録（60日）のうち、気持ち（digest.ms）があり、その後 24時間の内に竹内さん本人（messages.staff_writer=takeuchi）が送った番。
//   駅＝判断の記録の駅（digest.ar）が無い番は、案件の段の時刻（deal_outcomes）から決まった計算で当てる（物件送りの前＝問い合わせ・後＝提案中・見積の後＝見積・内覧の日時の後＝内覧予定・内覧の後＝内覧後）。
//   一手＝竹内さんの最初の通（AIX は種類・返信は draftKindOf の形）。--write で app/lib/mindset-station-move-data.ts を書く（数だけ・文は書かない）。広い読み＝22時以降
// 実行: npx tsx --env-file=.env.local scripts/audit-mindset-station-move.ts [--days=60] [--min=5] [--write]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { draftKindOf } from "../app/lib/customer-reaction-predict";
import { isTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const POST = new Set(["applying", "application", "screening", "approved", "contract", "closed_won"]);
/** 案件の段の時刻から駅を当てる（決まった計算） */
export function stationAt(t: number, d: { property_sent_at?: string | null; estimate_at?: string | null; viewing_at?: string | null; viewing_held_at?: string | null; applied_at?: string | null } | null): string {
  const le = (x?: string | null) => !!x && Date.parse(x) <= t;
  if (!d) return "inquiry";
  if (le(d.applied_at)) return "applying";
  if (le(d.viewing_held_at)) return "viewed";
  if (le(d.viewing_at)) return "viewing_scheduled";
  if (le(d.estimate_at)) return "estimate";
  if (le(d.property_sent_at)) return "proposing";
  return "inquiry";
}
export type StationMoveCell = { station: string; state: string; stone: { to: string[]; reply: string[]; aix: string[] }; move: string; n: number; share: number };
/** 駅×気持ちごとに一手を数え、多い順に（純関数） */
export function cellsOf(rows: ReadonlyArray<{ station: string; state: string; move: string }>, min = 5): StationMoveCell[] {
  const by = new Map<string, Map<string, number>>();
  for (const r of rows) { const k = `${r.station}|${r.state}`; const m = by.get(k) ?? new Map<string, number>(); m.set(r.move, (m.get(r.move) ?? 0) + 1); by.set(k, m); }
  const out: StationMoveCell[] = [];
  for (const [k, m] of by) {
    const tot = [...m.values()].reduce((a, b) => a + b, 0);
    if (tot < min) continue;
    const [station, state] = k.split("|");
    for (const [move, n] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
      const stone = move.startsWith("AIX:") ? { to: [], reply: [], aix: [move.slice(4).split("/")[0]] } : { to: [], reply: [move.replace(/^返信:/, "")], aix: [] };
      out.push({ station, state, stone, move, n, share: Math.round((n / tot) * 1000) / 10 });
    }
  }
  return out.sort((a, b) => a.station.localeCompare(b.station) || a.state.localeCompare(b.state) || b.n - a.n);
}

if (require.main === module) (async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const days = Number(arg("days", "60")), min = Number(arg("min", "5"));
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const decs: Array<{ conversation_id: string; analyzed_msg_ts: string | null; created_at: string; digest: Record<string, unknown> | null; conversation_status: string | null }> = [];
  for (let from = 0; from < 30000; from += 1000) {
    const { data, error } = await sb.from("brain_decision_logs").select("conversation_id, analyzed_msg_ts, created_at, digest, conversation_status").gte("created_at", since).neq("source", "test").order("created_at").range(from, from + 999);
    if (error) throw new Error(error.message);
    decs.push(...((data ?? []) as typeof decs));
    if ((data ?? []).length < 1000) break;
  }
  const deals = new Map<string, Array<Record<string, string | null>>>();
  const rows: Array<{ station: string; state: string; move: string }> = [];
  const seen = new Set<string>();
  for (const d of decs) {
    const st = String(d.digest?.ms ?? "").split("|")[0];
    if (!st || isTestConversation(d.conversation_id) || POST.has(String(d.conversation_status ?? ""))) continue;
    const t = Date.parse(d.analyzed_msg_ts ?? d.created_at);
    const key = `${d.conversation_id}|${d.analyzed_msg_ts ?? d.created_at}`; if (seen.has(key)) continue; seen.add(key);
    const { data: m } = await sb.from("messages").select("text, created_at, is_aix_generated, staff_writer").eq("conversation_id", d.conversation_id).eq("sender", "staff").gt("created_at", new Date(t).toISOString()).lt("created_at", new Date(t + 864e5).toISOString()).order("created_at").limit(1);
    const x = ((m ?? []) as Array<{ text: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null }>)[0];
    if (!x || x.staff_writer !== "takeuchi") continue;
    let move = `返信:${draftKindOf(x.text)}`;
    if (x.is_aix_generated) {
      const { data: a } = await sb.from("aix_usage_logs").select("aix_type, sent_at, created_at").eq("conversation_id", d.conversation_id).gte("created_at", new Date(Date.parse(x.created_at) - 180_000).toISOString()).lte("created_at", new Date(Date.parse(x.created_at) + 180_000).toISOString()).limit(1);
      move = `AIX:${((a ?? []) as Array<{ aix_type: string }>)[0]?.aix_type ?? "不明"}`;
    }
    const arNode = String(d.digest?.ar ?? "").split("|")[0];
    let station = arNode;
    if (!station) {
      if (!deals.has(d.conversation_id)) { const { data: dd } = await sb.from("deal_outcomes").select("first_contact_at, property_sent_at, viewing_at, viewing_held_at, applied_at, ended_at").eq("conversation_id", d.conversation_id).limit(20); deals.set(d.conversation_id, (dd ?? []) as Array<Record<string, string | null>>); }
      const eps = deals.get(d.conversation_id)!;
      const ep = eps.find((e) => (!e.first_contact_at || Date.parse(e.first_contact_at) <= t) && (!e.ended_at || Date.parse(e.ended_at) >= t)) ?? null;
      station = stationAt(t, ep as never);
    }
    if (station === "applying") continue;
    rows.push({ station, state: st, move });
    await new Promise((res) => setTimeout(res, 40));
  }
  const cells = cellsOf(rows, min);
  console.log(`# 気持ち×駅 → 竹内さん本人の次の一手（${days}日・番 ${rows.length}・${min}番以上のマス）\n`);
  console.log("| 駅 | 気持ち | 竹内さんの一手 | 番 | 割合 |\n|---|---|---|---|---|");
  for (const c of cells) console.log(`| ${c.station} | ${c.state} | ${c.move} | ${c.n} | ${c.share}% |`);
  if (process.argv.includes("--write")) {
    const p = "app/lib/mindset-station-move-data.ts";
    writeFileSync(p, `// ${p} — scripts/audit-mindset-station-move.ts --write が書く（手で直さない・数だけ）\nimport type { StationMoveCell } from "./mindset-station-move";\nexport const MINDSET_STATION_MOVE_META = ${JSON.stringify({ days, builtAt: new Date().toISOString().slice(0, 10), turns: rows.length, min })};\nexport const MINDSET_STATION_MOVE_DATA: StationMoveCell[] = ${JSON.stringify(cells)};\n`);
    console.log(`書いた: ${p}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
