// scripts/audit-deal-flow.ts — 成約データから申込までの実際の流れを数え、地図（apply-route-map）と突き合わせる（台帳 #728・読むだけ・LLM なし・DeepSeek に渡さない）
// 2026-11-25 作業員L（竹内さん 11/25「地図は成約データから分析して流れ完全に理解できているのか？」・最優先 p0・統括役の頼み）
//   読む物: deal_outcomes（段の時刻だけ・518行）・見積の最初の時刻（aix_usage_logs の estimate_sheet と estimate_records・会話ごとの最初の1つ）。
//   申込以降・審査の中身・会話の文は読まない。会話は出さない（数だけ）。昼も軽い（deal_outcomes 1回＋会話ごとの見積の時刻）。
//   出す物: ①実際の流れの型（申込に届いた型ごと）②駅ごとの申込到達率 ③地図との食い違い（no_road・order・record_missing）④段の間の日数（申込に届いた件・中央）
//     ⑤申込に届いた件で、駅の次に多い段（地図の nextNode と比べる）。--out の JSON は作業員A（#687）の駅ごとの表と同じ station で重ねる形
// 実行: npx tsx --env-file=.env.local scripts/audit-deal-flow.ts [--out=<json>] [--cond-gap=<json>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, readFileSync } from "node:fs";
import { dealFlowOf, flowTypes, stationReach, stationStay, FLOW_STAGES, type DealRow, type DealFlow } from "./lib/deal-flow";
import { ROUTE_NODES } from "../app/lib/apply-route-map";
import { isTestConversation } from "../app/lib/test-conversations";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const cols = ["id", "conversation_id", ...FLOW_STAGES.map((s) => s.key).filter((k) => k !== "estimate_at")].join(", ");
  const { data, error } = await sb.from("deal_outcomes").select(cols).limit(5000);
  if (error) throw new Error(error.message);
  const deals = ((data ?? []) as unknown as DealRow[]).filter((d) => !isTestConversation(d.conversation_id));
  // 見積の最初の時刻（会話ごと）
  const convs = [...new Set(deals.map((d) => d.conversation_id))];
  const est = new Map<string, number>();
  const put = (c: string, iso: string | null | undefined) => { const t = iso ? Date.parse(iso) : NaN; if (Number.isFinite(t) && (!est.has(c) || t < (est.get(c) as number))) est.set(c, t); };
  for (let i = 0; i < convs.length; i += 100) {
    const part = convs.slice(i, i + 100);
    const a = await sb.from("aix_usage_logs").select("conversation_id, sent_at, created_at").in("conversation_id", part).eq("aix_type", "estimate_sheet").limit(5000);
    for (const r of (a.data ?? []) as Array<{ conversation_id: string; sent_at: string | null; created_at: string }>) put(r.conversation_id, r.sent_at ?? r.created_at);
    const e = await sb.from("estimate_records").select("conversation_id, created_at").in("conversation_id", part).limit(5000);
    for (const r of (e.data ?? []) as Array<{ conversation_id: string; created_at: string }>) put(r.conversation_id, r.created_at);
  }
  // 見積はその件の期間（初回〜申込／最後の段）の中の物だけ
  for (const d of deals) {
    const t = est.get(d.conversation_id);
    const start = d.first_contact_at ? Date.parse(d.first_contact_at) : -Infinity;
    if (t != null && t >= start && (!d.applied_at || t <= Date.parse(d.applied_at) + 864e5)) d.estimate_at = new Date(t).toISOString();
  }
  // 2026-11-25 夜 作業員A の頼み: --cond-gap=<audit-deal-condition-gap の json> を渡すと、初回の通に条件を書いてきた件（first_msg_conditions）は
  //   「条件の段を通らない道」＝条件の時刻を初回の時刻とみる（record_missing に数えない・地図の resolveRouteNode と同じく条件ヒアリングの駅を初回で通る）
  let condRoad = 0;
  if (arg("cond-gap")) {
    const g = JSON.parse(readFileSync(arg("cond-gap"), "utf8")) as { rows: Array<{ id: number; kind: string }> };
    const ids = new Set(g.rows.filter((r) => r.kind === "first_msg_conditions").map((r) => r.id));
    for (const d of deals) if (ids.has(d.id) && !d.condition_at && d.first_contact_at) { d.condition_at = d.first_contact_at; condRoad++; }
  }
  const fs: DealFlow[] = deals.map(dealFlowOf);
  if (arg("cond-gap")) console.log(`（--cond-gap: 初回の通に条件の ${condRoad}件は条件の時刻＝初回の時刻とみた＝条件の段を通らない道）\n`);
  const ap = fs.filter((f) => f.applied), na = fs.filter((f) => !f.applied);
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
  console.log(`# 成約データの流れ（deal_outcomes ${deals.length}件・申込 ${ap.length}・成約 ${fs.filter((f) => f.won).length}・試験の会話は除く）\n`);

  console.log("## ① 実際の流れの型（申込に届いた数の多い順・上位15）");
  console.log("| 型（時刻の順） | 件 | 申込 | 成約 | 申込の割合 | 段の間の日数の合計（中央） |");
  console.log("|---|---|---|---|---|---|");
  for (const t of flowTypes(fs).slice(0, 15)) console.log(`| ${t.type} | ${t.n} | ${t.applied} | ${t.won} | ${pct(t.applied, t.n)} | ${t.medDays ?? "—"}日 |`);

  const reach = stationReach(fs);
  console.log("\n## ② 駅ごとの申込到達率（その駅を通った件のうち申込に届いた割合）");
  console.log("| 駅 | 通った件 | 申込 | 到達率 |");
  console.log("|---|---|---|---|");
  for (const r of reach) console.log(`| ${r.station}（${ROUTE_NODES[r.station as keyof typeof ROUTE_NODES]?.name ?? ""}） | ${r.n} | ${r.applied} | ${r.rate == null ? "—" : `${r.rate}%`} |`);

  console.log("\n## ③ 地図との食い違い（件ごとに分けて数える・1件に複数あり）");
  const cnt = (xs: DealFlow[]) => { const m = new Map<string, number>(); for (const f of xs) for (const i of f.issues) m.set(`${i.kind}｜${i.why}`, (m.get(`${i.kind}｜${i.why}`) ?? 0) + 1); return m; };
  const ca = cnt(ap), cn = cnt(na);
  console.log("| 分け | 食い違い | 申込に届いた件 | 届かなかった件 |");
  console.log("|---|---|---|---|");
  for (const k of [...new Set([...ca.keys(), ...cn.keys()])].sort((a, b) => (ca.get(b) ?? 0) - (ca.get(a) ?? 0))) { const [kind, why] = k.split("｜"); console.log(`| ${kind} | ${why} | ${ca.get(k) ?? 0} | ${cn.get(k) ?? 0} |`); }

  console.log("\n## ④ 段の間の日数（申込に届いた件・隣の段どうし・中央と件）");
  const tr = new Map<string, number[]>();
  for (const f of ap) for (const g of f.gaps) tr.set(`${g.from}→${g.to}`, [...(tr.get(`${g.from}→${g.to}`) ?? []), g.days]);
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  for (const [k, xs] of [...tr].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) console.log(`- ${k}: ${xs.length}件・中央 ${med(xs)}日`);

  console.log("\n## ⑤ 申込に届いた件で、駅の次に多い段（地図の次の駅と比べる）");
  const nxt = new Map<string, Map<string, number>>();
  for (const f of ap) for (let k = 0; k + 1 < f.stations.length; k++) { const m = nxt.get(f.stations[k]) ?? new Map<string, number>(); m.set(f.stations[k + 1], (m.get(f.stations[k + 1]) ?? 0) + 1); nxt.set(f.stations[k], m); }
  console.log("| 駅 | 地図の次の駅 | 申込に届いた件で多い次の段 |");
  console.log("|---|---|---|");
  for (const [st, m] of nxt) { const top = [...m].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, n]) => `${s} ${n}`).join("・"); console.log(`| ${st} | ${ROUTE_NODES[st as keyof typeof ROUTE_NODES]?.nextNode ?? "—"} | ${top} |`); }

  if (arg("out")) {
    const stay = stationStay(fs);
    const rows = reach.map((r) => ({
      station: r.station, reach: { applied: r.applied, n: r.n, rate: r.rate },
      // 作業員A 11/25: 駅にいた日数（次の段まで・申込に届いた件／届かなかった件）。時刻の列の無い駅（pickup 等）は無し
      stay: stay.get(r.station) ?? null,
      flowTypes: flowTypes(fs.filter((f) => f.stations.includes(r.station))).slice(0, 3).map((t) => ({ type: t.type, n: t.n, applied: t.applied })),
      gaps: [...new Set(fs.filter((f) => f.stations.includes(r.station)).flatMap((f) => f.issues.map((i) => i.kind)))],
    }));
    writeFileSync(arg("out"), JSON.stringify({ at: new Date().toISOString(), deals: deals.length, applied: ap.length, rows }, null, 1));
    console.log(`\n書いた: ${arg("out")}（作業員A の駅ごとの表と station で重ねる形）`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
