// scripts/audit-customer-read-chain.ts — 台帳 #795: 相手の読み（今の気持ち・迷い・決め手の残り・次の返事の予想）が、地図・ブレイン・書き手につながるまでを段ごとに数える（読むだけ・LLM なし）
// 2026-11-26 作業員L（竹内さん 11/26「地図のなかで相手を読む部分、相手の思考や相手は何て LINE 送ってくるのかも読んだうえにしているか・弱い部分は」
//   「ここ細分化して連携できるように・必要な土台はつくっておく形で」・統括役の割り振り）
//   段: ①読む（ブレインの判断の記録 digest.ms＝気持ち|不安|迷い|決め手の残り）②迷いの中身 ③決め手の残り（決めに行く場面の状態だけで分母も出す）
//       ④次の返事の予想（customer-reaction-predict・BRAIN_REACTION_PREDICT・試験の記録）⑤地図の駅・次の石・逆算の計画に結ぶ（コードのつながり）
//       ⑥書き手（writer_link:field:latent_kind）⑦当たり（scripts/audit-reaction-predict.ts の予想と次の束の一致・夜に回す）
//   段ごとの欄（地図の土台の表と同じ形）: 決まり・材料・物差し・統括に届くか・試験の問題。出すのは数だけ。日付で絞る（--days・既定 60）
// 実行: npx tsx --env-file=.env.local scripts/audit-customer-read-chain.ts [--days=60] [--json=<出力>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
/** 決めに行く場面の状態（決め手の残りが読めるはずの番）＝これ以外は「あと1点」が無い番が多い */
export const DECIDE_STATES: ReadonlySet<string> = new Set(["安くしたい", "迷い", "刺さっている", "抑えたい", "審査の不安", "不満・離れかけ", "先に取られる不安"]);
export type MsRow = { st: string; anx: string; hes: string; bl: string };
export function parseMs(ms: unknown): MsRow | null {
  if (typeof ms !== "string" || !ms) return null;
  const [st = "", anx = "", hes = "", bl = ""] = ms.split("|");
  return { st, anx, hes, bl };
}
const has = (x: string) => !!x && x !== "-";
export function readChainCounts(digests: ReadonlyArray<Record<string, unknown>>): { n: number; read: number; hes: number; blocker: number; decideN: number; decideBlocker: number; withRoute: number } {
  let read = 0, hes = 0, blocker = 0, decideN = 0, decideBlocker = 0, withRoute = 0;
  for (const d of digests) {
    const m = parseMs(d.ms); if (!m || !m.st) continue;
    read++; if (has(m.hes)) hes++; if (has(m.bl)) blocker++;
    if (DECIDE_STATES.has(m.st)) { decideN++; if (has(m.bl)) decideBlocker++; }
    if (d.ar) withRoute++;
  }
  return { n: digests.length, read, hes, blocker, decideN, decideBlocker, withRoute };
}

if (require.main === module) (async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const days = Number(arg("days", "60"));
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const ds: Array<Record<string, unknown>> = [];
  for (let from = 0; from < 30000; from += 1000) {
    const { data, error } = await sb.from("brain_decision_logs").select("digest").gte("created_at", since).neq("source", "test").order("created_at").range(from, from + 999);
    if (error) throw new Error(error.message);
    ds.push(...((data ?? []) as Array<{ digest: Record<string, unknown> | null }>).map((r) => r.digest ?? {}));
    if ((data ?? []).length < 1000) break;
  }
  const c = readChainCounts(ds);
  const { data: wi } = await sb.from("work_items").select("id, stage, exam_result").ilike("switch_name", "%REACTION_PREDICT%").limit(5);
  const rp = ((wi ?? []) as Array<{ id: number; stage: string; exam_result: string | null }>)[0];
  const { data: qd } = await sb.from("quality_daily").select("metric, value, n, day").like("metric", "writer_link:field:latent_kind:%").order("day", { ascending: false }).limit(4);
  const lk = (qd ?? []) as Array<{ metric: string; value: number | null; n: number | null }>;
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "—");
  const rows = [
    { stage: "① 読む（今の気持ち 12状態）", rules: "customer-mindset の MINDSET_STATES（決まり KB は無い）", material: "お客様の通（ブレインが読む）", measure: `digest.ms のある判断 ${c.read}/${c.n}（${pct(c.read, c.n)}）`, conductor: "入口には渡していない（入口は自分で重点を読む）", exam: "試験の問題の札に気持ちの欄は無い" },
    { stage: "② 迷いの中身", rules: "HESITATION_KINDS", material: "同上", measure: `${c.hes}/${c.read}（${pct(c.hes, c.read)}）`, conductor: "—", exam: "—" },
    { stage: "③ 決め手の残り", rules: "decide-gap（DECIDE_GAP 既定 on）", material: "同上", measure: `全部の番で ${c.blocker}/${c.read}（${pct(c.blocker, c.read)}）・決めに行く場面の状態だけで ${c.decideBlocker}/${c.decideN}（${pct(c.decideBlocker, c.decideN)}）`, conductor: "—", exam: "—" },
    { stage: "④ 次の返事の予想", rules: "customer-reaction-predict（数え表 customer-reaction-table-data）", material: "決まった計算（LLM なし）", measure: `BRAIN_REACTION_PREDICT=off・台帳 #${rp?.id ?? "?"} は ${rp?.stage ?? "?"}・試験の記録 ${rp?.exam_result ? "あり" : "なし"}`, conductor: "渡していない", exam: "無い" },
    { stage: "⑤ 地図の駅・次の石・逆算の計画に結ぶ", rules: "無い", material: "—", measure: `つながり 0（resolveRouteNode・NEXT_STONE・backplan は気持ちを読まない）・同じ番に気持ちと駅の記録がある ${c.withRoute}`, conductor: "—", exam: "—" },
    { stage: "⑥ 書き手", rules: "delivery-check の latent_kind", material: "ブレインの答えの欄", measure: lk.map((r) => `${r.metric.replace("writer_link:field:latent_kind:", "")} ${r.value ?? "—"}%（${r.n}）`).slice(0, 2).join("・") || "—", conductor: "—", exam: "—" },
    { stage: "⑦ 実際の次の返事で当たり", rules: "—", material: "—", measure: "scripts/audit-reaction-predict.ts（今夜・60日・LLM なし）＝毎日の数はまだ無い", conductor: "—", exam: "—" },
  ];
  console.log(`# 相手の読みがつながるまで（${days}日・判断の記録 ${c.n}）\n`);
  console.log("| 段 | 決まり | 材料 | 物差し（今の数） | 統括に届くか | 試験の問題 |\n|---|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.stage} | ${r.rules} | ${r.material} | ${r.measure} | ${r.conductor} | ${r.exam} |`);
  if (arg("json")) writeFileSync(arg("json"), JSON.stringify({ at: new Date().toISOString(), days, counts: c, rows }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
