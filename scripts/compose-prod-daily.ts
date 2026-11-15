// scripts/compose-prod-daily.ts — 文の当たりを本番で毎日数える（読むだけ・LLM なし・費用0・2026-11-15 作業員H・統括役の頼み②）
//   竹内さん本人の実送信（line_watch_turns.staff_texts・書き手は messages.staff_writer＝takeuchi・AIX でない返信）と、その番の下書き（draft_last）を、
//   文の要素ごと（頭・押さえ・信頼・潜在・つなぎ・締め・事実・2通目）に比べる（scripts/lib/compose-prod-elements.ts）。prod-yardstick と同じく前の窓と今の窓を並べる。
//   --write で cron_run_logs に1行（cron_name=compose-prod-daily・result_json に要素ごとの当たり）。DB は見張りの番と、その番の最初のスタッフの通だけを読む（軽い）。
//   営業時間（JST 9〜22時）は回さない（--force で手元の確かめだけ）
//   使い方: npx tsx --env-file=<.env.local> scripts/compose-prod-daily.ts [--days=7] [--write] [--force] [--show=10]
import { createClient } from "@supabase/supabase-js";
import { compareProdTurn, tallyProd, PROD_ELEMENTS, type ProdElResult } from "./lib/compose-prod-elements";
import { isTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Math.min(14, Math.max(1, Number(arg("days", "7")))), SHOW = Number(arg("show", "0"));
const jstHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hour12: false }).format(new Date()));
if (jstHour >= 9 && jstHour < 22 && !process.argv.includes("--force")) { console.log(`営業時間（JST ${jstHour}時）は回さない（22時以降に）`); process.exit(0); }
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");

type W = { id: number; conversation_id: string; customer_turn_at: string; draft_last: string | null; staff_texts: Array<{ at?: string; text?: string }> | null };
async function readWindow(fromIso: string, toIso: string): Promise<W[]> {
  const out: W[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, draft_last, staff_texts")
      .gte("customer_turn_at", fromIso).lt("customer_turn_at", toIso).not("draft_last", "is", null).order("customer_turn_at").range(i, i + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as W[])); if ((data ?? []).length < 1000) break;
  }
  return out.filter((w) => !isTestConversation(w.conversation_id) && Array.isArray(w.staff_texts) && w.staff_texts.some((s) => s.text));
}
/** その番の最初のスタッフの通の書き手（AIX でない時だけ） */
async function writerOf(w: W): Promise<string | null> {
  const first = (w.staff_texts ?? []).find((s) => s.at);
  if (!first?.at) return null;
  const t = Date.parse(first.at);
  const { data } = await sb.from("messages").select("staff_writer, is_aix_generated").eq("conversation_id", w.conversation_id).neq("sender", "customer")
    .gte("created_at", new Date(t - 2000).toISOString()).lte("created_at", new Date(t + 2000).toISOString()).limit(1);
  const m = ((data ?? []) as Array<{ staff_writer: string | null; is_aix_generated: boolean }>)[0];
  return m && !m.is_aix_generated ? m.staff_writer : null;
}
async function measure(fromIso: string, toIso: string) {
  const rows = await readWindow(fromIso, toIso);
  const results: Array<{ id: number; at: string; r: ProdElResult[] }> = [];
  for (const w of rows) {
    if ((await writerOf(w)) !== "takeuchi") continue;
    const texts = (w.staff_texts ?? []).map((s) => String(s.text ?? "")).filter(Boolean);
    results.push({ id: w.id, at: w.customer_turn_at, r: compareProdTurn(texts, String(w.draft_last ?? "")) });
  }
  return { turns: results.length, tally: tallyProd(results.map((x) => x.r)), results };
}
async function main() {
  const now = Date.now(), cut = new Date(now - DAYS * 86_400_000).toISOString(), since = new Date(now - 2 * DAYS * 86_400_000).toISOString(), nowIso = new Date(now).toISOString();
  const started = new Date().toISOString();
  const [before, after] = [await measure(since, cut), await measure(cut, nowIso)];
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
  console.log(`竹内さん本人の返信の番（下書きあり）: 前の${DAYS}日 ${before.turns}・今の${DAYS}日 ${after.turns}`);
  console.log("要素｜今（当たり/竹内さんの文にある番）｜前");
  for (const e of PROD_ELEMENTS) console.log(`${e}｜${after.tally[e].hit}/${after.tally[e].has}（${pct(after.tally[e].hit, after.tally[e].has)}）｜${before.tally[e].hit}/${before.tally[e].has}（${pct(before.tally[e].hit, before.tally[e].has)}）`);
  if (SHOW && process.argv.includes("--before")) for (const x of before.results.slice(0, SHOW)) console.log(`前 #${x.id} ${x.at.slice(5, 10)} ${x.r.map((y) => `${y.el}${y.has ? (y.hit ? "○" : "×") : "-"}`).join(" ")}｜${x.r.filter((y) => y.has && !y.hit).map((y) => `${y.el}:${y.detail}`).join(" ／ ")}`);
  if (SHOW) for (const x of after.results.slice(0, SHOW)) console.log(`#${x.id} ${x.at.slice(5, 10)} ${x.r.map((y) => `${y.el}${y.has ? (y.hit ? "○" : "×") : "-"}`).join(" ")}｜${x.r.filter((y) => y.has && !y.hit).map((y) => `${y.el}:${y.detail}`).join(" ／ ")}`);
  if (process.argv.includes("--write")) {
    const { error } = await sb.from("cron_run_logs").insert({ cron_name: "compose-prod-daily", started_at: started, finished_at: new Date().toISOString(), ok: true, result_json: { days: DAYS, turns: { before: before.turns, after: after.turns }, before: before.tally, after: after.tally } });
    console.log(error ? `cron_run_logs に書けない: ${error.message}` : "cron_run_logs に1行書いた");
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
