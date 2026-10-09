// scripts/line-watch-monthly.ts — 見張り（line_watch_turns）の場面ごとの一致率を1ヶ月単位で（読むだけ・LLM なし・費用 0）
//
// 2026-10-08 竹内さんの決定 10/08 の1。埋め戻した過去の番（verdict_detail.backfill・scripts/line-watch-backfill.ts）と今の控え（10/01〜）を並べる。
//   数え方は毎日のまとめと同じ（line-watch-daily.sceneStatsByMonth＝sceneStats の addTo: na・判定待ちは数えない・申込以降は入れない・テスト用の会話は外す）
//   一致 = same＋same_meaning。文 = 下書きと送った文を比べた番（text_verdict）のうちの一致
//
// 実行: npx tsx --env-file=.env.local scripts/line-watch-monthly.ts [--min=5] [--group=src|brain|writer|none] [--from=2026-06]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { sceneStatsByMonth, sceneLabel, type StatTurn } from "../app/lib/line-watch-daily";
import { isBackfillTurn } from "../app/lib/line-watch-backfill";
import { BRAIN_AIX_LABELS } from "../app/lib/aix-button-view";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const MIN = Number(arg("min", "5"));
const GROUP = arg("group", "src");
const FROM = arg("from", "2026-06");

(async () => {
  const rows: Array<StatTurn & { brain_versions: number | null }> = [];
  for (let i = 0; ; i += 1000) {
    const r = await sb.from("line_watch_turns").select("conversation_id, customer_turn_at, scene_key, verdict, verdict_detail, brain_versions").order("id").range(i, i + 999);
    if (r.error) throw new Error(r.error.message);
    rows.push(...((r.data ?? []) as typeof rows));
    if ((r.data ?? []).length < 1000) break;
  }
  const turns = rows.filter((t) => !isTestConversation(t.conversation_id));
  const groupOf = (t: StatTurn & { brain_versions?: number | null }): string => {
    const d = (t.verdict_detail ?? {}) as Record<string, unknown>;
    if (GROUP === "none") return "全部";
    if (GROUP === "brain") return (t.brain_versions ?? 0) > 0 ? "ブレインあり" : "ブレインなし";
    if (GROUP === "writer") return String(d.staff_writer ?? "不明");
    return isBackfillTurn(t) ? "埋め戻し" : "控え";
  };
  const stats = sceneStatsByMonth(turns, { group: groupOf }).filter((r) => r.month >= FROM);
  const months = [...new Set(stats.map((r) => r.month))].sort();
  const pct = (a: number, n: number) => (n ? `${Math.round((a / n) * 100)}%` : "—");
  console.log(`# 場面ごとの一致率（1ヶ月単位・日本時間）｜行 ${turns.length}（埋め戻し ${turns.filter(isBackfillTurn).length}）｜分け方 ${GROUP}｜表は n>=${MIN} の場面`);
  console.log(`一致＝そのまま＋同じ事｜n＝比べられた番（na・判定待ち・申込以降は数えない）｜文＝下書きと送った文の一致｜別＝別の事｜事実＝金額・日時・物件の食い違い\n`);
  // 場面×月の表（行＝場面・列＝月）
  const scenes = [...new Set(stats.map((r) => r.scene))];
  const total = (s: string) => stats.filter((r) => r.scene === s).reduce((a, r) => a + r.win.n, 0);
  scenes.sort((a, b) => (a.includes("全体") ? -1 : 0) - (b.includes("全体") ? -1 : 0) || total(b) - total(a));
  const groups = [...new Set(stats.map((r) => r.group))].sort();
  console.log(`| 場面 | 分け | ${months.join(" | ")} |`);
  console.log(`|---|---|${months.map(() => "---").join("|")}|`);
  for (const s of scenes) {
    if (total(s) < MIN && !s.includes("全体")) continue;
    for (const g of groups) {
      const cells = months.map((m) => {
        const r = stats.find((x) => x.month === m && x.scene === s && x.group === g);
        if (!r || !r.win.n) return "";
        return `${pct(r.win.agree, r.win.n)} (n=${r.win.n}・文 ${pct(r.win.textAgree, r.win.textN)}・別 ${r.win.different}・事実 ${r.win.factDiff})`;
      });
      if (cells.every((c) => !c)) continue;
      console.log(`| ${s.includes("全体") ? s : sceneLabel(s, BRAIN_AIX_LABELS).replace(/^AIX AIX /, "AIX ")} | ${g} | ${cells.join(" | ")} |`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
