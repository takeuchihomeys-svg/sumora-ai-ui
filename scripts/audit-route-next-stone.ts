// scripts/audit-route-next-stone.ts — 竹内さん本人の番とブレインの判断が、駅の「次の石」に向かったか・飛ばしたか（竹内さん 11/26 昼・読むだけ・LLM なし・DB は --write の時だけ書く）
// 2026-11-26 作業員A: 地図の照らしの json（audit-route-progress-takeuchi --json の行・竹内さん本人の番）の act を次の石で分け、
//   同じ番の直前のブレインの判断（brain_decision_logs の digest.aix・番の前30分の一番新しい物）も同じ表で分ける。ブレインの返信は向きが記録に無い＝動かさない に数える
//   本文は読まない（会話の id と時刻・AIX の種類だけ）。会話ごとに日付で絞って読む（軽い読み）
// 実行: npx tsx --env-file=.env.local scripts/audit-route-next-stone.ts --from=<照らしの json> [--write]
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { stoneMoveOf, stoneShare, STONE_JA, NEXT_STONE, STONE_TOOLS, aixKindMissOf, type StoneMove } from "../app/lib/route-next-stone";
import { actTarget } from "./lib/route-progress";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type Row = { conv: string; at: string; node: string | null; branch: string | null; act: string; outcome: string | null; agree: string };
(async () => {
  const rows = (JSON.parse(readFileSync(arg("from", ""), "utf8")) as Row[]).filter((r) => !r.branch && r.agree !== "no_next");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  // ブレインの判断（会話ごとに、番の時刻の幅で読む）
  const byConv = new Map<string, Row[]>(); for (const r of rows) byConv.set(r.conv, [...(byConv.get(r.conv) ?? []), r]);
  const brainAct = new Map<Row, string | null>();
  for (const [c, rs] of byConv) {
    const lo = new Date(Math.min(...rs.map((r) => Date.parse(r.at))) - 30 * 60_000).toISOString(), hi = new Date(Math.max(...rs.map((r) => Date.parse(r.at))) + 1000).toISOString();
    const { data } = await sb.from("brain_decision_logs").select("conversation_id,created_at,aix:digest->>aix,rdir:digest->>rdir").like("conversation_id", `${c}%`).gte("created_at", lo).lte("created_at", hi).order("created_at").limit(500);
    const ds = (data ?? []) as Array<{ created_at: string; aix: string | null; rdir: string | null }>;
    for (const r of rs) {
      const t = Date.parse(r.at); const d = [...ds].reverse().find((x) => Date.parse(x.created_at) <= t && t - Date.parse(x.created_at) <= 30 * 60_000);
      // 2026-11-26 #787: 返信の番は判断の記録の rdir（下書きの締めの型・決まった計算）で向きが分かる＝無い前の記録は動かさないに数える
      brainAct.set(r, d ? (d.aix && d.aix.trim() ? `aix:${d.aix.trim().split("/")[0]}` : `reply:${d.rdir ?? ""}`) : null);
    }
  }
  const tk = rows.map((r) => ({ r, m: stoneMoveOf(r.node, actTarget(r.act)) }));
  const br = rows.filter((r) => brainAct.get(r) != null).map((r) => ({ r, m: stoneMoveOf(r.node, actTarget(String(brainAct.get(r)))) }));
  const cnt = (xs: Array<{ m: StoneMove }>) => { const c: Record<string, number> = {}; for (const x of xs) c[x.m] = (c[x.m] ?? 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${STONE_JA[k as StoneMove]} ${v}`).join("・"); };
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const ts = stoneShare(tk.map((x) => x.m)), bs = stoneShare(br.map((x) => x.m));
  console.log(`■ 次の石（本線の駅・竹内さん本人の番 ${rows.length}）`);
  console.log(`  竹内さん: 一歩ずつ ${ts.step}/${ts.n}（${pct(ts.step, ts.n) ?? "—"}%）・先の仕込み ${ts.plant}・申込へ飛ばした ${ts.skip}｜${cnt(tk)}`);
  console.log(`  ブレイン（同じ番の直前の判断が残る ${br.length}）: 一歩ずつ ${bs.step}/${bs.n}（${pct(bs.step, bs.n) ?? "—"}%）・先の仕込み ${bs.plant}・申込へ飛ばした ${bs.skip}（返信の向きは判断の記録の rdir＝#787・無い前の記録は動かさないに数える）｜${cnt(br)}`);
  // 次の石へ向かった番の進み（今の主の数と並べる）
  const adv = (xs: Array<{ r: Row; m: StoneMove }>, m: StoneMove[]) => { const s = xs.filter((x) => m.includes(x.m)); return `${s.filter((x) => x.r.outcome === "advanced").length}/${s.length}`; };
  console.log(`  竹内さんの番の進み: 次の石へ・約束 ${adv(tk, ["next_stone", "promise"])}・先の仕込み ${adv(tk, ["plant_ahead"])}・申込へ飛ばした ${adv(tk, ["skip_apply"])}・動かさない ${adv(tk, ["hold"])}・同じ駅 ${adv(tk, ["same"])}`);
  console.log(`\n## 駅ごと（竹内さん 一歩ずつ／申込へ飛ばした／n｜ブレイン 一歩ずつ／申込へ飛ばした／n）`);
  for (const node of Object.keys(NEXT_STONE)) {
    const a = tk.filter((x) => x.r.node === node), b = br.filter((x) => x.r.node === node);
    if (!a.length) continue;
    const sa = stoneShare(a.map((x) => x.m)), sbb = stoneShare(b.map((x) => x.m));
    console.log(`  ${node}（次の石: ${NEXT_STONE[node as keyof typeof NEXT_STONE]?.label}）: 竹内さん ${sa.step}/${sa.skip}/${sa.n}｜ブレイン ${sbb.step}/${sbb.skip}/${sbb.n}`);
  }
  const skipB = br.filter((x) => x.m === "skip_apply" || x.m === "plant_ahead");
  if (skipB.length) { const c: Record<string, number> = {}; for (const x of skipB) { const k = `${x.r.node}→${brainAct.get(x.r)}`; c[k] = (c[k] ?? 0) + 1; } console.log(`\n## ブレインが次の石より先へ置いた型: ${Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}（竹内さんは同じ番で: ${cnt(skipB.map((x) => ({ m: stoneMoveOf(x.r.node, actTarget(x.r.act)) })))}）`); }
  // 2026-11-26 作業員A（竹内さん「AIX のことも組み合わせて」）: ① 駅ごとに竹内さんが次の石を進めた一手 ② 石は合っているが AIX の種類が違う番
  console.log("\n## 駅ごとに次の石を進めた竹内さんの一手（多い順・括弧は進んだ番）｜表の道具（STONE_TOOLS）");
  for (const node of Object.keys(NEXT_STONE)) {
    const c: Record<string, { n: number; a: number }> = {};
    for (const x of tk) if (x.r.node === node && (x.m === "next_stone" || x.m === "promise" || x.m === "plant_ahead")) { const o = (c[x.r.act] ??= { n: 0, a: 0 }); o.n++; if (x.r.outcome === "advanced") o.a++; }
    const tl = STONE_TOOLS[node as keyof typeof STONE_TOOLS];
    if (Object.keys(c).length) console.log(`  ${node}: ${Object.entries(c).sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `${k} ${v.n}(${v.a})`).join("・")}｜道具 返信 ${tl?.reply.join("/") || "—"}・AIX ${tl?.aix.join("/") || "—"}`);
  }
  const kindMiss = br.filter((x) => aixKindMissOf(x.r.node, x.r.act, String(brainAct.get(x.r)), actTarget));
  console.log(`  石は合っているが AIX の種類が違う（ブレイン×竹内さん・両方 AIX の番）: ${kindMiss.length}${kindMiss.length ? `（${kindMiss.map((x) => `${x.r.node}: 竹内さん ${x.r.act}／ブレイン ${brainAct.get(x.r)}`).join("・")}）` : ""}`);
  if (process.argv.includes("--write")) {
    const day = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    const qd = [
      { day, metric: "route:next_stone_step", scope: "takeuchi", value: pct(ts.step, ts.n), n: ts.n, detail: { plant: ts.plant, skip_apply: ts.skip }, source: "scripts/audit-route-next-stone.ts（作業員A・竹内さん 11/26）" },
      { day, metric: "route:next_stone_step", scope: "brain", value: pct(bs.step, bs.n), n: bs.n, detail: { plant: bs.plant, skip_apply: bs.skip, reply_dir: "none", aix_kind_miss: kindMiss.length }, source: "scripts/audit-route-next-stone.ts（作業員A・竹内さん 11/26）" },
    ];
    const { error } = await sb.from("quality_daily").upsert(qd, { onConflict: "day,metric,scope" });
    if (error) throw new Error(error.message);
    console.log(`書いた: quality_daily ${qd.length}行（${day}）`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
