// scripts/audit-off-switch-inventory.ts — 既定 off のスイッチの棚卸し（読むだけ・LLM なし・台帳と試験の結果の文だけ）
// 2026-11-26 作業員L（竹内さん P374「まだ off の部分も統括の土台をちゃんと細分化して…on にできるものも多いのでは」・統括役の頼み）
//   台帳（work_items）でスイッチの名前がある・まだ on でない・閉じていない行を、off の理由で分ける:
//     ①試験がまだ（試験の結果の欄が空）②悪化あり（結果に悪化の数が 1 以上・止めた）③材料・土台が足りない（blocker・次の一手に 材料・土台・欄が無い 等）
//     ④竹内さん待ち（段が waiting_owner・blocker に竹内さん）⑤忘れ（試験で悪化0・合格なのに on にしていない）
//   コードの既定（その名前が app/ scripts/ で「!== "off"」＝既定 on の形か）も見る＝台帳が古いだけで、もう on の物は「台帳の直し」に分ける
// 実行: npx tsx --env-file=.env.local scripts/audit-off-switch-inventory.ts [--json=<出力>]
import { createClient } from "@supabase/supabase-js";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type W = { id: number; title: string; owner: string | null; stage: string; switch_name: string; switch_default: string | null; exam_result: string | null; blocker: string | null; next_step: string | null; updated_at: string };
export type OffReason = "not_tested" | "worse" | "material" | "owner_wait" | "forgot" | "already_on";

/** 既定 on の形（コードの中で「(env.X ?? "")...!== "off"」） */
function codeText(dir: string): string {
  let out = "";
  const walk = (d: string) => { for (const f of readdirSync(d)) { if (f === "node_modules" || f.startsWith(".") || f === "__tests__") continue; const p = join(d, f); const st = statSync(p); if (st.isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) out += readFileSync(p, "utf8") + "\n"; } };
  for (const d of ["app/lib", "app/api", "scripts/lib"]) { try { walk(d); } catch { /* 無い */ } }
  return out;
}
export function defaultOnInCode(name: string, code: string): boolean {
  const re = new RegExp(`${name}\\s*\\?\\?\\s*""\\)[^\\n]{0,60}!==\\s*"off"`);
  return re.test(code);
}
export function offReasonOf(w: Pick<W, "stage" | "exam_result" | "blocker" | "next_step">, onInCode: boolean): OffReason {
  if (onInCode) return "already_on";
  const ex = String(w.exam_result ?? ""), bl = String(w.blocker ?? ""), nx = String(w.next_step ?? "");
  if (w.stage === "waiting_owner" || /竹内さん(?:の)?(?:決め|確認|返事|待ち)|竹内さんに(?:聞く|確認)/.test(bl)) return "owner_wait";
  const worseN = [...ex.matchAll(/悪化\s*(\d+)/g)].map((m) => Number(m[1]));
  if (worseN.some((n) => n > 0) || /悪化あり|悪くなった|止めた/.test(ex)) return "worse";
  if (/材料|土台|欄が無い|配線が無い|記録が無い|データが無い|n が足りない/.test(bl + nx) && !/悪化\s*0|合格/.test(ex)) return "material";
  if (!ex.trim()) return "not_tested";
  // 「悪化0とは言わない」（比べた問題が少ない）・下書きの段がまだ は試験がまだ・狙いの問題の道が下がった は悪化
  if (/悪化0とは言わない|比べた問題が少ない|draft の段はまだ/.test(ex)) return "not_tested";
  if (/狙いの[^。]{0,30}→今 0|前 \d+\/\d+→今 0\//.test(ex)) return "worse";
  if (/悪化\s*0|悪化0|合格|悪化なし|worse 0/.test(ex)) return "forgot";
  return "not_tested";
}

if (require.main === module) (async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const { data, error } = await sb.from("work_items").select("id, title, owner, stage, switch_name, switch_default, exam_result, blocker, next_step, updated_at")
    .not("switch_name", "is", null).neq("switch_name", "").not("stage", "in", "(done,dropped,on)").limit(1000);
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as W[]).filter((w) => (w.switch_default ?? "off") !== "on");
  const code = codeText(".");
  const out = rows.map((w) => { const sws = w.switch_name.split(/[,、・\s]+/).filter((x) => /^[A-Z][A-Z0-9_]+$/.test(x)); const on = sws.length > 0 && sws.every((s) => defaultOnInCode(s, code)); return { ...w, reason: offReasonOf(w, on) }; });
  const JA: Record<OffReason, string> = { not_tested: "①試験がまだ", worse: "②悪化あり", material: "③材料・土台が足りない", owner_wait: "④竹内さん待ち", forgot: "⑤忘れ（悪化0・合格なのに off）", already_on: "（コードはもう既定 on＝台帳の直し）" };
  console.log(`# 既定 off のスイッチの棚卸し（台帳 ${out.length}行・スイッチの名前あり・閉じていない）\n`);
  console.log("| 理由 | 行 | 持ち主（多い順） |\n|---|---|---|");
  for (const k of Object.keys(JA) as OffReason[]) { const xs = out.filter((x) => x.reason === k); const own = new Map<string, number>(); for (const x of xs) own.set(x.owner ?? "?", (own.get(x.owner ?? "?") ?? 0) + 1); console.log(`| ${JA[k]} | ${xs.length} | ${[...own].sort((a, b) => b[1] - a[1]).map(([o, n]) => `${o} ${n}`).join("・")} |`); }
  console.log("\n## ⑤ 忘れ（on の案の候補）");
  for (const x of out.filter((x) => x.reason === "forgot")) console.log(`- #${x.id} ${x.switch_name}（${x.owner}）: ${String(x.exam_result).replace(/\s+/g, " ").slice(0, 110)}`);
  console.log("\n## 台帳の直し（コードはもう既定 on）");
  for (const x of out.filter((x) => x.reason === "already_on").slice(0, 40)) console.log(`- #${x.id} ${x.switch_name}（${x.owner}・段 ${x.stage}）`);
  if (arg("json")) writeFileSync(arg("json"), JSON.stringify(out.map((x) => ({ id: x.id, switch: x.switch_name, owner: x.owner, stage: x.stage, reason: x.reason })), null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
