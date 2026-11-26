// scripts/audit-chain-patterns.ts — 連鎖の型を竹内さん本人の番から数え、型が当てはまった番でブレインの一手が竹内さんと合った割合を出す（読むだけ・LLM なし・DB は --write の時だけ書く）
// 2026-11-26 作業員A（竹内さん 11/26「パズルのように組み合わせて連鎖させていく」）。照らしの json（audit-route-progress-takeuchi --json）を読む。
//   ブレインの一手は brain_decision_logs の digest.aix（番の前30分の一番新しい判断・会話ごとに日付で絞る）。返信は向きが記録に無い＝「返信」として比べる（竹内さんも返信なら合う）
// 実行: npx tsx --env-file=.env.local scripts/audit-chain-patterns.ts --from=<json> [--min-n=5] [--min-lift=20] [--out=<型の json>] [--write]
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { featuresOf, chainPatternsOf, comboKeysOf } from "../app/lib/chain-patterns";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type Row = { conv: string; at: string; node: string | null; branch: string | null; sub1?: string | null; act: string; agree: string; sentBefore?: Record<string, string> };
(async () => {
  const rows = (JSON.parse(readFileSync(arg("from", ""), "utf8")) as Row[]).filter((r) => r.agree !== "no_next");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const byConv = new Map<string, Row[]>(); for (const r of rows) byConv.set(r.conv, [...(byConv.get(r.conv) ?? []), r]);
  // 2026-11-26 作業員L と合わせた: 気持ち＝番の時刻より前で一番新しい判断の記録の digest.ms の「|」の前（L の audit-mindset-station-move と同じ読み方）・ブレインの一手＝番の前30分の判断
  const brain = new Map<Row, string>(), ms = new Map<Row, string>();
  for (const [c, rs] of byConv) {
    const lo = new Date(Math.min(...rs.map((r) => Date.parse(r.at))) - 14 * 864e5).toISOString(), hi = new Date(Math.max(...rs.map((r) => Date.parse(r.at))) + 1000).toISOString();
    const { data } = await sb.from("brain_decision_logs").select("created_at,source,aix:digest->>aix,ms:digest->>ms").like("conversation_id", `${c}%`).gte("created_at", lo).lte("created_at", hi).order("created_at").limit(1000);
    const ds = ((data ?? []) as Array<{ created_at: string; source: string | null; aix: string | null; ms: string | null }>).filter((x) => x.source !== "test");
    for (const r of rs) {
      const t = Date.parse(r.at); const before = ds.filter((x) => Date.parse(x.created_at) <= t);
      const d = [...before].reverse().find((x) => t - Date.parse(x.created_at) <= 30 * 60_000); if (d) brain.set(r, d.aix && d.aix.trim() ? `aix:${d.aix.trim().split("/")[0]}` : "reply");
      const m = [...before].reverse().find((x) => x.ms); if (m?.ms) ms.set(r, String(m.ms).split("|")[0]);
    }
  }
  const tr = rows.map((r) => ({ r, f: featuresOf({ ...r, mindset: ms.get(r) ?? null }), act: r.act }));
  const pats = chainPatternsOf(tr, Number(arg("min-n", "5")), Number(arg("min-lift", "20")));
  console.log(`■ 連鎖の型（竹内さん本人の番 ${rows.length}・組 n≥${arg("min-n", "5")}・駅だけより +${arg("min-lift", "20")}pt）: ${pats.length}`);
  for (const p of pats.slice(0, 15)) console.log(`  ${p.parts.join("＋")} → ${p.move} ${p.share}%（${p.n}番）・駅だけ ${p.stationShare}%・+${p.lift}`);
  const out = arg("out", ""); if (out) writeFileSync(out, JSON.stringify(pats, null, 2));
  // ③ 物差し: 型が当てはまった番／当てはまらない番で、ブレインの一手が竹内さんと同じ（AIX は種類・返信は返信どうし）割合（ブレインの一手は上で読んだ）
  console.log(`  気持ちの印が付いた番: ${ms.size}/${rows.length}`);
  const pk = new Set(pats.map((p) => p.key));
  const same = (r: Row) => { const b = brain.get(r)!; return r.act.startsWith("aix:") ? b === r.act : b === "reply"; };
  const withB = tr.filter((x) => brain.has(x.r));
  const hit = withB.filter((x) => comboKeysOf(x.f).some((k) => pk.has(k))), miss = withB.filter((x) => !comboKeysOf(x.f).some((k) => pk.has(k)));
  const rate = (xs: typeof withB) => (xs.length ? Math.round((xs.filter((x) => same(x.r)).length / xs.length) * 1000) / 10 : null);
  console.log(`\n■ 物差し（ブレインの判断が残る ${withB.length}番）: 型が当てはまった番 ${hit.length}・合う ${rate(hit) ?? "—"}%｜当てはまらない番 ${miss.length}・合う ${rate(miss) ?? "—"}%`);
  const hitMiss = hit.filter((x) => !same(x.r));
  if (hitMiss.length) console.log(`  型が当てはまったのに違った番: ${hitMiss.slice(0, 8).map((x) => `${x.r.conv}@${x.r.at.slice(5, 16)} 竹内さん ${x.r.act}／ブレイン ${brain.get(x.r)}`).join("・")}`);
  if (process.argv.includes("--write")) {
    const day = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    const qd = [
      { day, metric: "chain:patterns", scope: "takeuchi", value: pats.length, n: rows.length, source: "scripts/audit-chain-patterns.ts（作業員A）" },
      { day, metric: "chain:brain_match_hit", scope: "brain", value: rate(hit), n: hit.length, detail: { miss_rate: rate(miss), miss_n: miss.length }, source: "scripts/audit-chain-patterns.ts（作業員A）" },
    ];
    const { error } = await sb.from("quality_daily").upsert(qd, { onConflict: "day,metric,scope" });
    if (error) throw new Error(error.message);
    console.log(`書いた: quality_daily ${qd.length}行（${day}）`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
