// scripts/audit-unfinished.ts — 打ち合わせして抜けている部分の棚卸し（LLM なし・費用0・DB は設計知見と台帳の軽い読み）
// 2026-11-27 作業員L（竹内さん 11/27「打ち合わせして抜けてしまってる部分もちゃんと作業行ったら」・統括役の頼み）。計算は scripts/lib/unfinished-audit.ts
//   元: ① 設計知見の現行の P0/P1 の「竹内さんの決定／承認／指示」（題・札・applied_to・段・作った日だけ読む）② 台帳 work_items（＋work_item_events の最後の動き）
//       ③ #818 の決まりとコードの食い違い（--drift=<audit-rule-code-drift --json の json>）④ #816 のスイッチの一生（<exam-cache>/switch-life.json か --life=）
//   既定は一覧を出すだけ。--ledger で ①（台帳に無い）と ③（食い違いで台帳に無い）を記録だけから台帳に積む（題で重ねない）。--json で表を書く
// 実行: npx tsx --env-file=.env.local scripts/audit-unfinished.ts [--drift=<json>] [--life=<json>] [--top=20] [--json=<file>] [--ledger]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { examCacheRoot } from "./lib/llm-cassette";
import { areaOf, countByArea, decisionsWithoutLedger, impactOf, rankUnfinished, stalledLedger, unfinishedLedgerTitle, type KbDecision, type LedgerRow, type Unfinished } from "./lib/unfinished-audit";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string) => process.argv.includes(`--${k}`);
const readJson = <T>(f: string): T | null => { try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch { return null; } };

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!, { auth: { persistSession: false } });
  const nowIso = new Date().toISOString(); const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  // ① 設計知見（本文は読まない＝軽い）
  const kb: KbDecision[] = [];
  for (let from = 0; from < 5000; from += 1000) {
    const { data, error } = await sb.from("system_design_thinking").select("id, title, tags, applied_to, priority, created_at").eq("is_current", true).lte("priority", 1)
      .or("tags.cs.{竹内さんの決定},tags.cs.{竹内さんの承認},tags.cs.{竹内さんの指示},title.ilike.%竹内さんの決定%,title.ilike.%竹内さんの承認%,title.ilike.%竹内さんの指示%,title.ilike.%【決定】%")
      .order("created_at", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`設計知見: ${error.message}`);
    kb.push(...((data ?? []) as KbDecision[])); if (!data || data.length < 1000) break;
  }
  // ② 台帳と最後の動き
  const { data: wi, error: we } = await sb.from("work_items").select("id, title, stage, owner, switch_name, kb_ids, next_step, requested_at, created_at, priority").limit(5000);
  if (we) throw new Error(`台帳: ${we.message}`);
  const { data: ev } = await sb.from("work_item_events").select("item_id, at").order("at", { ascending: false }).limit(20000);
  const last = new Map<number, string>(); for (const e of (ev ?? []) as Array<{ item_id: number; at: string }>) if (!last.has(e.item_id)) last.set(e.item_id, e.at);
  const ledger: LedgerRow[] = ((wi ?? []) as Array<LedgerRow & { created_at: string }>).map((r) => ({ ...r, lastAt: last.get(r.id) ?? r.created_at }));
  const out: Unfinished[] = [];
  for (const r of decisionsWithoutLedger(kb, ledger, today)) {
    const t = `${r.title} ${(r.tags ?? []).join(" ")} ${r.applied_to ?? ""}`;
    out.push({ kind: "台帳に無い", ref: `KB ${r.id.slice(0, 8)}`, title: r.title, area: areaOf(t), impact: impactOf({ priority: r.priority, text: t }), owner: null, why: `${r.created_at.slice(5, 10)} P${r.priority ?? "?"}・applied_to ${r.applied_to?.trim() ? "に「未・予定・待ち」" : "が空"}` });
  }
  // ③ 食い違い（台帳に「決まりとコードの食い違い」の題で無い物）
  const drift = arg("drift") ? (readJson<unknown>(arg("drift")) as { drift?: unknown[] } | unknown[] | null) : null;
  const ds = (Array.isArray(drift) ? drift : drift?.drift ?? []) as Array<{ id: string; title: string; priority: number | null; sw: string; kind: string }>;
  const ledgerTitles = new Set(ledger.map((l) => l.title));
  for (const d of ds) {
    if (d.kind === "退役・コードは生きている") continue; // 退役した決まり＝抜けではない（コードの片付け）
    if ([...ledgerTitles].some((t) => t.startsWith("決まりとコードの食い違い:") && t.includes(d.sw))) continue;
    // そのスイッチの台帳の行がある＝台帳には在る（off のままかは ④ で数える）
    if (ledger.some((l) => l.switch_name === d.sw || l.title.includes(d.sw))) continue;
    const t = `${d.title} ${d.sw}`;
    out.push({ kind: "台帳に無い", ref: `#818 ${d.sw}`, title: d.title, area: areaOf(t), impact: impactOf({ priority: d.priority, text: t }), owner: null, why: `${d.kind}（KB ${d.id.slice(0, 8)}）` });
  }
  for (const l of stalledLedger(ledger, nowIso)) {
    out.push({ kind: "動いていない", ref: `#${l.id}`, title: l.title, area: areaOf(`${l.title} ${l.switch_name ?? ""}`), impact: impactOf({ priority: null, text: l.title }), owner: l.owner, why: `${l.stage}・頼まれて${l.reqDays}日・最後の動きから${l.quietDays}日` });
  }
  // ④ スイッチの一生（off のまま）
  const kbPri = new Map(kb.map((r) => [r.id.slice(0, 8), r.priority ?? 1] as [string, number]));
  const life = readJson<{ rows?: Array<{ sw: string; state: string; candidate: string | null; why: string; owner: string | null; purpose: string; ledger: { id: number; title: string } | null }> }>(arg("life") || join(examCacheRoot(), "switch-life.json"));
  for (const r of life?.rows ?? []) {
    if (r.state !== "off" || !r.candidate) continue;
    const t = `${r.sw} ${r.purpose} ${r.ledger?.title ?? ""}`;
    // 決めの設計知見（スイッチの一生の kbIds）が竹内さんの決定の行なら、その段で見込みを付ける（P0＝高・P1＝中）
    const kbP = ((r as { kbIds?: string[] }).kbIds ?? []).map((k) => kbPri.get(String(k).slice(0, 8))).filter((p): p is number => p != null);
    const pri = kbP.length ? Math.min(...kbP) : null;
    out.push({ kind: "off のまま", ref: r.ledger ? `#${r.ledger.id} ${r.sw}` : r.sw, title: r.purpose || r.sw, area: areaOf(t), impact: impactOf({ priority: pri, text: t }), owner: r.owner, why: `${r.candidate}の候補（${r.why}）${pri != null ? `・決め KB P${pri}` : ""}` });
  }
  const ranked = rankUnfinished(out); const top = Number(arg("top", "20")) || 20;
  const by = (k: string) => out.filter((x) => x.kind === k).length;
  console.log(`抜けの棚卸し（${today}）: 台帳に無い ${by("台帳に無い")}・動いていない ${by("動いていない")}・off のまま ${by("off のまま")}（設計知見の決定 ${kb.length}行・台帳 ${ledger.length}行・食い違い ${ds.length}組・スイッチの一生 ${life?.rows?.length ?? 0}行）`);
  console.log("\n## 分野ごと");
  for (const [a, m] of Object.entries(countByArea(out)).sort((x, y) => (y[1].計 ?? 0) - (x[1].計 ?? 0))) console.log(`- ${a}: 計 ${m.計}（台帳に無い ${m["台帳に無い"] ?? 0}・動いていない ${m["動いていない"] ?? 0}・off のまま ${m["off のまま"] ?? 0}）`);
  console.log(`\n## 上位 ${top}`);
  ranked.slice(0, top).forEach((x, i) => console.log(`${i + 1}. [${x.impact}・${x.area}・${x.kind}] ${x.ref}「${x.title.slice(0, 70)}」｜${x.why}${x.owner ? `｜持ち主 ${x.owner}` : ""}`));
  if (arg("json")) writeFileSync(arg("json"), JSON.stringify({ at: nowIso, counts: countByArea(out), rows: ranked }, null, 1));
  if (flag("ledger")) {
    const { data: open } = await sb.from("work_items").select("title").like("title", "【抜けの棚卸し】%").limit(3000);
    const have = new Set(((open ?? []) as Array<{ title: string }>).map((r) => r.title)); let n = 0;
    for (const x of ranked.filter((y) => y.kind === "台帳に無い")) {
      const title = unfinishedLedgerTitle(x); if (have.has(title)) continue;
      const { error } = await sb.from("work_items").insert({ title, origin: "found_gap", stage: "todo", area: x.area, owner: x.owner ?? "統括役", priority: x.impact === "高" ? 10 : x.impact === "中" ? 5 : 2, next_step: `${x.why}（scripts/audit-unfinished.ts）` });
      if (!error) { n++; have.add(title); }
    }
    console.log(`\n台帳に積んだ: ${n}`);
  }
}
if (require.main === module) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
