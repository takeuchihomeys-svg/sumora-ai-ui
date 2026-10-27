// scripts/line-watch-weekly.ts — 見張り（line_watch_turns）の毎週の一致率（直近7日とその前の7日・場面ごと）＋返信か AIX かの判断の一致（読むだけ・LLM なし・費用 0）
//
// 2026-10-28 作業員4（CLAUDE.md「絶対的な考え方」の回し方の①見張りのズレ）: 竹内さんに毎週出す形の表。
//   場面ごとの一致＝ line-watch-daily.sceneStats と同じ数え方（same＋same_meaning／na・判定待ち・申込以降・重複・埋め戻しは数えない）。
//   判断の一致＝ verdict_detail.aix_verdict（same/other＝ブレインが AIX でスタッフも押した・not_pressed＝ブレインは AIX・スタッフは押さず返信／
//     unexpected＝ブレインは返信・スタッフは AIX）。ブレインが返信でスタッフも返信の番は判断の一致に数える（AIX の判定が付かない番＝返信の番で比べられた物）。
//
// 実行: npx tsx --env-file=.env.local scripts/line-watch-weekly.ts [--min=3] [--md]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { sceneStats, sceneLabel, type StatTurn } from "../app/lib/line-watch-daily";
import { isBackfillTurn } from "../app/lib/line-watch-backfill";
import { BRAIN_AIX_LABELS } from "../app/lib/aix-button-view";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const MIN = Number(arg("min", "3"));
const DAY = 86_400_000;
const pct = (a: number, n: number) => (n ? `${Math.round((a / n) * 100)}%` : "—");

type Row = StatTurn & { id: number; brain_reply_mode: string | null; brain_action: string | null };
(async () => {
  const nowMs = Date.now();
  const since = new Date(nowMs - 15 * DAY).toISOString();
  const rows: Row[] = [];
  for (let i = 0; ; i += 1000) {
    const r = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, scene_key, verdict, verdict_detail, brain_reply_mode, brain_action")
      .gte("customer_turn_at", since).order("id").range(i, i + 999);
    if (r.error) throw new Error(r.error.message);
    rows.push(...((r.data ?? []) as Row[]));
    if ((r.data ?? []).length < 1000) break;
  }
  const turns = rows.filter((t) => !isTestConversation(t.conversation_id) && !isBackfillTurn(t));
  const st = sceneStats(turns, nowMs).filter((s) => s.last7.n + s.prev7.n >= MIN);

  // 返信の番／AIX の番の合計
  const sum = (path: string, w: "last7" | "prev7") => st.filter((s) => s.path === path).reduce((a, s) => ({ n: a.n + s[w].n, agree: a.agree + s[w].agree }), { n: 0, agree: 0 });
  // 判断（返信か AIX か）
  const judge = (fromDay: number, toDay: number) => {
    const out = { ok: 0, n: 0, replyButAix: 0, aixButReply: 0, aixOther: 0 };
    for (const t of turns) {
      const age = nowMs - Date.parse(t.customer_turn_at);
      if (!(age >= fromDay * DAY && age < toDay * DAY)) continue;
      const d = (t.verdict_detail ?? {}) as Record<string, unknown>;
      if (d.reason === "duplicate_turn") continue;
      const av = String(d.aix_verdict ?? "");
      const brainAix = (t.brain_reply_mode ?? "") === "aix";
      if (av === "same" || av === "other") { out.n++; out.ok++; if (av === "other") out.aixOther++; continue; }
      if (av === "not_pressed") { out.n++; out.aixButReply++; continue; }
      if (av === "unexpected") { out.n++; out.replyButAix++; continue; }
      if (!brainAix && ["same", "same_meaning", "partial", "different"].includes(String(t.verdict ?? ""))) { out.n++; out.ok++; }
    }
    return out;
  };
  const j7 = judge(0, 7), jp = judge(7, 14);
  const r7 = sum("返信", "last7"), rp = sum("返信", "prev7"), a7 = sum("AIX", "last7"), ap = sum("AIX", "prev7");

  console.log(`# 見張りの毎週の一致率（直近7日／その前の7日）｜${new Date(nowMs + 9 * 3600_000).toISOString().slice(0, 10)}`);
  console.log("");
  console.log("| 物差し | 直近7日 | 前の7日 |");
  console.log("|---|---|---|");
  console.log(`| 返信の番（文が同じ・同じ事） | ${pct(r7.agree, r7.n)}（${r7.agree}/${r7.n}） | ${pct(rp.agree, rp.n)}（${rp.agree}/${rp.n}） |`);
  console.log(`| AIX の番（同じ AIX） | ${pct(a7.agree, a7.n)}（${a7.agree}/${a7.n}） | ${pct(ap.agree, ap.n)}（${ap.agree}/${ap.n}） |`);
  console.log(`| 返信か AIX かの判断 | ${pct(j7.ok, j7.n)}（${j7.ok}/${j7.n}） | ${pct(jp.ok, jp.n)}（${jp.ok}/${jp.n}） |`);
  console.log(`| 　うち AI 返信→人 AIX | ${j7.replyButAix} | ${jp.replyButAix} |`);
  console.log(`| 　うち AI AIX→人 返信 | ${j7.aixButReply} | ${jp.aixButReply} |`);
  console.log("");
  console.log("## 場面ごと（直近7日の外れの多い順）");
  console.log("| 場面 | 直近7日 | 前の7日 | 外れ（直近） |");
  console.log("|---|---|---|---|");
  for (const s of [...st].sort((a, b) => (b.last7.n - b.last7.agree) - (a.last7.n - a.last7.agree) || b.last7.n - a.last7.n)) {
    console.log(`| ${sceneLabel(s.scene, BRAIN_AIX_LABELS).replace(/^AIX AIX/, "AIX")} | ${pct(s.last7.agree, s.last7.n)}（${s.last7.agree}/${s.last7.n}） | ${pct(s.prev7.agree, s.prev7.n)}（${s.prev7.agree}/${s.prev7.n}） | ${s.last7.n - s.last7.agree} |`);
  }
  process.exit(0);
})();
