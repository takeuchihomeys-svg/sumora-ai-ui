// scripts/lib/exam-cost-gate.ts — 試験の費用の門（回す前の見込み・上限・安い時間・前を作る側の費用の足し込み）。純関数だけ（LLM も DB も使わない）
//
// 2026-11-05 作業員8（竹内さん「試験さらに効率よく、質も高く、費用抑えれるような形」→ 統括役の5つの了承の 1・5）:
//   測った事（11/04〜05・DeepSeek の単価で）:
//     - 前（main）を作る子が 11/04 $35.3・11/05 昼まで $15.8＝依頼の側（11/04 $3.5）の約10倍。作業員の報告の費用に入っていなかった
//       （brain-exam.ts の終わりは「費用は上の『前』の実行の終わりに出ている」と書くだけ）
//     - 子の 4,543回のうち 1,587回が平日の倍の時間（JST 10-13・15-19）
//     - 子は 1問 4回が 250問回（費用の 77%）。そのうち 4回とも同じ答えが少なくとも 139
//   この門は、①回す前に「前も含めた」見込みを出す ②上限を超える依頼は分ける／夜に回す／止める ③報告に前を作る側の費用を足す、を1か所で決める。
//   KB: a62a4164（使い回し）・4c91ffd9（試験のブレインが何を何回）・e9d2303e（pass^k・回帰）・d57f27eb（3組・全問は最後に1回）
import { isDeepseekPeakAt } from "../../app/lib/llm-price";

/** 1問の見込みの材料 */
export type CostItem = {
  id: string;
  /** この依頼で回す回数 */
  reps: number;
  /** 前の観測の1回あたりの費用（無ければ unitUsd） */
  usdPerRep?: number | null;
  /** 前（main）の答えが無く、子が作る必要があるか */
  needsBase?: boolean;
  /** 前を作る時の回数（無ければ reps） */
  baseReps?: number;
  /** 録音・取り置きで呼ばずに済む見込みの割合（0〜1・無ければ 0） */
  replayRate?: number | null;
};
export type CostEstimate = {
  calls: { request: number; base: number };
  usd: { request: number; base: number; total: number };
  /** 今が倍の時間なら、夜（倍でない時間）に回した時の額 */
  usdOffPeak: number;
  peakNow: boolean;
};

const clamp01 = (x: number | null | undefined) => (Number.isFinite(x as number) ? Math.min(1, Math.max(0, Number(x))) : 0);

/** 回す前の見込み（回数×1回の費用×録音の外れの率・前を作る側も足す）。peak は DeepSeek の倍の時間 */
export function estimateExamCost(items: CostItem[], opts: { unitUsd?: number; at?: string | number | Date } = {}): CostEstimate {
  const unit = opts.unitUsd ?? 0.03;
  const peakNow = isDeepseekPeakAt(opts.at ?? Date.now());
  const mult = peakNow ? 2 : 1;
  let rq = 0, bs = 0, cr = 0, cb = 0;
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.id)) continue; // 同じ id は1つ（点検表 13: 同じ問題を2回足して回数が倍）
    seen.add(it.id);
    const per = (it.usdPerRep ?? unit) * (1 - clamp01(it.replayRate));
    const reps = Math.max(0, Math.floor(it.reps));
    cr += reps; rq += per * reps;
    if (it.needsBase) { const br = Math.max(0, Math.floor(it.baseReps ?? it.reps)); cb += br; bs += per * br; }
  }
  const base = rq + bs;
  return { calls: { request: cr, base: cb }, usd: { request: rq * mult, base: bs * mult, total: base * mult }, usdOffPeak: base, peakNow };
}

export type GateVerdict =
  | { go: true; why: string }
  | { go: false; action: "night" | "split" | "stop"; why: string; parts?: string[][] };

/**
 * 上限の門。cap＝この依頼の上限（$）。
 *   - 見込みが上限の内 → 回す
 *   - 倍の時間で、夜なら上限の内 → 夜へ（急ぎの印 urgent なら回す）
 *   - 夜でも超える → 上限に収まる塊に分ける（回帰の必須 mustIds は最初の塊に入れる）。1問でも超えるなら止める
 */
export function costGate(items: CostItem[], est: CostEstimate, opts: { capUsd: number; urgent?: boolean; mustIds?: string[]; unitUsd?: number }): GateVerdict {
  const cap = opts.capUsd;
  if (est.usd.total <= cap) return { go: true, why: `見込み $${est.usd.total.toFixed(2)} ≤ 上限 $${cap.toFixed(2)}` };
  if (est.peakNow && est.usdOffPeak <= cap) {
    if (opts.urgent) return { go: true, why: `倍の時間だが急ぎ（夜なら $${est.usdOffPeak.toFixed(2)}・今 $${est.usd.total.toFixed(2)}）` };
    return { go: false, action: "night", why: `今は倍の時間（$${est.usd.total.toFixed(2)}）・夜なら $${est.usdOffPeak.toFixed(2)} ≤ 上限` };
  }
  const unit = opts.unitUsd ?? 0.03;
  const costOf = (it: CostItem) => { const per = (it.usdPerRep ?? unit) * (1 - clamp01(it.replayRate)); return per * (Math.max(0, it.reps) + (it.needsBase ? Math.max(0, it.baseReps ?? it.reps) : 0)); };
  const must = new Set(opts.mustIds ?? []);
  const ordered = [...items.filter((x) => must.has(x.id)), ...items.filter((x) => !must.has(x.id))];
  const parts: string[][] = []; let cur: string[] = [], sum = 0;
  for (const it of ordered) {
    const c = costOf(it);
    if (c > cap) return { go: false, action: "stop", why: `${it.id} だけで $${c.toFixed(2)} ＞ 上限 $${cap.toFixed(2)}（回数か段を見直す）` };
    if (sum + c > cap && cur.length) { parts.push(cur); cur = []; sum = 0; }
    cur.push(it.id); sum += c;
  }
  if (cur.length) parts.push(cur);
  return { go: false, action: "split", why: `見込み $${est.usdOffPeak.toFixed(2)}（夜）＞ 上限 $${cap.toFixed(2)} → ${parts.length}つに分ける`, parts };
}

/**
 * 揺れの記録で回数を決める（KB e9d2303e・a62a4164②）。
 *   history＝この問題の前の合否（新しい順でなくてよい）。回帰の必須（直った問題）は最低2回、揺れる問題は k 回、安定は1回。
 *   前を作る側（base）も同じ考えで回数を決める＝子の「1問4回」（費用の 77%）を、安定な問題で1回にする。
 */
export function repsFor(history: boolean[], opts: { k?: number; minObs?: number; regression?: boolean } = {}): number {
  const k = Math.max(1, opts.k ?? 3), minObs = Math.max(1, opts.minObs ?? 3);
  if (history.length < minObs) return opts.regression ? Math.max(2, k) : k; // 分からない＝揺れる扱い
  const allSame = history.every((x) => x === history[0]);
  if (allSame) return opts.regression ? 2 : 1;
  return k;
}

/** pass^k（毎回通る）と pass@k（1回でも通る）。自動送信の候補は pass^k で見る（KB e9d2303e④） */
export function passK(results: boolean[]): { n: number; passAll: boolean; passAny: boolean; rate: number } {
  const n = results.length, p = results.filter(Boolean).length;
  return { n, passAll: n > 0 && p === n, passAny: p > 0, rate: n ? p / n : 0 };
}

/**
 * 段を最小にする（統括役 11/05・了承）: 判断だけを見る依頼は brain（下書き・最終チェック・aix_desk を回さない）。
 *   11/04〜05 の前の子の費用は brain_full＋brain_fresh が約 80%・下書きの段（final_check 5種・名札なし・aix_desk）が約 15%。
 *   group＝依頼の組（d57f27eb の3組）。文の組（返信の文・AIX の文）だけ draft。diffStage＝exam-scope の --stage=diff の答え（無ければ draft＝安全側）
 */
export function decideStage(input: { group?: "brain" | "reply" | "aix" | null; diffStage?: "brain" | "draft" | "none" | null }): "brain" | "draft" {
  if (input.group === "reply" || input.group === "aix") return "draft";
  if (input.group === "brain") return "brain";
  if (input.diffStage === "brain" || input.diffStage === "none") return "brain";
  return "draft";
}

/** 試験の中で省いてよい名札（答えを変えない・記録だけ）。入口の統括が組み合わせを決め始めたら conductor_intake は外す（intakeDecides=true） */
export function skippableActions(opts: { intakeDecides?: boolean } = {}): string[] {
  return [...(opts.intakeDecides ? [] : ["conductor_intake"]), "brain_fresh_claude"];
}

/**
 * 最後の Claude の確かめが要るか（統括役 11/05 了承の (a)(b)(c)・test_protocol_brain「場面ごとに1〜2回」）。
 *   (a) ブレインの指示・材料の文を変える直しで既定 on にする → 触る場面ごとに1問×1回
 *   (b) 記録だけ・文の組だけ → 要らない
 *   (c) DeepSeek で確かな悪化が出た問題・本番の Claude と試験の DeepSeek の割れが大きい場面（splitRate＜0.7）の問題 → 1回
 */
export function claudeCheckPlan(input: {
  kind: "brain-text" | "record-only" | "text-only";
  defaultOn: boolean;
  scenes: Array<{ scene: string; problems: string[]; splitAgree?: number | null }>;
  worseSure?: string[];
  maxCalls?: number;
}): { ids: string[]; why: string } {
  const ids = new Set<string>();
  const why: string[] = [];
  if (input.kind === "brain-text" && input.defaultOn) { for (const s of input.scenes) if (s.problems[0]) ids.add(s.problems[0]); why.push(`(a) 場面ごとに1問 ${ids.size}`); }
  for (const id of input.worseSure ?? []) ids.add(id);
  if (input.worseSure?.length) why.push(`(c) 確かな悪化 ${input.worseSure.length}`);
  const low = input.scenes.filter((s) => s.splitAgree != null && s.splitAgree < 0.7);
  for (const s of low) if (s.problems[0]) ids.add(s.problems[0]);
  if (low.length) why.push(`(c) 割れの大きい場面 ${low.map((s) => s.scene).join("・")}`);
  const cap = input.maxCalls ?? 20; // brain-exam の --allow-many-claude の線（20回）と同じ
  const out = [...ids].slice(0, cap);
  if (!out.length) return { ids: [], why: input.kind === "brain-text" ? "既定 off のまま＝要らない" : "(b) 記録だけ・文の組だけ＝要らない" };
  return { ids: out, why: why.join("・") + (ids.size > cap ? `（上限 ${cap} で切った）` : "") };
}

/**
 * 依頼の費用の報告に、前（main）を作った子の費用を足す（統括役 11/05「作業員の報告の費用に、前を作る側の分も入るように」）。
 *   childRoutes＝llm_usage_logs の route ごとの $（script:brain-exam-main-<commit7>-<cfg>-<run>）。baseRuns＝この依頼が起こした子の runLabel（main-…-r…）。
 *   子の runLabel が分からない時は、同じ commit・構成の子のうち依頼の時間の内に始まった物を足す（推定の印を付ける）。
 */
export function attributeBaseCost(req: { label: string; usd: number; commit7: string; cfg: string; startMs: number; endMs: number; baseRuns?: string[] },
  childRoutes: Array<{ route: string; usd: number; firstMs: number }>): { usd: number; baseUsd: number; total: number; runs: string[]; estimated: boolean } {
  const re = /^script:brain-exam-(main-([0-9a-f]{7})-([0-9a-f]{10})-([rp]\w+))$/;
  const rows = childRoutes.map((r) => ({ ...r, m: re.exec(r.route) })).filter((r) => r.m);
  let picked: typeof rows; let estimated = false;
  if (req.baseRuns?.length) picked = rows.filter((r) => req.baseRuns!.includes(r.m![1]));
  else { estimated = true; picked = rows.filter((r) => r.m![2] === req.commit7 && r.m![3] === req.cfg && r.firstMs >= req.startMs && r.firstMs <= req.endMs); }
  const baseUsd = picked.reduce((s, r) => s + r.usd, 0);
  return { usd: req.usd, baseUsd, total: req.usd + baseUsd, runs: picked.map((r) => r.m![1]), estimated };
}
