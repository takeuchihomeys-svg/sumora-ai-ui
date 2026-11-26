// scripts/audit-scene-tree-wide.ts — 大きな地図の木を全部の会話の番に広げる（台帳 #804 p0・読むだけ・LLM なし・重い読み＝JST 22〜8時・試験の係と重ならない時間）
// 2026-11-27 作業員A（統括役の頼み: 一番の壁は n＝4段目 0/157）
//   元: 60〜120日の全部の会話（テスト・申込以降を外す）の、こちらの番（お客様の束の後の最初のスタッフの通）。書き手（staff_writer: takeuchi／employee）を付ける
//   駅: その番の前の一番新しい判断の記録の digest.ar（地図の駅）。細かい状態: substate-context（前提つき）。一手: その番の AIX（2時間の内）か返信の締めの型（reply-direction と同じ網）
//   お客様の次の通: 48時間の内の最初の束の種類（classifyCustomerBurst）・無ければ返事なし→追いの連絡（何日後に・どんな一手で）とその後に戻ったか
//   進み: 次の判断の記録の駅が申込へ近づいたか・申込まで: deal_outcomes の applied_at／screening_at
//   一手の正解は竹内さん本人の番＝竹内さんだけの木と全員の木を並べ、場面×お客様の次ごとに一番多い一手の向きが同じかを出す
// 実行: npx tsx --env-file=.env.local scripts/audit-scene-tree-wide.ts [--days=120] [--max-conv=600] [--out=<json>] [--write]
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { classifyCustomerBurst, REACTION_JA } from "../app/lib/customer-reaction-predict";
import { replyCloseKindOf } from "../app/lib/reply-direction";
import { substateInContext } from "../app/lib/substate-context";
import { buildSceneTree, treeStats, deadEnds, topGoalAct, returnPaths, type TreeEvent } from "../app/lib/scene-map-tree";
import { MAIN_ROUTE } from "../app/lib/apply-route-map";
import { nodeOfStage } from "./lib/guide-measure";
import { isTestConversation, isNoLineTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const POST = new Set(["applying", "screening", "contracted", "contract", "lost_after_screening"]);
type M = { sender: string; text: string | null; created_at: string; staff_writer: string | null; is_aix_generated: boolean | null };
type A = { aix_type: string | null; sent_at: string | null; created_at: string };
type D = { created_at: string; ar: string | null; sg: string | null; cp: string | null };
(async () => {
  const h = Number(new Date(Date.now() + 9 * 36e5).getUTCHours());
  if (h >= 8 && h < 22 && !process.argv.includes("--force-day")) { console.log("昼は回さない（重い読み・JST 22〜8時だけ）"); process.exit(0); }
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const since = new Date(Date.now() - Number(arg("days", "120")) * 864e5).toISOString();
  const { data: convs } = await sb.from("conversations").select("id,status").gte("updated_at", since).limit(Number(arg("max-conv", "600")));
  const all: Array<TreeEvent & { writer: string; follow?: { days: number; act: string; back: boolean } }> = [];
  let convN = 0;
  for (const c of (convs ?? []) as Array<{ id: string; status: string | null }>) {
    if (isTestConversation(c.id) || isNoLineTestConversation(c.id)) continue;
    const [{ data: ms }, { data: ax }, { data: ds }, { data: deal }] = await Promise.all([
      sb.from("messages").select("sender,text,created_at,staff_writer,is_aix_generated").eq("conversation_id", c.id).gte("created_at", since).order("created_at").limit(3000),
      sb.from("aix_usage_logs").select("aix_type,sent_at,created_at").eq("conversation_id", c.id).gte("created_at", since).limit(500),
      sb.from("brain_decision_logs").select("created_at,ar:digest->>ar,sg:digest->>sg,cp:digest->>cp").eq("conversation_id", c.id).gte("created_at", since).order("created_at").limit(2000),
      sb.from("deal_outcomes").select("applied_at,screening_at").eq("conversation_id", c.id).limit(5),
    ]);
    const M_ = (ms ?? []) as M[], A_ = (ax ?? []) as A[], D_ = (ds ?? []) as D[];
    const cut = ((deal ?? []) as Array<{ applied_at: string | null; screening_at: string | null }>).map((d) => d.applied_at ?? d.screening_at).filter(Boolean).sort()[0] ?? null;
    const reached = !!cut;
    const turns: number[] = [];
    for (let i = 1; i < M_.length; i++) if (M_[i].sender === "staff" && M_[i - 1].sender === "customer" && (!cut || M_[i].created_at < cut)) turns.push(i);
    if (!turns.length) continue;
    convN++;
    // 駅: 判断の記録の地図の駅（ar・11/23 から）が無い前の記録は、判断の段（sg／cp）を地図の駅に直す（audit-route-progress-takeuchi の guide-measure と同じ）
    const stationAt = (iso: string) => { const d = [...D_].reverse().find((x) => x.created_at <= iso && (x.ar || x.sg || x.cp)); if (!d) return null; if (d.ar) return String(d.ar).split("|"); const n = nodeOfStage(d.sg ?? d.cp); return n ? [n, ""] : null; };
    const actAt = (i: number) => {
      const t0 = Date.parse(M_[i].created_at); let k = i; while (k < M_.length && M_[k].sender !== "customer") k++;
      const end = k < M_.length ? Date.parse(M_[k].created_at) : Infinity;
      const a = A_.find((x) => { const t = Date.parse(x.sent_at ?? x.created_at); return t >= t0 - 60_000 && t < Math.min(end, t0 + 2 * 36e5); });
      const own = M_.slice(i, k).filter((m) => !m.is_aix_generated).map((m) => String(m.text ?? "")).join("\n");
      return { act: a?.aix_type ? `aix:${String(a.aix_type).split("/")[0]}` : `reply:${replyCloseKindOf(own)}`, k };
    };
    turns.forEach((i, ti) => {
      const at = M_[i].created_at;
      if (c.status && POST.has(c.status) && !cut) return;
      const st = stationAt(at); const node = st?.[0] || "（駅不明）"; const branch = st?.[1] || "";
      const station = branch ? `分:${branch}` : node;
      let b = i - 1; const burst: string[] = []; while (b >= 0 && M_[b].sender === "customer") { burst.unshift(String(M_[b].text ?? "")); b--; }
      const sentBefore = new Set(A_.filter((x) => (x.sent_at ?? x.created_at) < at).map((x) => String(x.aix_type ?? "").split("/")[0]));
      const sub = substateInContext(burst.join("\n"), { estimateSent: sentBefore.has("estimate_sheet"), propertiesSent: ["property_send", "property_recommendation", "property_check_result"].some((x) => sentBefore.has(x)) }, { SUBSTATE_CONTEXT: "on" }).id;
      const { k } = actAt(i);
      const t0 = Date.parse(at);
      let reply = "返事なし"; let nextAct: string | null = null; let follow: { days: number; act: string; back: boolean } | undefined;
      if (k < M_.length && Date.parse(M_[k].created_at) - t0 <= 48 * 36e5) {
        const rb: string[] = []; for (let j = k; j < M_.length && M_[j].sender === "customer"; j++) rb.push(String(M_[j].text ?? ""));
        reply = REACTION_JA[classifyCustomerBurst(rb)];
        const ni = turns[ti + 1]; if (ni != null && Date.parse(M_[ni].created_at) - t0 <= 4 * 864e5) nextAct = actAt(ni).act;
      } else {
        // 返事なし → 追いの連絡（48時間より後の最初のスタッフの通）と、その後48時間の内にお客様が戻ったか
        const f = M_.findIndex((m, x) => x > i && m.sender === "staff" && Date.parse(m.created_at) - t0 > 48 * 36e5 && Date.parse(m.created_at) - t0 <= 30 * 864e5 && (!cut || m.created_at < cut));
        if (f >= 0) { const fa = actAt(f).act; const ft = Date.parse(M_[f].created_at); const back = M_.some((m) => m.sender === "customer" && Date.parse(m.created_at) > ft && Date.parse(m.created_at) - ft <= 48 * 36e5); nextAct = fa; follow = { days: Math.round((ft - t0) / 864e5), act: fa, back }; }
      }
      const nd = stationAt(new Date(t0 + 4 * 864e5).toISOString());
      const advanced = !!nd && MAIN_ROUTE.indexOf((nd[0] || "") as never) > MAIN_ROUTE.indexOf(node as never) && MAIN_ROUTE.indexOf(node as never) >= 0;
      all.push({ station, sub, reply, act: nextAct, advanced: follow ? follow.back : advanced, reached, writer: M_[i].staff_writer ?? "?", ...(follow ? { follow } : {}) });
    });
  }
  const tk = all.filter((e) => e.writer === "takeuchi");
  const tAll = buildSceneTree(all), tTk = buildSceneTree(tk);
  const sAll = treeStats(tAll), sTk = treeStats(tTk);
  // 一手の向き: 場面×お客様の次（3段目）で、竹内さんだけの一番多い一手と全員の一番多い一手が同じか（両方 n≥5）
  const fam = (a: string | null) => (!a ? null : a.startsWith("aix:") ? a : a.startsWith("reply:invite") ? "reply:invite" : a);
  const top = (n: { children: Record<string, number> }) => Object.entries(n.children).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  let same = 0, cmp = 0;
  for (const [key, n] of tTk) { if (n.depth !== 3 || n.n < 5) continue; const a = tAll.get(key); if (!a || a.n < 5) continue; cmp++; if (fam(top(n)) === fam(top(a))) same++; }
  const fol = all.filter((e) => e.follow); const folBack = fol.filter((e) => e.follow!.back).length;
  const byFolAct = new Map<string, { n: number; back: number; days: number[] }>(); for (const e of fol) { const o = byFolAct.get(e.follow!.act) ?? { n: 0, back: 0, days: [] }; o.n++; if (e.follow!.back) o.back++; o.days.push(e.follow!.days); byFolAct.set(e.follow!.act, o); }
  const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const de = deadEnds(tAll);
  const lines = [
    `■ 大きな地図の木（広げた元・${arg("days", "120")}日）: 会話 ${convN}・番 ${all.length}（竹内さん本人 ${tk.length}）`,
    `  全員: 節 ${sAll.nodes}・n≥10 ${sAll.dense}（${sAll.denseShare}%）・段ごと ${Object.entries(sAll.byDepth).map(([d, o]) => `${d}段 ${o.dense}/${o.nodes}`).join("・")}`,
    `  竹内さん本人: 節 ${sTk.nodes}・n≥10 ${sTk.dense}（${sTk.denseShare}%）`,
    `  一手の向き（場面×お客様の次・両方 n≥5）: 竹内さんだけと全員で同じ ${same}/${cmp}`,
    `  返事なし → 追いの連絡: ${fol.length}番・戻った ${folBack}（${fol.length ? Math.round((folBack / fol.length) * 1000) / 10 : 0}%）｜一手ごと ${[...byFolAct].sort((a, b) => b[1].n - a[1].n).slice(0, 5).map(([a, o]) => `${a} ${o.back}/${o.n}（中央 ${med(o.days)}日後）`).join("・")}`,
    `  ゴールへの道（駅ごと・全員）: ${[...tAll.values()].filter((x) => x.depth === 1).sort((a, b) => b.n - a.n).slice(0, 10).map((x) => `${x.key} ${x.n ? Math.round((x.reached / x.n) * 1000) / 10 : 0}%（${x.n}）→ ${topGoalAct(x) ?? "なし"}`).join("｜")}`,
    `  戻る道（全員）: ${returnPaths(all).map((r) => `${r.reply} ${r.back}/${r.n}`).join("・")}`,
    `  行き止まり（全員）: 申込への道が無い節 ${de.noGoal.length}・n が少なく分からない節（2段目まで） ${de.unknown.length}`,
    `  状態なしの番: ${all.filter((e) => !e.sub).length}/${all.length}`,
  ];
  console.log(lines.join("\n"));
  const out = arg("out", ""); if (out) writeFileSync(out, JSON.stringify({ stats: { all: sAll, takeuchi: sTk, same, cmp, follow: { n: fol.length, back: folBack } }, nodesAll: [...tAll.values()], nodesTk: [...tTk.values()], deadEnds: de }, null, 2));
  if (process.argv.includes("--write")) {
    const day = new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10);
    const qd = [
      { day, metric: "map:scene_tree:dense_share", scope: "all", value: sAll.denseShare, n: sAll.nodes, detail: { byDepth: sAll.byDepth, turns: all.length, convs: convN }, source: "scripts/audit-scene-tree-wide.ts（作業員A・#804）" },
      { day, metric: "map:scene_tree:dense_share", scope: "takeuchi", value: sTk.denseShare, n: sTk.nodes, source: "scripts/audit-scene-tree-wide.ts（作業員A・#804）" },
      { day, metric: "map:scene_tree:dead_ends", scope: "all", value: de.noGoal.length + de.unknown.length, n: sAll.nodes, detail: { noGoal: de.noGoal.length, unknown: de.unknown.length }, source: "scripts/audit-scene-tree-wide.ts（作業員A・#804）" },
      { day, metric: "map:scene_tree:follow_back", scope: "all", value: fol.length ? Math.round((folBack / fol.length) * 1000) / 10 : null, n: fol.length, source: "scripts/audit-scene-tree-wide.ts（作業員A・#804）" },
    ];
    const { error } = await sb.from("quality_daily").upsert(qd, { onConflict: "day,metric,scope" });
    if (error) throw new Error(error.message);
    console.log(`書いた: quality_daily ${qd.length}行（${day}）`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
