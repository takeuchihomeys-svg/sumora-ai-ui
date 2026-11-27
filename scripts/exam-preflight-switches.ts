// scripts/exam-preflight-switches.ts — スイッチの一覧を、昼の届きの確かめ（LLM 0）に順に通して表にする（台帳 #803・統括役の頼み: 朝の1枚の「試験中のスイッチ」）
// 2026-11-27 作業員L: スイッチごとに、効く問題（試験の辞書の写しに材料のある問題・無ければ前の on の回で走った問題・最大 --per 問）を選び、exam-preflight-marks に通す。
//   空きメモリが 1000MB 未満の間は待つ（--wait-min まで・60秒ごとに見る）。結果は --out の json（スイッチ → 比べる／届かず／録音なし／印なし／分からない・届いた問題）。LLM 0・本番 DB の読み 0
// 実行: npx tsx scripts/exam-preflight-switches.ts --switches=A,B --out=<json> [--per=4] [--wait-min=180]
import { readFileSync, writeFileSync } from "node:fs";
import { freemem } from "node:os";
import { join } from "node:path";
import { examCacheRoot } from "./lib/llm-cassette";
import { runPreflight, preflightVerdict, targetMarksOf } from "./exam-preflight-marks";
import type { ExamDictionary } from "./lib/exam-dictionary";
import { SWITCH_REACH } from "./lib/exam-switch-reach";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** スイッチの効く問題（純関数）: 写しに材料のある問題 → 前の on の回で走った問題 → 前に効いた問題 の順に重ねて per 問 */
export function problemsForSwitch(d: ExamDictionary | null, sw: string, per = 4): string[] {
  // 2026-11-27: 手で選んだ効く問題（SWITCH_REACH の eff）があれば先に（辞書に無いスイッチも確かめられる）
  const eff = (SWITCH_REACH[sw]?.eff ?? []) as readonly string[];
  const s = d?.switches[sw];
  if (!s) return [...eff].slice(0, per);
  return [...new Set([...eff, ...s.withMaterial, ...(s.ranOn ?? []), ...s.hit])].slice(0, per);
}

if (require.main === module) (async () => {
  const sws = arg("switches").split(",").filter(Boolean);
  const out = arg("out"); const per = Number(arg("per", "4")) || 4; const waitMin = Number(arg("wait-min", "180")) || 180;
  const rag = (() => { const f = arg("rag"); if (!f) return null; try { return JSON.parse(readFileSync(f, "utf8")) as { results?: Record<string, { eff?: Array<{ id: string }> }> }; } catch { return null; } })();
  const dict = (() => { try { return JSON.parse(readFileSync(join(examCacheRoot(), "exam-dictionary.json"), "utf8")) as ExamDictionary; } catch { return null; } })();
  const res: Record<string, unknown> = {};
  const save = () => { if (out) writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), results: res }, null, 1)); };
  for (const sw of sws) {
    const targets = targetMarksOf(dict, [sw]);
    if (SWITCH_REACH[sw]?.notExam) { res[sw] = { verdict: "測らない", why: SWITCH_REACH[sw].notExam }; console.log(`${sw}: 測らない（${SWITCH_REACH[sw].notExam}）`); save(); continue; }
    // 2026-11-27 作業員L（試験の問題を RAG で選ぶ・④）: --rag=<exam-problem-rag の --out の json> の時は、RAG の効く候補の上位 per 問を確かめる（今の選びは使わない）
    const ids = rag ? ((rag.results?.[sw]?.eff ?? []) as Array<{ id: string }>).map((x) => x.id).slice(0, per) : problemsForSwitch(dict, sw, per);
    if (!targets.length) { res[sw] = { verdict: "印なし", ids, targets }; console.log(`${sw}: 印なし（目当ての印が無い）`); save(); continue; }
    if (!ids.length) { res[sw] = { verdict: "分からない", why: "効く問題が辞書に無い", targets }; console.log(`${sw}: 分からない（効く問題が無い）`); save(); continue; }
    const t0 = Date.now();
    while (Math.round(freemem() / 1048576) < 1000 && Date.now() - t0 < waitMin * 60_000) await sleep(60_000);
    if (Math.round(freemem() / 1048576) < 1000) { res[sw] = { verdict: "分からない", why: "空きメモリが戻らない", targets, ids }; console.log(`${sw}: 止めた（空きメモリ）`); save(); break; }
    const r = runPreflight({ cwd: process.cwd(), ids, env: { [sw]: "on" }, label: `pfs-${sw.toLowerCase().slice(0, 20)}` });
    const v = preflightVerdict(r.byId, targets, 3, r.missedById);
    res[sw] = { verdict: v.verdict, targets, ids, reached: v.reached, notReached: v.notReached, noRecord: v.noRecord, unknown: v.unknown };
    console.log(`${sw}: ${v.verdict}・目当ての印 ${targets.join(",")}・届いた ${v.reached.length}/${ids.length}（${v.reached.join(",")}）`);
    save();
  }
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
