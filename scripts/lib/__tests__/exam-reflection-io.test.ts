// 係から呼ぶ所（scripts/lib/exam-reflection-io.ts の reflectAndReplan）と週の読み（readWeeklyRows）の配線のテスト（読むだけ・LLM も DB も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-reflection-io.test.ts（全 PASS で exit 0）。札（exam-cache/brain-exam-rag/cards.json）が無い PC では案の所を飛ばす
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reflectAndReplan, readWeeklyRows, loadReplanCards, hitIdsForSwitch } from "../exam-reflection-io";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

const cwd = join(__dirname, "..", "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "refl-"));
const RES = join(tmp, "results"), DONE = join(tmp, "done");
mkdirSync(RES); mkdirSync(DONE);
try {
  const cards = loadReplanCards(cwd);
  const row = (id: string, p: boolean) => ({ id, rep: 1, score: { pass: p }, path: { code: "返信", ok: p }, essence: { ok: p } });
  const t = cards.find((c) => c.type)?.id;
  if (t) {
    // 同じスイッチの過去の依頼が見つけた問題
    writeFileSync(join(RES, "old.json"), JSON.stringify({ label: "old", switch: "SW_T", at: "2026-11-01T00:00:00Z", reflection: { v: 1, selected: 1, targets: 1, guards: 0, found: [{ id: "qZZZ", role: "target", kinds: ["miss"] }], nothing: [], reps: {} } }));
    ok("配線: 同じスイッチの過去の発見を読む", hitIdsForSwitch(RES, "SW_T").has("qZZZ") && !hitIdsForSwitch(RES, "SW_T", "old").has("qZZZ"));
    const r = reflectAndReplan({ label: "x", owner: "作業員8c", switchName: "SW_T", cwd, stage: "brain", ids: [t], guards: [], cur: [row(t, false)], base: [row(t, false)], result: { reps: { [t]: 1 } }, worseN: 0, resDir: RES });
    ok("配線: 効かず・悪化0で案が出る", !!r?.replan && r.replan.add.length >= 1 && r.replan.add.length <= 3 && !r.replan.add.some((a) => a.id === t), JSON.stringify(r?.replan));
    ok("配線: 外れを振り返りに残す", r?.reflection.found[0]?.id === t);
    ok("配線: 掘りの依頼は案なし", reflectAndReplan({ label: "x", owner: "?", switchName: "SW_T", cwd, stage: "brain", ids: [t], guards: [], cur: [row(t, false)], base: [row(t, false)], result: {}, worseN: 0, resDir: RES, dig: true })?.replan === null);
    const r2 = reflectAndReplan({ label: "x", owner: "?", switchName: "", cwd, stage: "brain", ids: [t], guards: [], cur: [row(t, true)], base: [row(t, false)], result: {}, worseN: 0, resDir: RES });
    ok("配線: 効いた時は案なし", r2?.replan === null);
    const r3 = reflectAndReplan({ label: "x", owner: "?", switchName: "", cwd, stage: "brain", ids: [], guards: [], cur: [row(t, true)], base: null, result: {}, worseN: null, resDir: RES });
    ok("配線: RAG の依頼（only 空）は今の回の行から数える・前が無ければ案なし", r3?.reflection.selected === 1 && r3.replan === null);
  } else console.log("（札が無い＝案の配線は飛ばした）");
  process.env.EXAM_REFLECTION = "off";
  ok("配線: EXAM_REFLECTION=off で何もしない", reflectAndReplan({ label: "x", owner: "?", switchName: "", cwd, stage: "brain", ids: ["q1"], guards: [], cur: [], base: null, result: {}, worseN: 0, resDir: RES }) === null);
  delete process.env.EXAM_REFLECTION;
  // 週の読み: 範囲・tsc を外す・done の守り
  writeFileSync(join(RES, "a.json"), JSON.stringify({ label: "a", owner: "作業員1", only: "q1,g1", usd: "$0.2", at: "2026-11-05T00:00:00Z", missStages: [{ id: "g1", n: 1 }] }));
  writeFileSync(join(RES, "a.reps.json"), JSON.stringify({ q1: 1 }));
  writeFileSync(join(RES, "t.json"), JSON.stringify({ label: "t", runner: "tsc-remote", at: "2026-11-05T00:00:00Z" }));
  writeFileSync(join(RES, "late.json"), JSON.stringify({ label: "late", only: "q1", at: "2026-11-20T00:00:00Z" }));
  writeFileSync(join(DONE, "2026-11-05-a.json"), JSON.stringify({ label: "a", guards: ["g1"] }));
  const w = readWeeklyRows(RES, DONE, Date.parse("2026-11-03T00:00:00Z"), Date.parse("2026-11-10T00:00:00Z"));
  ok("週の読み: 範囲の brain-exam の結果だけ", w.map((x) => x.label).join() === "a", w.map((x) => x.label).join());
  ok("週の読み: done の守りを当てる", w[0]?.reflection.guards === 1 && w[0].reflection.found[0]?.role === "guard");
} finally { rmSync(tmp, { recursive: true, force: true }); }

console.log(`exam-reflection-io: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);
