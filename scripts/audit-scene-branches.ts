// scripts/audit-scene-branches.ts — 場面ごとの分かれ道の表（竹内さん 11/27「お客さんの状況を把握してそこから細分化して何パターンか読めるように」・読むだけ・LLM なし）
// 2026-11-27 作業員A（統括役の頼み）: 場面（駅×細かい状態）ごとに、竹内さん本人の一手の後にお客様が実際に送ってきた次の通を種類に分け（customer-reaction-predict の classifyCustomerBurst と同じ網）、
//   その種類ごとに竹内さんの次の一手（同じ会話の次の番の一手）を数える＝「この場面ではお客様の次は何通りかに分かれ、それぞれで竹内さんはこう動く」の読み筋。
//   当てる予想（反応の予想）ではなく、分かれ道を並べて備える表。本文は出さない（数と種類だけ）。重い読み（会話ごとに通を読む）＝JST 22〜8時
// 実行: npx tsx --env-file=.env.local scripts/audit-scene-branches.ts --from=<照らしの json> [--out=<表の json>] [--top=3]
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { classifyCustomerBurst, REACTION_JA, type ReactionCat } from "../app/lib/customer-reaction-predict";
import { buildSceneTree, treeStats, returnPaths, deadEnds, topGoalAct, type TreeEvent } from "../app/lib/scene-map-tree";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type Row = { conv: string; at: string; node: string | null; branch: string | null; sub1?: string | null; act: string; agree: string; outcome?: string | null; reached?: boolean };
(async () => {
  const rows = (JSON.parse(readFileSync(arg("from", ""), "utf8")) as Row[]).filter((r) => r.agree !== "no_next");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const byConv = new Map<string, Row[]>(); for (const r of rows) byConv.set(r.conv, [...(byConv.get(r.conv) ?? []), r]);
  type Ev = { scene: string; reply: ReactionCat; next: string | null };
  const evs: Ev[] = []; const tev: TreeEvent[] = [];
  for (const [c, rs] of byConv) {
    rs.sort((a, b) => a.at.localeCompare(b.at));
    const lo = rs[0].at, hi = new Date(Date.parse(rs[rs.length - 1].at) + 3 * 864e5).toISOString();
    const { data: conv } = await sb.from("conversations").select("id").like("id", `${c}%`).limit(1);
    const id = (conv ?? [])[0]?.id; if (!id) continue;
    const { data } = await sb.from("messages").select("sender,text,created_at").eq("conversation_id", id).gte("created_at", lo).lte("created_at", hi).order("created_at").limit(2000);
    const ms = (data ?? []) as Array<{ sender: string; text: string | null; created_at: string }>;
    rs.forEach((r, i) => {
      const t = Date.parse(r.at);
      let k = ms.findIndex((m) => Date.parse(m.created_at) > t + 1000 && m.sender === "customer");
      // 竹内さんの通の続きの後、最初のお客様の束（48時間の内）
      let reply: ReactionCat = "silent";
      if (k >= 0 && Date.parse(ms[k].created_at) - t <= 48 * 36e5) { const b: string[] = []; for (let j = k; j < ms.length && ms[j].sender === "customer"; j++) b.push(String(ms[j].text ?? "")); reply = classifyCustomerBurst(b); }
      const nx = rs[i + 1] && Date.parse(rs[i + 1].at) - t <= 4 * 864e5 ? rs[i + 1].act : null;
      const scene = `${r.branch ? `分:${r.branch}` : r.node}${r.sub1 ? `×${r.sub1}` : ""}`;
      evs.push({ scene, reply, next: reply === "silent" ? null : nx });
      // 段の順: 駅 → 細かい状態 → お客様の次の通 → 竹内さんの次の一手 → その一手の後の進み（次の番の outcome）
      const nr = rs[i + 1] && Date.parse(rs[i + 1].at) - t <= 4 * 864e5 && reply !== "silent" ? rs[i + 1] : null;
      tev.push({ station: r.branch ? `分:${r.branch}` : String(r.node), sub: r.sub1 ?? null, reply: REACTION_JA[reply], act: nr ? nr.act : null, advanced: nr ? nr.outcome === "advanced" : false, reached: !!r.reached });
    });
  }
  const scenes = new Map<string, Ev[]>(); for (const e of evs) scenes.set(e.scene, [...(scenes.get(e.scene) ?? []), e]);
  const counted = evs.filter((e) => e.reply !== "silent" ? e.next : true).length;
  const kinds = new Set(evs.map((e) => e.reply));
  const top = [...scenes].sort((a, b) => b[1].length - a[1].length).slice(0, Number(arg("top", "3")));
  const lines = [`■ 場面ごとの分かれ道（竹内さん本人の番 ${evs.length}）: 場面 ${scenes.size}・お客様の次の通の種類 ${kinds.size}（${[...kinds].map((k) => REACTION_JA[k]).join("・")}）・次の一手まで数えられる番 ${counted}（返事なしは竹内さんの次の一手が要らない分かれ道として数える）`];
  for (const [s, es] of top) {
    lines.push(`\n## ${s}（${es.length}番）`);
    const by = new Map<ReactionCat, Ev[]>(); for (const e of es) by.set(e.reply, [...(by.get(e.reply) ?? []), e]);
    for (const [k, xs] of [...by].sort((a, b) => b[1].length - a[1].length)) {
      const c: Record<string, number> = {}; for (const x of xs) if (x.next) c[x.next] = (c[x.next] ?? 0) + 1;
      lines.push(`  お客様の次: ${REACTION_JA[k]} ${xs.length} → 竹内さんの次の一手: ${Object.entries(c).sort((a, b) => b[1] - a[1]).map(([a, n]) => `${a} ${n}`).join("・") || "（次の番が無い・4日より後）"}`);
    }
  }
  const out = arg("out", ""); if (out) writeFileSync(out, JSON.stringify([...scenes].map(([s, es]) => ({ scene: s, n: es.length, branches: es.reduce((a, e) => { (a[e.reply] ??= {} as Record<string, number>); if (e.next) a[e.reply][e.next] = (a[e.reply][e.next] ?? 0) + 1; else a[e.reply]["-"] = (a[e.reply]["-"] ?? 0) + 1; return a; }, {} as Record<string, Record<string, number>>) })), null, 2));
  // 2026-11-27 #804: 大きな地図の木・ゴールへの道・戻る道・行き止まり
  const tree = buildSceneTree(tev); const ts = treeStats(tree); const rp = returnPaths(tev); const de = deadEnds(tree);
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  lines.push(`\n■ 大きな地図の木: 会話 ${byConv.size}・番 ${tev.length}・節 ${ts.nodes}・n≥10 の節 ${ts.dense}（${ts.denseShare}%）・段ごと ${Object.entries(ts.byDepth).map(([d, o]) => `${d}段 ${o.dense}/${o.nodes}`).join("・")}`);
  lines.push(`■ ゴールへの道（駅ごと・申込まで行った割合と一番多くつながった一手）: ${[...tree.values()].filter((x) => x.depth === 1).sort((a, b) => b.n - a.n).map((x) => `${x.key} ${pct(x.reached, x.n)}%（${x.n}）→ ${topGoalAct(x) ?? "なし"}`).join("｜")}`);
  lines.push(`■ 戻る道（離れる分かれ道ごと・戻せた割合・竹内さんの一手の上位）: ${rp.map((r) => `${r.reply} ${r.back}/${r.n}（${r.acts.slice(0, 3).map((a) => `${a.act} ${a.back}/${a.n}`).join("・")}）`).join("｜")}`);
  lines.push(`■ 行き止まり: 申込への道が無い節（n≥10） ${de.noGoal.length}${de.noGoal.length ? `（${de.noGoal.join("・")}）` : ""}・n が少なく分からない節（2段目まで） ${de.unknown.length}`);
  const treeOut = arg("tree-out", ""); if (treeOut) writeFileSync(treeOut, JSON.stringify({ nodes: [...tree.values()], returns: rp, deadEnds: de }, null, 2));
  console.log(lines.join("\n"));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
