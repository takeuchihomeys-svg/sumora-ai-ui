// scripts/weekly-match-digest.ts — 竹内さんに届ける「今週の一致率」（No.27・11/03 夜 竹内さんの決定・案1＋YUMA への1行）
//   見張り line_watch_turns の今週（直近7日）と前の週の一致率を場面ごとに並べ、自動送信の線（auto-send-line の最新の回）と
//   毎晩の学び（nightly-learning の今週の回）の P0 の3つの原因の数を足して、確認事項のページの頭に貼る節を作る（読むだけ・LLM なし・費用 0）。
//   出力: .claude/exam-cache/weekly-digest/<日付>.md（指揮役が Docs「竹内さんへの確認事項」の頭に写す）／YUMA への1行の文も末尾に出す（送るのは指揮役か cron）
//   夜に: exam-conductor.ts --add --runner=cmd --night --label=weekly-digest --cmd="scripts/weekly-match-digest.ts"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { tallyTurns } from "./lib/auto-send-line-core";
import { examCacheRoot } from "./lib/llm-cassette";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAY = 86_400_000;
const pct = (a: number, n: number) => (n ? Math.round((1000 * a) / n) / 10 : null);

(async () => {
  const now = Date.now();
  const rows: Array<{ conversation_id: string; customer_turn_at: string; scene_key: string | null; verdict: string | null; verdict_detail: Record<string, unknown> | null; final_check: Record<string, unknown> | null }> = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("line_watch_turns").select("conversation_id, customer_turn_at, scene_key, verdict, verdict_detail, final_check").gte("customer_turn_at", new Date(now - 14 * DAY).toISOString()).order("id").range(i, i + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows));
    if ((data ?? []).length < 1000) break;
  }
  const real = rows.filter((r) => !isTestConversation(r.conversation_id));
  const thisW = tallyTurns(real.filter((r) => Date.parse(r.customer_turn_at) >= now - 7 * DAY)), lastW = tallyTurns(real.filter((r) => Date.parse(r.customer_turn_at) < now - 7 * DAY));
  const all = (t: typeof thisW) => t.reduce((a, x) => ({ n: a.n + x.n, m: a.m + x.match, p: a.p + x.pathMiss }), { n: 0, m: 0, p: 0 });
  const A = all(thisW), B = all(lastW);
  const day = new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
  const L = [`## 今週の一致率（${day}・直近7日・見張りの判定のある番）`, "",
    `- 全体: ${pct(A.m, A.n) ?? "-"}%（${A.m}/${A.n}）／前の週 ${pct(B.m, B.n) ?? "-"}%（${B.m}/${B.n}）／返信か AIX かの外れ ${A.p}（前の週 ${B.p}）`, "",
    "| 場面 | 今週 | 前の週 | 差 |", "|---|---|---|---|",
    ...thisW.slice(0, 15).map((x) => { const y = lastW.find((z) => z.scene === x.scene); const a = pct(x.match, x.n), b = y ? pct(y.match, y.n) : null; return `| ${x.scene} | ${a ?? "-"}%（${x.match}/${x.n}） | ${b ?? "-"}%${y ? `（${y.match}/${y.n}）` : ""} | ${a != null && b != null ? `${a - b >= 0 ? "+" : ""}${Math.round((a - b) * 10) / 10}pt` : "-"} |`; })];
  // 毎晩の学び（今週の回）の P0 の原因の数
  const nl = join(examCacheRoot(), "nightly-learning");
  const causes = new Map<string, number>();
  if (existsSync(nl)) for (const f of readdirSync(nl).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x) && Date.parse(x.slice(0, 10)) >= now - 7 * DAY)) {
    try { for (const r of (JSON.parse(readFileSync(join(nl, f), "utf8")).rows ?? []) as Array<{ lesson?: { cause?: string } | null }>) { const c = r.lesson?.cause || "（読めなかった）"; causes.set(c, (causes.get(c) ?? 0) + 1); } } catch { /* */ }
  }
  L.push("", `### 外れの原因（毎晩の学び・P0 の3つ）`, ...(causes.size ? [...causes].sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${k}: ${n}`) : ["- 今週の回が無い"]));
  // 自動送信の線（最新の回）
  const asl = join(examCacheRoot(), "auto-send-line");
  const latest = existsSync(asl) ? readdirSync(asl).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort().pop() : undefined;
  const cands = latest ? ((JSON.parse(readFileSync(join(asl, latest), "utf8")).cands ?? []) as string[]) : [];
  L.push("", `### 自動送信の候補の場面（${latest?.slice(0, 10) ?? "まだ回していない"}）`, ...(cands.length ? cands.map((c) => `- ${c}`) : ["- なし"]));
  const yuma = `今週の一致率を「竹内さんへの確認事項」の頭に書き足しました（全体 ${pct(A.m, A.n) ?? "-"}%・前の週 ${pct(B.m, B.n) ?? "-"}%）。`;
  L.push("", `---`, `YUMA への1行: ${yuma}`);
  const out = join(examCacheRoot(), "weekly-digest");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${day}.md`), L.join("\n") + "\n");
  console.log(L.join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
