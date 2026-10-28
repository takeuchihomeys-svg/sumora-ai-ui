// scripts/line-watch-miss-causes.ts — 返信の番の文の外れの原因の毎週の表（直近7日／その前の7日・読むだけ・LLM なし・費用 0）
//
// 2026-10-28 作業員1: 文の外れを原因（F1〜F4・C・D・N・要読む）に自動で分け、件数・割合・新しく出た場面を出す。分けは app/lib/line-watch-miss-cause.ts。
//   「新しく出た場面」＝直近7日に外れがあり、その前の28日には外れが無かった場面。
//   「要読む」の番は id と下書き・スタッフの文の頭を出す（人か LLM が A/B/E を決める）。
//
// 実行: npx tsx --env-file=.env.local scripts/line-watch-miss-causes.ts [--list] [--eval=<id\tcat の tsv>]
//   --eval: 手で付けた原因と自動の分けを id で突き合わせる（自動の分けの当たり具合を測る）
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { isBackfillTurn } from "../app/lib/line-watch-backfill";
import { classifyMiss, isTextMiss, MISS_CAUSE_JA, type MissCause, type MissRow } from "../app/lib/line-watch-miss-cause";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const LIST = process.argv.includes("--list");
const EVAL = arg("eval");
const DAY = 86_400_000;
const pct = (a: number, n: number) => (n ? `${Math.round((a / n) * 100)}%` : "—");
const COLS = "id, conversation_id, customer_turn_at, scene_key, verdict, verdict_detail, draft_last, staff_texts, staff_aix, judge_version";
type Row = MissRow & { id: number; conversation_id: string; customer_turn_at: string; judge_version: string | null };

async function fetchRows(filter: (q: any) => any): Promise<Row[]> {
  const rows: Row[] = [];
  for (let i = 0; ; i += 1000) {
    let r: any = null;
    for (let t = 0; t < 4; t++) { r = await filter(sb.from("line_watch_turns").select(COLS)).order("id").range(i, i + 999); if (!r.error) break; await new Promise((s) => setTimeout(s, 3000)); }
    if (r.error) throw new Error(r.error.message);
    rows.push(...((r.data ?? []) as Row[]));
    if ((r.data ?? []).length < 1000) break;
  }
  return rows;
}

(async () => {
  if (EVAL) {
    const manual = new Map<number, string>();
    for (const line of readFileSync(EVAL, "utf8").split(/\r?\n/).slice(1)) { const [id, cat] = line.split("\t"); if (id && cat) manual.set(Number(id), cat.trim()); }
    const rows = await fetchRows((q) => q.in("id", [...manual.keys()]));
    const grp = (c: string) => (c.startsWith("F") ? c : c === "C" || c === "D" || c === "N" ? c : c === "E" ? "要読む:E" : c === "A" || c === "B" ? "要読む:A/B" : c);
    let ok = 0, fOk = 0, fN = 0; const miss: string[] = [];
    for (const r of rows) {
      const m = manual.get(r.id) ?? "";
      const a = classifyMiss(r);
      const hit = grp(m) === a.cause || (m.startsWith("F") && a.cause.startsWith("F"));
      if (grp(m) === a.cause) ok++;
      if (m.startsWith("F")) { fN++; if (a.cause.startsWith("F")) fOk++; }
      if (!hit) miss.push(`#${r.id} 手=${m} 自動=${a.cause}（${a.why}）`);
    }
    console.log(`手の分け ${rows.length}番: 細かい分けまで一致 ${ok}（${pct(ok, rows.length)}）／F（AIX・スタッフの手）を F と当てた ${fOk}/${fN}`);
    console.log(miss.join("\n"));
    process.exit(0);
  }

  const nowMs = Date.now();
  const all = (await fetchRows((q) => q.gte("customer_turn_at", new Date(nowMs - 35 * DAY).toISOString())))
    .filter((t) => !isTestConversation(t.conversation_id) && !isBackfillTurn(t as never));
  const age = (t: Row) => nowMs - Date.parse(t.customer_turn_at);
  const win = (from: number, to: number) => all.filter((t) => age(t) >= from * DAY && age(t) < to * DAY);
  const isReply = (t: Row) => String((t.verdict_detail ?? {}).path ?? "") === "返信" && (t.verdict_detail ?? {}).reason !== "duplicate_turn";
  const stat = (ts: Row[]) => {
    const reply = ts.filter(isReply);
    const misses = reply.filter(isTextMiss).map((t) => ({ t, ...classifyMiss(t) }));
    const staffOnly = reply.filter((t) => (t.verdict_detail ?? {}).reason === "staff_only_turn").length;
    return { replyN: reply.length, staffOnly, misses };
  };
  const s7 = stat(win(0, 7)), sp = stat(win(7, 14));
  const causes = Object.keys(MISS_CAUSE_JA) as MissCause[];
  const cnt = (s: ReturnType<typeof stat>, c: MissCause) => s.misses.filter((m) => m.cause === c).length;

  console.log(`# 返信の番の文の外れ・原因の分け（直近7日／その前の7日）｜${new Date(nowMs + 9 * 3600_000).toISOString().slice(0, 10)}`);
  console.log("");
  console.log(`返信の番 ${s7.replyN}（前 ${sp.replyN}）・文の外れ ${s7.misses.length}（前 ${sp.misses.length}）・v9 で物差しの外にした番（staff_only_turn）${s7.staffOnly}（前 ${sp.staffOnly}）`);
  const oldJudge = s7.misses.filter((m) => !String(m.t.judge_version ?? "").startsWith("v9")).length;
  if (oldJudge) console.log(`※ 直近7日の外れのうち ${oldJudge}番はまだ v9 より前の見張りで判定（夜の判定し直しの後に減る物がある）`);
  console.log("");
  console.log("| 原因 | 直近7日 | 割合 | 前の7日 | 割合 |");
  console.log("|---|---|---|---|---|");
  for (const c of causes) console.log(`| ${MISS_CAUSE_JA[c]} | ${cnt(s7, c)} | ${pct(cnt(s7, c), s7.misses.length)} | ${cnt(sp, c)} | ${pct(cnt(sp, c), sp.misses.length)} |`);
  const f7 = s7.misses.filter((m) => m.cause.startsWith("F")).length, fp = sp.misses.filter((m) => m.cause.startsWith("F")).length;
  console.log(`| （F の合計＝返信か AIX かの判断・物差しの外） | ${f7} | ${pct(f7, s7.misses.length)} | ${fp} | ${pct(fp, sp.misses.length)} |`);

  // 新しく出た場面
  const before = new Set(stat(win(7, 35)).misses.map((m) => m.t.scene_key ?? ""));
  const fresh = new Map<string, number>();
  for (const m of s7.misses) { const k = m.t.scene_key ?? ""; if (!before.has(k)) fresh.set(k, (fresh.get(k) ?? 0) + 1); }
  console.log("");
  console.log("## 新しく出た場面（直近7日に外れ・その前の28日は外れ無し）");
  if (!fresh.size) console.log("- なし");
  for (const [k, n] of fresh) console.log(`- ${k || "（場面なし）"}: ${n}番`);

  // 場面×原因（直近7日）
  console.log("");
  console.log("## 場面ごとの原因（直近7日）");
  const byScene = new Map<string, Map<string, number>>();
  for (const m of s7.misses) { const k = m.t.scene_key ?? ""; const mm = byScene.get(k) ?? new Map(); mm.set(m.cause, (mm.get(m.cause) ?? 0) + 1); byScene.set(k, mm); }
  for (const [k, mm] of [...byScene].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))) {
    console.log(`- ${k || "（場面なし）"}: ${[...mm].map(([c, n]) => `${c} ${n}`).join("・")}`);
  }
  if (LIST) {
    console.log("");
    console.log("## 番ごと（直近7日）");
    for (const m of s7.misses) console.log(`- #${m.t.id} ${m.t.customer_turn_at.slice(5, 16)} ${m.t.scene_key} → ${m.cause}（${m.why}）`);
  }
  process.exit(0);
})();
