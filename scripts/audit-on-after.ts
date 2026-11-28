// scripts/audit-on-after.ts — 台帳 #799 ④: on にした直しの試験での差と、on の後の本番の一致の動き（7日・14日）を on にした日の組ごとに並べる（読むだけ・LLM なし）
// 2026-11-26 作業員L（統括役の頼み）: 読むのは小さい物だけ（work_item_events の on・work_items・quality_daily の reply_match・係の結果のファイル）＝昼でも軽い。
//   --write で quality_daily に on_after:reply_match:d7:<on にした日>・:d14:<日>（scope＝takeuchi か all）と on_after:reply_match:miss（外れの組の数・detail に組）を書く（#610 の帳面の 7日・14日の突き合わせが読む）。
//   2026-11-28 作業員L: 前は scope に on にした日を入れていて、quality_daily_scope_chk（takeuchi・all・draft・employee だけ）に弾かれ毎晩落ちていた（11/26・11/27 の晩）→ 日は metric の名前へ
//   計算は scripts/lib/on-after.ts。
// 実行: npx tsx --env-file=.env.local scripts/audit-on-after.ts [--days=45] [--write]
import { createClient } from "@supabase/supabase-js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { examCacheRoot } from "./lib/llm-cassette";
import { onGroupsOf, VERDICT_JA, type DayVal, type ExamSide, type OnEvent } from "./lib/on-after";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
/** 係の結果（exam-queue/results/*.json）から スイッチ → 良く・悪化・label（スイッチの欄は「名前（…）」の形もある） */
export function examBySwitch(dir: string, names: readonly string[]): Map<string, ExamSide> {
  const out = new Map<string, ExamSide>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f.endsWith(".reps.json")) continue;
    let j: { label?: string; switch?: string; better?: number | null; worse?: number | null } | null = null;
    try { j = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    if (!j?.switch || typeof j.better !== "number") continue;
    for (const n of names) {
      if (!String(j.switch).split(/[（(,、\s]/).includes(n)) continue;
      const r = out.get(n) ?? { better: 0, worse: 0, labels: [] };
      r.better += j.better ?? 0; r.worse += j.worse ?? 0; r.labels.push(String(j.label ?? f));
      out.set(n, r);
    }
  }
  return out;
}

if (require.main === module) (async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const days = Number(arg("days", "45")) || 45;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  const { data: ev, error: e1 } = await sb.from("work_item_events").select("item_id, at").eq("to_stage", "on").gte("at", since).order("at").limit(2000);
  if (e1) throw new Error(e1.message);
  const ids = [...new Set((ev ?? []).map((r) => Number(r.item_id)))];
  const items = new Map<number, { switch_name: string | null; title: string }>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from("work_items").select("id, switch_name, title").in("id", ids.slice(i, i + 200));
    for (const r of data ?? []) items.set(Number(r.id), { switch_name: r.switch_name, title: String(r.title ?? "") });
  }
  const events: OnEvent[] = (ev ?? []).map((r) => ({ itemId: Number(r.item_id), at: String(r.at), switchName: items.get(Number(r.item_id))?.switch_name ?? null, title: items.get(Number(r.item_id))?.title ?? "" }));
  const exam = examBySwitch(join(examCacheRoot(), "exam-queue", "results"), [...new Set(events.map((e) => e.switchName).filter((x): x is string => !!x))]);
  const fromDay = new Date(Date.parse(since) - 8 * 86_400_000 + 9 * 3_600_000).toISOString().slice(0, 10);
  const { data: qd, error: e2 } = await sb.from("quality_daily").select("day, scope, value, n").eq("metric", "reply_match").gte("day", fromDay).limit(2000);
  if (e2) throw new Error(e2.message);
  const qrows: Array<Record<string, unknown>> = [];
  for (const scope of ["takeuchi", "all"]) {
    const daily = new Map<string, DayVal>();
    for (const r of qd ?? []) if (r.scope === scope) daily.set(String(r.day), { value: r.value == null ? null : Number(r.value), n: Number(r.n ?? 0) });
    const gs = onGroupsOf(events, exam, daily, today);
    console.log(`\n## 返信の一致（${scope === "takeuchi" ? "竹内さんの番" : "全体"}）・on にした日の組 ${gs.length}`);
    console.log("| on の日 | 直し | 試験（良く/悪化・本） | 前7日 | 後7日（差） | 後14日（差） | 見立て |\n|---|---|---|---|---|---|---|");
    for (const g of gs) console.log(`| ${g.day} | ${g.switches.slice(0, 4).join(",")}${g.switches.length > 4 ? ` ほか${g.switches.length - 4}` : ""} | ${g.exam.better}/${g.exam.worse}・${g.exam.labels.length} | ${g.before ?? "—"} | ${g.after7 ?? "—"}（${g.d7 ?? "—"}） | ${g.after14 ?? "—"}（${g.d14 ?? "—"}） | ${VERDICT_JA[g.verdict]} |`);
    const miss = gs.filter((g) => g.verdict === "miss");
    console.log(`外れの組: ${miss.length}${miss.length ? `（${miss.map((g) => `${g.day} ${g.switches.join(",")} ${g.d7}pt`).join("／")}）` : ""}`);
    for (const g of gs) {
      if (g.d7 != null) qrows.push({ day: today, metric: `on_after:reply_match:d7:${g.day}`, scope, value: g.d7, n: g.n7, detail: { switches: g.switches, items: g.items, exam: g.exam, before: g.before, after7: g.after7, verdict: g.verdict } });
      if (g.d14 != null) qrows.push({ day: today, metric: `on_after:reply_match:d14:${g.day}`, scope, value: g.d14, n: g.n7, detail: { switches: g.switches, after14: g.after14, verdict: g.verdict } });
    }
    qrows.push({ day: today, metric: "on_after:reply_match:miss", scope, value: miss.length, n: gs.length, detail: { groups: miss.map((g) => ({ day: g.day, switches: g.switches, items: g.items, d7: g.d7, exam: g.exam })) } });
  }
  if (process.argv.includes("--write")) {
    const { error } = await sb.from("quality_daily").upsert(qrows, { onConflict: "day,metric,scope" });
    if (error) throw new Error(error.message);
    console.log(`\nquality_daily に書いた: ${qrows.length}行（${today}）`);
  }
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
