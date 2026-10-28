// scripts/audit-two-choice-now-counterfactual.ts — その場の側の2択（TWO_CHOICE_NOW_SIDE）の効きを、同じ試験の答案の中で数える（LLM なし）。
//   2026-10-28 作業員5。その場の側はブレインの答えの後の決定論（判断の材料は変えない）なので、同じ答案で「2択を出した道」と「出さなかった道（ブレインの AIX だけ）」を
//   同じ正解で採点し比べれば、日付・DB の並びの揺れに関係なく、この変更だけの ○→✕・✕→○ が分かる。
// 実行: npx tsx scripts/audit-two-choice-now-counterfactual.ts --label=w5-tcnow-on
import { readFileSync } from "node:fs";
import { brainPathCode, judgePath, type BrainExamOutput } from "./lib/brain-exam-score";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").slice(k.length + 3) || d;
const LABEL = arg("label", "w5-tcnow-on");
type Spec = { id: string; accept: string[]; mustNot?: string[]; acceptWhen?: { searchExhausted?: string[] } };
const spec = new Map((JSON.parse(readFileSync("scripts/brain-exam/spec.json", "utf8")) as Spec[]).map((p) => [p.id, p]));
const rows = readFileSync(`scripts/brain-exam/results/${LABEL}.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; rep: number; brain: Record<string, unknown> | null; path: { code: string; ok: boolean }; error?: string });
const NOW = new Set(["property_check_result", "estimate_sheet", "property_send", "property_recommendation"]);
let fired = 0, bothOk = 0, gained = 0, lost = 0, bothNg = 0, risky = 0;
// 2択は言ってはいけない道（hard）で外さない採点なので、右の約束がその問題の「言ってはいけない道」に当たる番は別に数える（押せば間違いになるボタンを出した）
for (const r of rows) {
  if (r.error || !r.brain) continue;
  const b = r.brain as BrainExamOutput & Record<string, unknown>;
  const isNow = r.path.code.startsWith("2択") && b.reply_mode === "aix" && NOW.has(String(b.action ?? "")) && !b.two_stage;
  if (!isNow) continue;
  fired++;
  const p = spec.get(r.id);
  if (!p) continue;
  const without = judgePath(brainPathCode({ ...b, two_choice_mode: false, two_choice_reply_kind: null }), p.accept, p.mustNot ?? []).ok;
  const withTc = r.path.ok;
  if (withTc && without) bothOk++; else if (withTc && !without) gained++; else if (!withTc && without) lost++; else bothNg++;
  const rk = String(b.action ?? "") === "estimate_sheet" ? "estimate" : String(b.action ?? "") === "property_check_result" ? "check" : "pickup";
  const bad = (p.mustNot ?? []).some((m) => m === `2段:${rk}` || m === "2段" || m === "返信");
  if (bad) risky++;
  console.log(`${bad ? "⚠右は言ってはいけない道 " : ""}${r.id}#${r.rep} ${without ? "○" : "✕"}→${withTc ? "○" : "✕"} ${r.path.code} 正解=${p.accept.join("|")}`);
}
console.log(`\nその場の側の2択が出た ${fired} 番: ○→○ ${bothOk}・✕→○ ${gained}・○→✕ ${lost}・✕→✕ ${bothNg}｜右の約束が言ってはいけない道 ${risky}`);
