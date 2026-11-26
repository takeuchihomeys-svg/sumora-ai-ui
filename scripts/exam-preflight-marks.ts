// scripts/exam-preflight-marks.ts — 昼に LLM を呼ばずに「部品が届くか」を確かめる（台帳 #803・竹内さん 11/27「試験の質上げればもっと早く完了するのでは」）
// 2026-11-27 作業員L（統括役の頼み）: ブレインの材料はプロンプトを組む所まで決まった計算＝問題の写しで材料を組み、目当ての印（material_marks）が付くかだけを見る。
//   brain-exam を 1回・判定なし・録音の再生だけ（--replay=strict＝録音の無い要求は呼ばずに失敗・API 0回）・EXAM_MARKS_PREFLIGHT=on で流し、
//   ブレインを呼ぶ前の印の鍵（brain-core の [preflight-marks] の1行）を問題ごとに読む。目当ての印は試験の辞書（手＋推定・exam-dictionary）。
//   届く問題が 3 未満＝「届かず」（積まずに昼に直す）。昼に動かしてよい線: LLM 0（strict）・DB は試験の会話（写し）だけ・試験の係とは別に回す。
//   ⚠ 録音の無い前段の読み（ブレインの前の LLM の読み）は strict で失敗する＝その読みに依る部品は「届かず」と出ることがある（その時は録音の無い数を出す）
// 実行: npx tsx --env-file=.env.local scripts/exam-preflight-marks.ts --ids=q1,q2 --switch=SW_A[,SW_B] [--env=K=V,K2=V2] [--min=3] [--cwd=<作業ツリー>]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { examCacheRoot } from "./lib/llm-cassette";
import type { ExamDictionary } from "./lib/exam-dictionary";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
/** brain-exam の出力から問題ごとの印の鍵（1問ずつ流した時は出た順＝問題の順）（純関数） */
export function preflightKeysOf(out: string): string[][] {
  const xs: string[][] = [];
  for (const m of String(out ?? "").matchAll(/\[preflight-marks\] (\{[^\n]*\})/g)) { try { xs.push((JSON.parse(m[1]) as { keys?: string[] }).keys ?? []); } catch { xs.push([]); } }
  return xs;
}
/** 届いたかの判定（純関数）: 目当ての印（辞書の手＋推定）が付いた問題の数が min 以上で「比べる」・未満は「届かず」・印の無いスイッチは「印なし」 */
export function preflightVerdict(byId: Record<string, string[] | null>, targets: readonly string[], min = 3): { reached: string[]; notReached: string[]; unknown: string[]; verdict: "比べる" | "届かず" | "印なし" } {
  const ids = Object.keys(byId);
  if (!targets.length) return { reached: [], notReached: [], unknown: ids, verdict: "印なし" };
  const reached = ids.filter((id) => (byId[id] ?? []).some((k) => targets.includes(k)));
  const unknown = ids.filter((id) => byId[id] == null);
  const notReached = ids.filter((id) => byId[id] != null && !reached.includes(id));
  return { reached, notReached, unknown, verdict: reached.length >= Math.min(min, ids.length) && reached.length > 0 ? "比べる" : "届かず" };
}
export function targetMarksOf(d: ExamDictionary | null, switches: readonly string[]): string[] {
  // 手の印（SWITCH_TARGET_MARK・SWITCH_REACH.mark）があればそれだけ（推定の印は他の部品の印も拾う＝now_fulfillable 等で届いたと見誤る・a-cpf で確かめた）
  return [...new Set(switches.flatMap((s) => { const ms = d?.switches[s]?.marks ?? []; const hand = ms.filter((m) => m.source === "手"); return (hand.length ? hand : ms).map((m) => m.mark); }))];
}
/** 1問ずつ流す（問題と印の対応を確かにする）。費用は 0（strict）・1問 30〜90秒 */
export function runPreflight(o: { cwd: string; ids: readonly string[]; env: Record<string, string>; label: string }): { byId: Record<string, string[] | null>; missed: number } {
  const byId: Record<string, string[] | null> = {}; let missed = 0;
  for (const id of o.ids) {
    const envFile = existsSync(join(o.cwd, ".env.local")) ? join(o.cwd, ".env.local") : join(o.cwd, "..", "exam-night", ".env.local"); // .env は写さない（係の作業ツリーの物を読む）
    const r = spawnSync("npx", ["tsx", `"--env-file=${envFile}"`, "scripts/brain-exam.ts", `--label=${o.label}-${id}`, "--conv=auto", "--repeat=1", "--stage=brain", `--only=${id}`, "--no-judge", "--replay=strict"], {
      cwd: o.cwd, encoding: "utf8", shell: true, timeout: 5 * 60_000, env: { ...process.env, ...o.env, LLM_TEST_MODE: "deepseek-all", EXAM_MARKS_PREFLIGHT: "on", EXAM_CONCURRENCY: "1" },
    });
    // 印だけ見る回の線の鍵（label ごとの floor の .lock）は残さない
    try { const ro = join(o.cwd, "scripts", ".replay-out"); for (const f of readdirSync(ro)) if (f.startsWith(`brain-exam-floor-${o.label}-${id}`) && f.endsWith(".lock")) unlinkSync(join(ro, f)); } catch { /* 無ければよい */ }
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    const ks = preflightKeysOf(out);
    byId[id] = ks.length ? [...new Set(ks.flat())] : null;
    const mm = out.match(/録音の無い・変わった要求が (\d+)回/); if (mm) missed += Number(mm[1]);
  }
  return { byId, missed };
}

if (require.main === module) {
  const cwd = arg("cwd", process.cwd());
  const ids = arg("ids").split(",").filter(Boolean);
  const switches = arg("switch").split(",").filter(Boolean);
  if (!ids.length || !switches.length) { console.error("使い方: --ids=q1,q2 --switch=SW_A [--env=K=V,...] [--min=3]"); process.exit(1); }
  const env = Object.fromEntries([...switches.map((s) => [s, "on"]), ...arg("env").split(",").filter((x) => x.includes("=")).map((x) => x.split("=") as [string, string])]);
  const dict = (() => { try { return JSON.parse(readFileSync(join(examCacheRoot(), "exam-dictionary.json"), "utf8")) as ExamDictionary; } catch { return null; } })();
  const targets = targetMarksOf(dict, switches);
  const t0 = Date.now();
  const r = runPreflight({ cwd, ids, env, label: `pfm-${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "")}` });
  const v = preflightVerdict(r.byId, targets, Number(arg("min", "3")) || 3);
  console.log(`届きの確かめ（LLM 0・${ids.length}問・${Math.round((Date.now() - t0) / 1000)}秒）: ${v.verdict}・目当ての印 ${targets.join(",") || "なし"}・届いた ${v.reached.length}（${v.reached.join(",")}）・届かない ${v.notReached.length}・分からない ${v.unknown.length}${r.missed ? `・録音の無い前段の要求 ${r.missed}回（呼んでいない＝その読みに依る部品は届かずに見えることがある）` : ""}`);
  for (const id of ids) console.log(`  ${id}: ${r.byId[id] == null ? "（印の行が出ない＝始まる前に止まった）" : (r.byId[id] ?? []).join(",") || "印なし"}`);
}
