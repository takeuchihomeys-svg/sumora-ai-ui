// scripts/lib/exam-plan.ts — 試験の統括（1か所で順に決めて1行の「計画」を出す・終わった時の結果の読み方も同じ所）。純関数だけ
//
// 2026-11-05 作業員8（KB P0 4c91ffd9「試験のブレインが何を・何回・どこまで・いつ流し・途中で止めるかを決める」・統括役の指示「今の部品を作り直さずにつなぐだけ」）:
//   今まで決める物がばらばらだった（何を＝--only／何回＝揺れの記録／どこまで＝--stage／いつ＝安い時間と費用の門／止める＝早めの打ち切り）。
//   依頼を積む時にここが順に決める: ①物差しで見るか（記録だけ・本番で動いている直しは試験を流さず毎晩の本番の物差しで見る）→ ②問題（依頼の --only・入力が前と同じ問題は
//   係が下見で外す＝作業員1 exam-scope-input）→ ③回数（repsFor・安定1・揺れ k・回帰は必須）→ ④段（decideStage）→ ⑤最後の Claude の確かめ（claudeCheckPlan）
//   → ⑥流す時間と費用（estimateExamCost・costGate）。終わった時は readExamResult が「悪化0／揺れ／確かな悪化」と、悪化なら竹内さんの送信と答案の差を添える。
//   計画と結果は exam-cache/exam-plans.jsonl に残し、weeklyPlanAudit が外れた計画（見落とした悪化・むだに流した問題）を数える。
//   KB: 4c91ffd9（P0）・2e164f41（P0 限りなく竹内さんに近づける）・a62a4164・d57f27eb・e9d2303e
import { estimateExamCost, costGate, repsFor, decideStage, claudeCheckPlan, type CostItem, type GateVerdict } from "./exam-cost-gate";

export type PlanInput = {
  /** 係が実際に流す回数（問題 id → 回・jobRepsPlan）。渡せば見込みはこれで出す（11/06 統括役） */
  repsOverride?: Record<string, number>;
  label: string;
  /** 直しの種類: exam＝文や判断を変える（試験）／record＝記録だけ（文も判断も変えない）／prod＝もう本番で動いている（既定 on で入った） */
  kind?: "exam" | "record" | "prod";
  switchName?: string;
  ids: string[];
  /** 問題ごとの前の合否（揺れの記録） */
  history?: Record<string, boolean[]>;
  /** 一度直った問題（回帰の必須） */
  regression?: string[];
  group?: "brain" | "reply" | "aix" | null;
  diffStage?: "brain" | "draft" | "none" | null;
  /** 直しがブレインの指示・材料の文を変えるか（Claude の確かめの (a)）・既定 on にする予定か */
  brainText?: boolean; defaultOn?: boolean;
  scenes?: Array<{ scene: string; problems: string[]; splitAgree?: number | null }>;
  usdPerRep?: Record<string, number>;
  /** 前（main）の答えが無い問題 */
  needsBase?: string[];
  capUsd?: number; urgent?: boolean; atMs?: number; k?: number;
};
export type ExamPlan = {
  label: string; route: "yardstick" | "exam";
  ids: string[]; reps: Record<string, number>; stage: "brain" | "draft";
  claude: { ids: string[]; why: string };
  cost: { usd: number; usdOffPeak: number; calls: number; peakNow: boolean };
  gate: GateVerdict; line: string;
};

/**
 * 直しの種類。書いた物（--kind）だけで決める＝推定で物差しに回さない（_NOTE のスイッチはブレインの材料に注記を足す＝判断を変えうる）。
 *   名前が記録らしい時は suggest に「--kind=record なら物差しで見られる」と出すだけ
 */
export function guessKind(input: { kind?: PlanInput["kind"]; switchName?: string; label?: string }): "exam" | "record" | "prod" {
  return input.kind ?? "exam";
}
export function kindSuggest(input: { kind?: PlanInput["kind"]; switchName?: string; label?: string }): string | null {
  if (input.kind) return null;
  const s = `${input.switchName ?? ""} ${input.label ?? ""}`;
  return /記録だけ|(?:^|[_-])(?:LOG|RECORD|DIGEST)(?:$|[_-])|digest/i.test(s) ? "記録だけの直しなら --kind=record で試験を流さず物差しで見られる" : null;
}

/** 1回あたりの単価（今の答え＋判定・DeepSeek の安い時間）。11/06 の実際: 頭の段 $0.018〜0.025・下書きの段 $0.033〜0.037（前は 0.06 と見ていた＝見込みが倍） */
export const BRAIN_USD_PER_REP = 0.03, DRAFT_USD_PER_REP = 0.04;

export function planExam(input: PlanInput): ExamPlan {
  const kind = guessKind(input);
  const k = input.k ?? 3;
  if (kind !== "exam") {
    const why = kind === "record" ? "記録だけ（文も判断も変えない）" : "本番で動いている";
    const gate: GateVerdict = { go: false, action: "stop", why: `${why}＝試験を流さず毎晩の本番の物差し（cron prod-yardstick・竹内さんの番の当たり）で下がらないかを見る` };
    return { label: input.label, route: "yardstick", ids: [], reps: {}, stage: "brain", claude: { ids: [], why: "要らない" }, cost: { usd: 0, usdOffPeak: 0, calls: 0, peakNow: false }, gate,
      line: `計画 ${input.label}: ${why} → 試験を流さない・本番の物差しで見る（費用 $0）` };
  }
  const reg = new Set(input.regression ?? []);
  const ids = [...new Set([...input.ids, ...reg])];
  // 2026-11-06 統括役: 係が実際に流す回数（依頼の --repeat・--env の EXAM_FLAKY_REPS 等・揺れの記録）を渡されたらそれで見込む（無い問題だけ今までの推定）
  const reps = Object.fromEntries(ids.map((id) => [id, input.repsOverride?.[id] ?? repsFor(input.history?.[id] ?? [], { k, regression: reg.has(id) })]));
  const stage = decideStage({ group: input.group ?? null, diffStage: input.diffStage ?? null });
  const claude = claudeCheckPlan({ kind: input.brainText ? "brain-text" : stage === "draft" ? "text-only" : "record-only", defaultOn: !!input.defaultOn, scenes: input.scenes ?? [] });
  const items: CostItem[] = ids.map((id) => ({ id, reps: reps[id], usdPerRep: input.usdPerRep?.[id] ?? (stage === "draft" ? DRAFT_USD_PER_REP : BRAIN_USD_PER_REP), needsBase: (input.needsBase ?? []).includes(id) }));
  const est = estimateExamCost(items, { at: input.atMs ?? Date.now() });
  const gate = costGate(items, est, { capUsd: input.capUsd ?? 2, urgent: input.urgent, mustIds: [...reg] });
  const nFlaky = Object.values(reps).filter((r) => r > 1).length;
  const kShown = input.repsOverride ? Math.max(1, ...Object.values(reps)) : k;
  const when = gate.go ? "今" : gate.action === "night" ? "夜（倍の時間を避ける）" : gate.action === "split" ? `${gate.parts?.length ?? 0}つに分ける` : "止める";
  const line = `計画 ${input.label}: 問題 ${ids.length}（回帰 ${reg.size}）・回数 安定1×${ids.length - nFlaky}／揺れ${kShown}×${nFlaky}・段 ${stage}・Claude ${claude.ids.length ? `${claude.ids.length}問（${claude.why}）` : "なし"}・${when}・見込み $${est.usd.total.toFixed(2)}（夜なら $${est.usdOffPeak.toFixed(2)}・前を作る分 $${est.usd.base.toFixed(2)} を含む）・上限 $${(input.capUsd ?? 2).toFixed(2)}・入力が前と同じ問題は LLM を再生・決定論は今の版で作り直す（既定・入力が同じでも決定論の直しは答えを変える）`;
  return { label: input.label, route: "exam", ids, reps, stage, claude, cost: { usd: est.usd.total, usdOffPeak: est.usdOffPeak, calls: est.calls.request + est.calls.base, peakNow: est.peakNow }, gate, line };
}

export type CmpLite = { id: string; cmp: "worse" | "better" | "same" | "changed" | "shape" | "nobase" | "nocur"; sure?: boolean };
export type TakeuchiMaterial = { id: string; staffText?: string | null; staffAix?: string | null; brainPath?: string | null; basePath?: string | null };

/**
 * 終わった時の結果の読み方（同じ1か所）。悪化なら「竹内さんならどうするか」の掘りの材料（竹内さんの送信・答案の差）を添える。
 *   sure＝揺れでなく確かな悪化（係の splitWorse の答え）
 */
export function readExamResult(cmps: CmpLite[], materials: TakeuchiMaterial[] = []): { verdict: "悪化0" | "揺れ" | "確かな悪化" | "比べられない"; line: string; dig: TakeuchiMaterial[] } {
  const compared = cmps.filter((c) => c.cmp !== "nobase" && c.cmp !== "nocur");
  if (!compared.length) return { verdict: "比べられない", line: "比べられない（前と今の両方で解いた問題が 0）", dig: [] };
  const worse = compared.filter((c) => c.cmp === "worse");
  const sure = worse.filter((c) => c.sure !== false);
  if (!worse.length) return { verdict: "悪化0", line: `悪化0（比べた ${compared.length}/${cmps.length}問）`, dig: [] };
  const dig = materials.filter((m) => worse.some((w) => w.id === m.id));
  const verdict = sure.length ? "確かな悪化" : "揺れ";
  const line = `${verdict} ${sure.length ? sure.map((c) => c.id).join(",") : worse.map((c) => c.id).join(",")}（比べた ${compared.length}/${cmps.length}問）${dig.length ? `・掘りの材料: ${dig.map((d) => `${d.id} 竹内さん「${String(d.staffText ?? d.staffAix ?? "（記録なし）").replace(/\s+/g, " ").slice(0, 40)}」／前 ${d.basePath ?? "?"} → 今 ${d.brainPath ?? "?"}`).join("；")}` : ""}`;
  return { verdict, line, dig };
}

export type PlanRecord = { at: string; label: string; route: "yardstick" | "exam"; ids: string[]; usd: number; result?: { verdict: string; worse: string[]; sameAll?: boolean; ranUsd?: number } };

/**
 * 毎週の外れた計画の数え: ①むだに流した（試験を流して全部同じ・悪化も改善も無い）②見落とした（物差しに回した直しで、その後の本番の物差しで場面が下がった）
 *   droppedScenesAfter＝物差しに回した依頼の label → その後に下がった場面の数（呼ぶ側が prod-yardstick の結果から渡す）
 */
export function weeklyPlanAudit(recs: PlanRecord[], droppedScenesAfter: Record<string, number> = {}): { plans: number; wasted: number; wastedUsd: number; missed: number; line: string } {
  const exam = recs.filter((r) => r.route === "exam" && r.result);
  const wasted = exam.filter((r) => r.result!.sameAll && !r.result!.worse.length);
  const missed = recs.filter((r) => r.route === "yardstick" && (droppedScenesAfter[r.label] ?? 0) > 0);
  const wastedUsd = wasted.reduce((s, r) => s + (r.result!.ranUsd ?? r.usd), 0);
  return { plans: recs.length, wasted: wasted.length, wastedUsd, missed: missed.length,
    line: `外れた計画（7日）: むだに流した ${wasted.length}本（約 $${wastedUsd.toFixed(2)}）・物差しに回して下がった ${missed.length}本（計画 ${recs.length}本）` };
}

/**
 * 係の cmd の依頼の1行を引数に割る（純関数）。2026-11-05 作業員4の頼み: `--qfile="C:/Users/竹内 悠馬/a.json"` のように = の後ろに引用符があると
 *   旧の /"[^"]*"|\S+/g が空白で切っていた（ci-v1L・ci-v3L が落ちた）。引用符を含む塊は1つの引数にし、引用符は全部外す
 */
export function splitCmdArgs(line: string): string[] {
  return (line.match(/(?:[^\s"]*"[^"]*")+[^\s"]*|\S+/g) ?? []).map((x) => x.replace(/"/g, ""));
}

/**
 * 依頼の費用の上限（純関数・2026-11-06 作業員8・作業員9の --cap-usd が依頼のファイルに残らず止まる保証が無かった）。
 *   capUsd が正の数で、使った額（呼んだ分＋判定＋前を作った子）が上限に届いたら止める（次の問題の前で・片付けはいつも通り）
 */
export function overBudget(spentUsd: number, capUsd: number | null | undefined): boolean {
  return typeof capUsd === "number" && Number.isFinite(capUsd) && capUsd > 0 && Number.isFinite(spentUsd) && spentUsd >= capUsd;
}
/** 上限の環境変数（EXAM_MAX_USD）を読む。無い・数でない・0以下は null */
export function capUsdOf(env: Record<string, string | undefined> = process.env): number | null {
  const v = Number(String(env.EXAM_MAX_USD ?? "").trim());
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * 前（main の答え）を作り直す問題の見込み（純関数）。2026-11-06 統括役（sce-on2 の見込み $0.24・実際 $0.316〜0.349）:
 *   ずれの元は1回の単価ではなく「前を作る分 $0.00」＝前を作った子の費用（今と同じくらい）が見込みに入っていなかった。
 *   今の main の版の鍵（version-keys.json の commit → key）の置き場（v-<key>-*）に、その問題の前の答えがあれば使い回し・無ければ作る。
 *   前の版からの持ち越し（findCarryOver）は読めない＝見込みは「使い回せなければ」の上の側
 */
export function needsBaseIds(ids: string[], o: { mainCommit: string | null; versionKeys: Record<string, string>; dirsByKey: (key: string) => string[][] }): string[] {
  const key = o.mainCommit ? o.versionKeys[o.mainCommit] ?? null : null;
  if (!key) return [...ids];
  const have = new Set(o.dirsByKey(key).flat());
  return ids.filter((id) => !have.has(id));
}

/** 毎朝の見込みと実際の比（純関数・統括役 11/06）。行は依頼ごと、段ごとに1回あたりの今の費用と比の中央を出す */
export type PlanVsActual = { label: string; stage: string; planUsd: number; cur: number; judge: number; base: number; reps: number };
export function planVsActualReport(rows: PlanVsActual[]): { lines: string[]; byStage: Record<string, { n: number; perRep: number; ratioMid: number }> } {
  const lines: string[] = [], byStage: Record<string, { n: number; perRep: number; ratioMid: number }> = {};
  for (const r of rows) {
    const act = r.cur + r.judge + r.base;
    lines.push(`- ${r.label}［${r.stage}］見込み $${r.planUsd.toFixed(2)} → 実際 $${act.toFixed(2)}（比 ${r.planUsd ? (act / r.planUsd).toFixed(2) : "-"}・今 $${r.cur.toFixed(2)}／判定 $${r.judge.toFixed(2)}／前を作った $${r.base.toFixed(2)}・${r.reps}回）`);
  }
  for (const st of [...new Set(rows.map((r) => r.stage))]) {
    const xs = rows.filter((r) => r.stage === st && r.reps > 0 && r.planUsd > 0);
    if (!xs.length) continue;
    const ratios = xs.map((r) => (r.cur + r.judge + r.base) / r.planUsd).sort((a, b) => a - b);
    byStage[st] = { n: xs.length, perRep: xs.reduce((s, r) => s + r.cur + r.judge, 0) / xs.reduce((s, r) => s + r.reps, 0), ratioMid: ratios[Math.floor(ratios.length / 2)] };
  }
  return { lines, byStage };
}
