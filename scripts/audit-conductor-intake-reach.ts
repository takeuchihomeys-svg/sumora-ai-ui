// scripts/audit-conductor-intake-reach.ts — 台帳 #747 の土台: 統括の入口（conductor_intake）の読みが、ブレインの判断に届くまでを段ごとに数える（読むだけ・LLM なし）
// 2026-11-26 作業員L（竹内さん 11/25 夜「統括ブレインなぜできるようになっていないのか・連携が弱いのかな？」「ここの統括のところ優先度かなり上げる」・統括役の割り振り）
//   段: ①入口を呼んだ（llm_usage_logs の conductor_intake・本番だけ） ②間に合った（判断の記録に digest.ci がある＝返す前の 4秒の待ちの内に答えた）
//       ③入口が読んだ中身がある（重点 fc・確認の順 co・駅 ar＝地図の決まった計算）
//       ④ブレインの材料に入った（今は重点の1行が内覧の場面だけ・印が無い＝数えられない段は「印なし」と出す）
//       ⑤ブレインの判断が入口と合った（入口が AIX の番と見た a1／返信と見た a0 × ブレインの digest.aix）
//   出すのは数だけ（会話の文・名前は読まない）。日付で絞る（--days・既定 14）
// 実行: npx tsx --env-file=.env.local scripts/audit-conductor-intake-reach.ts [--days=14] [--write]
import { createClient } from "@supabase/supabase-js";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type D = { digest: Record<string, unknown> | null; scene_key: string | null; created_at: string };

/** 段ごとの数（純関数・テストあり） */
export function intakeReachStages(rows: readonly D[], intakeCalls: number | null): Array<{ stage: string; n: number | null; of: number | null; note: string }> {
  const s = (d: D) => (d.digest ?? {}) as Record<string, unknown>;
  const ci = rows.filter((r) => typeof s(r).ci === "string");
  const a1 = ci.filter((r) => /\|a1/.test(String(s(r).ci))), a0 = ci.filter((r) => /\|a0/.test(String(s(r).ci)));
  const brainAix = (r: D) => !!String(s(r).aix ?? "").trim();
  const viewing = rows.filter((r) => r.scene_key === "viewing");
  return [
    { stage: "① 入口を呼んだ（本番の呼び出し）", n: intakeCalls, of: rows.length, note: "判断の記録の数と並べる（brain-sweep の呼び出しも入る）" },
    { stage: "② 間に合った（digest.ci あり）", n: ci.length, of: rows.length, note: "返す前の 4秒の待ちの内に答えた番。無い番は入口の読みがどこにも届かない" },
    { stage: "③ 重点（fc）", n: rows.filter((r) => s(r).fc).length, of: ci.length, note: "入口の focus_read" },
    { stage: "③ 確認の順（co）", n: rows.filter((r) => s(r).co).length, of: rows.length, note: "check-order の型（決まった計算・入口ではない）" },
    { stage: "③ 駅（ar）", n: rows.filter((r) => s(r).ar).length, of: rows.length, note: "地図の決まった計算（入口は駅を読んでいない・CONDUCTOR_INTAKE_ROUTE は off）" },
    { stage: "④ 重点がブレインの材料に入った（内覧の場面だけ）", n: null, of: viewing.filter((r) => s(r).fc).length, note: "印なし＝数えられない（CONDUCTOR_FOCUS_TO_BRAIN は内覧だけ・material_marks に欄が無い）" },
    { stage: "④ 確認の順・駅が入口の読みとしてブレインに入った", n: 0, of: rows.length, note: "入口の読みからは渡していない（並べ替えも無い）＝MATERIAL_PRIORITY で作る所" },
    { stage: "⑤ 入口が AIX の番と見た → ブレインも AIX", n: a1.filter(brainAix).length, of: a1.length, note: "" },
    { stage: "⑤ 入口が返信の番と見た → ブレインも返信", n: a0.filter((r) => !brainAix(r)).length, of: a0.length, note: "" },
  ];
}

if (require.main === module) (async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const days = Number(arg("days", "14"));
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const rows: D[] = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await sb.from("brain_decision_logs").select("digest, scene_key, created_at").gte("created_at", since).neq("source", "test").order("created_at").range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as D[]));
    if ((data ?? []).length < 1000) break;
  }
  const { count } = await sb.from("llm_usage_logs").select("id", { count: "exact", head: true }).gte("created_at", since).eq("action", "conductor_intake").not("route", "like", "script:%");
  const st = intakeReachStages(rows, count ?? null);
  console.log(`# 統括の入口の読みがブレインに届くまで（${days}日・判断の記録 ${rows.length}）\n`);
  console.log("| 段 | 数 | うち | 割合 | 注 |\n|---|---|---|---|---|");
  for (const x of st) console.log(`| ${x.stage} | ${x.n ?? "印なし"} | ${x.of ?? "—"} | ${x.n != null && x.of ? `${Math.round((x.n / x.of) * 1000) / 10}%` : "—"} | ${x.note} |`);
})().catch((e) => { console.error(e); process.exit(1); });
