// scripts/audit-route-foundation.ts — 申込までの地図の駅ごとの土台の表（決まり → 材料 → 物差し → 試験 → 統括）と空き（台帳 #687・#608・#650・#657・読むだけ・LLM なし）
// 2026-11-25 作業員A（竹内さん 11/25 18時台「地図の部分かなり重要・土台も整えて強化・細分化して強化・統括ブレインともちゃんと連携」・統括役の頼み）。
//   表の形は作業員L の audit-promise-lifecycle（段ごとの数→空き）とそろえた（11/25 L と決めた: 段の名前と JSON の欄）。
//   決まり: 駅の next.aix の数・番の型で選び直す規則（app/lib/apply-route-next.ts に駅の名前が出る数）
//   材料: 駅の中の状態（app/lib/apply-route-substate.ts の SUBSTATES）の数
//   物差し: 今どこ（地図の駅 × 判断の記録の段 digest.sg・sameRouteStation）と次の一手（routeAgreement の合う側）＝--from の照らしの json（audit-route-progress-takeuchi）
//           ＋ L の成約データの申込到達率（--deal=<audit-deal-flow の json>・rows[].reach）
//   試験: 照らしの番（会話の頭8字・時刻 ±10分）に重なる試験の問題（spec.json）の数
//   統括: 番ごとの判断の記録 digest.ar（ROUTE_DIGEST・駅|分かれ道|…）に駅が入った番の数（--db の時だけ・直近 --days 日・日付で絞った軽い読み）・ar が空の番（#676）
// 実行: npx tsx --env-file=.env.local scripts/audit-route-foundation.ts --from=<照らしの json> [--deal=<json>] [--db] [--days=7] [--out=<json>]
import { readFileSync, writeFileSync } from "node:fs";
import { MAIN_ROUTE, ROUTE_NODES, ROUTE_BRANCHES } from "../app/lib/apply-route-map";
import { SUBSTATES } from "../app/lib/apply-route-substate";
import { sameRouteStation } from "./lib/flex-daily";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const rd = <T>(p: string, d: T): T => { try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return d; } };
type Row = { conv: string; at: string; node: string | null; branch: string | null; digestNode: string | null; agree: string };
const rows = rd<Row[]>(arg("from"), []);
if (!rows.length) { console.error("--from=<audit-route-progress-takeuchi の json> が要る"); process.exit(1); }
const GOOD = new Set(["aix_match", "promise_match", "reply_match", "reply_invite"]);
const nextSrc = rd<string | null>("__none__", null) ?? (() => { try { return readFileSync("app/lib/apply-route-next.ts", "utf8"); } catch { return ""; } })();
const spec = rd<Array<{ id: string; conv?: string; at?: string }>>("scripts/brain-exam/spec.json", []);
const deal = rd<{ rows?: Array<{ station: string; reach?: { applied: number; n: number; rate: number | null } }> }>(arg("deal"), {});
const reachOf = new Map((deal.rows ?? []).map((r) => [r.station, r.reach ?? null]));

const stations: Array<{ id: string; branch: boolean; name: string; aix: string[] }> = [
  ...MAIN_ROUTE.map((id) => ({ id, branch: false, name: ROUTE_NODES[id].name, aix: [...(ROUTE_NODES[id].next?.aix ?? [])] })),
  ...Object.values(ROUTE_BRANCHES).map((b) => ({ id: `分:${b.id}`, branch: true, name: b.name, aix: [...(b.next?.aix ?? [])] })),
];
const keyOf = (r: Row) => (r.branch ? `分:${r.branch}` : String(r.node ?? ""));
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

(async () => {
  // 統括: digest.ar
  const ar = new Map<string, number>(); let arEmpty = 0, arAll = 0, arBefore = 0;
  if (process.argv.includes("--db")) {
    const { createClient } = await import("@supabase/supabase-js");
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
    const since = new Date(Date.now() - (Number(arg("days", "7")) || 7) * 86_400_000).toISOString();
    for (let f = 0; ; f += 1000) {
      const { data, error } = await sb.from("brain_decision_logs").select("digest").gte("created_at", since).order("created_at").range(f, f + 999);
      if (error) throw new Error(error.message);
      for (const d of (data ?? []) as Array<{ digest: { ar?: string | null } | null }>) {
        if (!d.digest || !("ar" in d.digest)) { arBefore++; continue; } // ROUTE_DIGEST より前の番（欄が無い）＝空に数えない
        arAll++;
        const v = String(d.digest?.ar ?? "");
        const [node, branch] = v.split("|");
        if (!node) { arEmpty++; continue; }
        const k = branch ? `分:${branch}` : node;
        ar.set(k, (ar.get(k) ?? 0) + 1);
      }
      if ((data ?? []).length < 1000) break;
    }
  }
  const out = stations.map((s) => {
    const xs = rows.filter((r) => keyOf(r) === s.id);
    const sgRows = xs.filter((r) => !s.branch && r.digestNode && r.at >= "2026-11-03T05:42");
    const sgOk = sgRows.filter((r) => sameRouteStation(r.node, r.digestNode)).length;
    const nextOk = xs.filter((r) => GOOD.has(r.agree)).length;
    const exam = new Set(spec.filter((p) => p.conv && p.at && xs.some((r) => r.conv === p.conv!.slice(0, 8) && Math.abs(Date.parse(r.at) - Date.parse(p.at!)) <= 600_000)).map((p) => p.id));
    const rid = s.id.replace(/^分:/, "");
    const rules = s.aix.length + (nextSrc.match(new RegExp(`(?:node|branch) === "${rid}"`, "g")) ?? []).length;
    const material = SUBSTATES.filter((x) => (x as { at?: string }).at === rid).length;
    const reach = reachOf.get(rid) ?? null;
    const conductor = process.argv.includes("--db") ? ar.get(s.id) ?? 0 : null;
    const gaps: string[] = [];
    if (!rules) gaps.push("決まり");
    if (!material) gaps.push("材料");
    if (xs.length >= 5 && (pct(nextOk, xs.length) ?? 100) < 60) gaps.push("物差し:次の一手<60%");
    if (sgRows.length >= 5 && (pct(sgOk, sgRows.length) ?? 100) < 70) gaps.push("物差し:今どこ<70%");
    if (xs.length >= 5 && !exam.size) gaps.push("試験");
    if (conductor === 0) gaps.push("統括");
    return { station: s.id, name: s.name, rules, material, sg: { ok: sgOk, n: sgRows.length, rate: pct(sgOk, sgRows.length) }, next: { ok: nextOk, n: xs.length, rate: pct(nextOk, xs.length) }, reach, exam: exam.size, conductor, gaps };
  });
  console.log(`# 申込までの地図の駅ごとの土台（照らしの番 ${rows.length}${process.argv.includes("--db") ? `・判断の記録 ${arAll}（駅が空 ${arEmpty}＝#676・欄が無い前の番 ${arBefore}）` : ""}${deal.rows ? "・成約データの到達率あり" : ""}）\n`);
  console.log("| 駅 | 決まり | 材料 | 今どこ | 次の一手 | 申込到達 | 試験 | 統括 | 空き |\n|---|---|---|---|---|---|---|---|---|");
  for (const o of out) {
    if (!o.next.n && !o.rules && !o.conductor) continue;
    console.log(`| ${o.name}（${o.station}） | ${o.rules} | ${o.material} | ${o.sg.n ? `${o.sg.ok}/${o.sg.n}` : "—"} | ${o.next.n ? `${o.next.ok}/${o.next.n}` : "—"} | ${o.reach ? `${o.reach.applied}/${o.reach.n}` : "—"} | ${o.exam} | ${o.conductor ?? "—"} | ${o.gaps.join("・") || "なし"} |`);
  }
  const g = new Map<string, number>(); for (const o of out) for (const x of o.gaps) g.set(x.split(":")[0], (g.get(x.split(":")[0]) ?? 0) + 1);
  console.log(`\n空きの段: ${[...g].map(([k, v]) => `${k} ${v}駅`).join("・") || "なし"}`);
  if (arg("out")) writeFileSync(arg("out"), JSON.stringify({ rows: out, arAll, arEmpty, arBefore }, null, 1));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
