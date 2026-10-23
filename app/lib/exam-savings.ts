// app/lib/exam-savings.ts — 試験の節約できる案の台帳（exam_savings）の純関数（DB も LLM も持たない・決まった計算だけ）
//
// 2026-10-23 竹内さん「無駄な部分優先して改善する」「テスト回すブレインに節約できる案のデータベース作って」
//   「テスト回しながら節約できるにＭつかれば自己改善できるように」
//   節約の案1つ＝1行（key で一意）。試験の度（exam-brain の終わり・--spend-today）に llm_usage_logs（読むだけ）・連携の帳簿・
//   main の答えの置き場・台帳（ledger.jsonl）・model-check から無駄の印を数え、$ の見込みを付けて足す（occurrences++・印は上限つき）。
//   お客様の文は入れない（回の名前・route・action・問題 id・数だけ）。
//   自分で直す道: 質を変えない（safe）スイッチが既にある無駄で、その回でスイッチが off だった物は、次の回から自動で on に戻す
//     （.claude/exam-cache/exam-brain/savings-auto.json・止める EXAM_SAVINGS_AUTO=off）。質に関わる案は needs_owner＋竹内さんへの質問（owner_questions）。
//   台帳の切替: EXAM_SAVINGS_LEDGER（既定 on・off で書かない）

export type SavingKind = "regen_same_input" | "version_same_content" | "peak_hour" | "flash_eligible_pro" | "cache_miss_prefix" | "duplicate_run" | "overlong_output" | "reps_overkill" | "other";
export type SavingStatus = "open" | "auto_applied" | "needs_owner" | "fixed" | "wont_fix";
export const SAVING_KINDS: readonly SavingKind[] = ["regen_same_input", "version_same_content", "peak_hour", "flash_eligible_pro", "cache_miss_prefix", "duplicate_run", "overlong_output", "reps_overkill", "other"];
export const SAVING_STATUSES: readonly SavingStatus[] = ["open", "auto_applied", "needs_owner", "fixed", "wont_fix"];
export const SAVING_STATUS_JA: Record<SavingStatus, string> = { open: "未着手", auto_applied: "自動で直した", needs_owner: "竹内さんの判断待ち", fixed: "直した", wont_fix: "やらない" };
export const SAVING_KIND_JA: Record<SavingKind, string> = {
  regen_same_input: "入力が同じなのに呼んだ", version_same_content: "版が変わっても答えが同じ（作り直し）", peak_hour: "2倍の時間に呼んだ",
  flash_eligible_pro: "flash で足りる型を pro で", cache_miss_prefix: "前置きのキャッシュが当たらない", duplicate_run: "同じ問題×入力を2回",
  overlong_output: "出力が長すぎる", reps_overkill: "要らない回数", other: "その他",
};

/** 印だけ（文は入れない）。days は JST の日付 → その日の無駄の見込み $（7日まで） */
export type SavingEvidence = {
  run_labels?: string[]; routes?: string[]; actions?: string[]; ids?: string[]; versions?: string[];
  counts?: Record<string, number>; days?: Record<string, number>; switches?: string[];
};
export type SavingRow = {
  id?: number; key: string; title: string; kind: SavingKind; detail: string | null; est_usd_per_day: number; evidence: SavingEvidence;
  status: SavingStatus; safe: boolean; fix_ref: string | null; occurrences: number; first_seen: string | null; last_seen: string | null;
  created_at?: string; updated_at?: string;
};
/** 見つかった1件（まとめる前）。usd はこの窓（1回の試験 or 今日）の無駄の見込み */
export type SavingHit = { key: string; title: string; kind: SavingKind; detail?: string; usd: number; safe: boolean; evidence: SavingEvidence; at?: string };

export function examSavingsLedgerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.EXAM_SAVINGS_LEDGER ?? "").trim().toLowerCase() !== "off";
}
export function examSavingsAutoEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.EXAM_SAVINGS_AUTO ?? "").trim().toLowerCase() !== "off";
}
const KEY_RE = /^[a-z0-9][a-z0-9:_.-]{1,79}$/;
export function isSavingKey(k: string): boolean { return KEY_RE.test(k); }

// ─── 値段（app/lib/llm-price.ts の ALT_PRICES と同じ・$/100万） ─────────────────
export const PRICE = { pro: { in: 0.66, read: 0.022, out: 1.98 }, flash: { in: 0.15, read: 0.003, out: 0.6 } } as const;
/** flash にした時に浮く割合（入力・出力の値段の比の平均の目安） */
export const FLASH_SAVE_RATIO = 0.75;
const priceOf = (model: string) => (/deepseek-v4-pro|deepseek-pro/.test(model) ? PRICE.pro : /deepseek/.test(model) ? PRICE.flash : null);

// ─── 入力の形 ─────────────────────────────────────────────────────────────
export type UsageRowLite = { route: string; action: string | null; model: string; created_at: string; input_uncached: number; cache_read: number; output_tokens: number; max_tokens?: number | null; usd: number };
/** main の答えの置き場の1ファイルの要約（io が作る） */
export type BaselineFileLite = {
  version: string; id: string; savedAt: string; realUsd: number; realCalls: number; pinnedFrom: string | null;
  /** 前の版（pinnedFrom）の同じ問題と答え（道の型・合否）が同じか。前が無い・読めない＝null */
  sameAnswersAsPrev: boolean | null;
  /** 行が全部「入力が前と同じ」（inputSame）だったか */
  allInputSame: boolean;
};
export type LedgerLite = { at: string; label: string; id: string; type: string; stage: string; model: string; scopeKey: string; base: string | null; reps: number; codes: string[]; flake?: string | null; reused: boolean; envFp?: string | null };
export type ModelCheckLite = Record<string, { n: number; samePath: number }>;
export type CoordEventLite = { at: string; kind: string; label: string; ids: string[]; usd: number };
export type SavingsInput = {
  usage: UsageRowLite[]; baseline: BaselineFileLite[]; ledger: LedgerLite[]; modelCheckByType: ModelCheckLite; coord: CoordEventLite[];
  /** その回で使った env（スイッチの off を見る）。省くと見ない */
  env?: Record<string, string | undefined>;
  /** 2倍の時間か（llm-price の isDeepseekPeakAt か exam-brain の examPeakAt を渡す） */
  isPeak: (d: Date) => boolean;
  /** 次の安い時間の始まり */
  nextCheap: (d: Date) => Date;
  flashTypeMinN: number;
  /** ソースにあるスイッチ（他の担当がまだ入れていないスイッチは「無い」） */
  available?: (envName: string) => boolean;
  at?: string;
};

const r2 = (x: number) => Math.round(x * 1000) / 1000;
const routeLabel = (route: string) => route.replace(/^script:brain-exam-/, "");
function capList<T>(xs: Iterable<T>, cap = 12): T[] { const out: T[] = []; for (const x of xs) { if (!out.includes(x)) out.push(x); if (out.length >= cap) break; } return out; }
function countBy<T>(xs: ReadonlyArray<T>, f: (x: T) => string): Record<string, number> { const m: Record<string, number> = {}; for (const x of xs) { const k = f(x); m[k] = (m[k] ?? 0) + 1; } return m; }
function topCounts(m: Record<string, number>, cap = 8): Record<string, number> { return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, cap)); }

/** 回（label）ごとの、問題×1回あたりの費用（llm_usage_logs の route の $ ÷ 台帳の回数） */
export function costPerRepByLabel(usage: ReadonlyArray<UsageRowLite>, ledger: ReadonlyArray<LedgerLite>): Map<string, number> {
  const usd = new Map<string, number>();
  for (const u of usage) { const l = routeLabel(u.route); usd.set(l, (usd.get(l) ?? 0) + u.usd); }
  const reps = new Map<string, number>();
  for (const l of ledger) if (!l.reused) reps.set(l.label, (reps.get(l.label) ?? 0) + Math.max(1, l.reps));
  const out = new Map<string, number>();
  for (const [label, n] of reps) {
    const s = usd.get(label) ?? 0; // route は script:brain-exam-<label> そのもの（段ごとに label が別: -d・-fl）
    if (n > 0 && s > 0) out.set(label, s / n);
  }
  return out;
}

// ─── 見つける（決まった計算） ─────────────────────────────────────────────
/** ① 版が変わっても答えが同じだった main の作り直し（お金を使って同じ答え）／入力が同じなのに呼んだ */
export function detectBaselineWaste(b: ReadonlyArray<BaselineFileLite>, at?: string): SavingHit[] {
  const out: SavingHit[] = [];
  const same = b.filter((f) => f.realUsd > 0 && f.sameAnswersAsPrev === true && !f.allInputSame);
  if (same.length) out.push({ key: "version-same-content", kind: "version_same_content", title: "main の答えを作り直したのに前の版と同じ答え（関係ない push でも作り直す）", safe: true, at,
    usd: r2(same.reduce((s, f) => s + f.realUsd, 0)), detail: `作り直した ${same.length}問が前の版と道・合否とも同じ`,
    evidence: { versions: capList(same.map((f) => f.version)), ids: capList(same.map((f) => f.id), 20), counts: { files: same.length, calls: same.reduce((s, f) => s + f.realCalls, 0) } } });
  const inSame = b.filter((f) => f.realUsd > 0 && f.allInputSame);
  if (inSame.length) out.push({ key: "regen-same-input", kind: "regen_same_input", title: "main の答えで入力が前と同じなのに AI を呼んだ", safe: true, at,
    usd: r2(inSame.reduce((s, f) => s + f.realUsd, 0)), detail: `入力が前と同じ ${inSame.length}問で呼んだ（前の答えを使えた）`,
    evidence: { versions: capList(inSame.map((f) => f.version)), ids: capList(inSame.map((f) => f.id), 20), counts: { files: inSame.length } } });
  return out;
}

/** ② 2倍の時間の呼び出し（安い時間が60分以内に始まる物＝待てた物の半分を見込む） */
export const PEAK_WAITABLE_MIN = 60;
export function detectPeak(usage: ReadonlyArray<UsageRowLite>, isPeak: (d: Date) => boolean, nextCheap: (d: Date) => Date, at?: string): SavingHit[] {
  const peak = usage.filter((u) => /deepseek/.test(u.model) && isPeak(new Date(u.created_at)));
  if (!peak.length) return [];
  const waitable = peak.filter((u) => { const d = new Date(u.created_at); return nextCheap(d).getTime() - d.getTime() <= PEAK_WAITABLE_MIN * 60_000; });
  const usd = r2(waitable.reduce((s, u) => s + u.usd / 2, 0));
  if (!(usd > 0)) return [];
  const in30 = waitable.filter((u) => { const d = new Date(u.created_at); return nextCheap(d).getTime() - d.getTime() <= 30 * 60_000; }).length;
  return [{ key: "peak-hour-calls", kind: "peak_hour", title: "2倍の時間に呼んだ（安い時間まで60分以内＝待てた）", safe: true, at, usd,
    detail: `2倍の時間 ${peak.length}回（うち待てた ${waitable.length}回・30分以内 ${in30}回＝EXAM_PEAK_WAIT_MIN の既定で待つ所・半額になった分）`,
    evidence: { routes: capList(waitable.map((u) => u.route)), counts: { peak: peak.length, waitable: waitable.length, within30: in30 }, actions: capList(waitable.map((u) => u.action ?? "")) } }];
}

/** ③ flash で足りそうな型（model-check で道が全部同じ）を pro で流した＋flash の割合 */
export function detectFlashEligible(ledger: ReadonlyArray<LedgerLite>, mc: ModelCheckLite, cpr: ReadonlyMap<string, number>, minN: number, usage: ReadonlyArray<UsageRowLite>, at?: string): SavingHit[] {
  const brain = usage.filter((u) => /^brain_f/.test(u.action ?? ""));
  const flashShare = brain.length ? brain.filter((u) => /deepseek-flash/.test(u.model)).length / brain.length : 0;
  const eligible = (t: string) => { const s = mc[t]; return !!s && s.n >= 2 && s.samePath === s.n; };
  const hits = ledger.filter((l) => !l.reused && /pro/.test(l.model) && eligible(l.type));
  if (!hits.length) return [];
  const usd = r2(hits.reduce((s, l) => s + (cpr.get(l.label) ?? 0) * Math.max(1, l.reps) * FLASH_SAVE_RATIO, 0));
  const stuck = [...new Set(hits.map((l) => l.type))].filter((t) => (mc[t]?.n ?? 0) < minN);
  return [{ key: "flash-eligible-pro", kind: "flash_eligible_pro", title: "flash で道が同じだった型を pro で流した（flash の証明の回数が足りない）", safe: true, at, usd,
    detail: `pro で流した ${hits.length}問・型 ${new Set(hits.map((l) => l.type)).size}（証明 ${minN}回に足りない型 ${stuck.length}）・ブレインの呼び出しの flash の割合 ${Math.round(flashShare * 100)}%`,
    evidence: { ids: capList(hits.map((l) => l.id), 20), run_labels: capList(hits.map((l) => l.label)), counts: { ...topCounts(countBy(hits, (l) => l.type)), flash_share_pct: Math.round(flashShare * 100) } } }];
}

/** ④ 決まった前置きのキャッシュが当たらない（action ごと・当たり 80%未満・外れの入力が多い） */
export const CACHE_TARGET = 0.9;
export function detectCacheMiss(usage: ReadonlyArray<UsageRowLite>, at?: string): SavingHit[] {
  const by = new Map<string, UsageRowLite[]>();
  for (const u of usage) { const p = priceOf(u.model); if (!p || !u.action) continue; const k = `${u.action}|${u.model}`; by.set(k, [...(by.get(k) ?? []), u]); }
  const out: SavingHit[] = [];
  for (const [k, rs] of by) {
    const [action, model] = k.split("|");
    const unc = rs.reduce((s, u) => s + u.input_uncached, 0), cr = rs.reduce((s, u) => s + u.cache_read, 0), tot = unc + cr;
    if (rs.length < 5 || tot <= 0) continue;
    const hit = cr / tot, avgUnc = unc / rs.length;
    if (hit >= 0.8 || avgUnc < 5000) continue;
    const p = priceOf(model)!;
    const usd = r2((tot * Math.max(0, CACHE_TARGET - hit) * (p.in - p.read)) / 1e6);
    if (!(usd >= 0.05)) continue;
    const safeAction = action.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
    out.push({ key: `cache-miss:${safeAction}`, kind: "cache_miss_prefix", title: `前置きのキャッシュが当たらない（${action}）`, safe: true, at, usd,
      detail: `${rs.length}回・当たり ${Math.round(hit * 100)}%・外れの入力 平均 ${Math.round(avgUnc)}（決まった部分を前に寄せれば ${Math.round(CACHE_TARGET * 100)}% まで）`,
      evidence: { actions: [action], counts: { calls: rs.length, hit_pct: Math.round(hit * 100), avg_uncached: Math.round(avgUnc) } } });
  }
  return out;
}

/** ⑤ 同じ問題×入力（段・効くファイルの鍵・スイッチ・比べる main）を別の回で2回以上流した */
export function detectDuplicateRuns(ledger: ReadonlyArray<LedgerLite>, cpr: ReadonlyMap<string, number>, coord: ReadonlyArray<CoordEventLite>, at?: string): SavingHit[] {
  const g = new Map<string, LedgerLite[]>();
  for (const l of ledger) { if (l.reused) continue; const k = [l.id, l.stage, l.scopeKey, l.envFp ?? "", l.base ?? "", l.model].join("|"); g.set(k, [...(g.get(k) ?? []), l]); }
  const dups: LedgerLite[] = [];
  for (const ls of g.values()) { const labels = [...new Set(ls.map((l) => l.label))]; if (labels.length < 2) continue; const first = labels[0]; dups.push(...ls.filter((l) => l.label !== first)); }
  const refused = coord.filter((e) => e.kind === "dup-refused");
  if (!dups.length) return [];
  const usd = r2(dups.reduce((s, l) => s + (cpr.get(l.label) ?? 0) * Math.max(1, l.reps), 0));
  return [{ key: "duplicate-run", kind: "duplicate_run", title: "同じ問題×入力を別の回でもう一度流した", safe: true, at, usd,
    detail: `重なり ${dups.length}問（連携が止めた同じ比べ ${refused.length}回は別）`,
    evidence: { ids: capList(dups.map((l) => l.id), 20), run_labels: capList(dups.map((l) => l.label)), counts: { dups: dups.length, refused: refused.length } } }];
}

/** ⑥ 揺れない問題で全部の回が同じ答え＝2回目からは要らなかった（揺れる問題・関所は除く） */
export function detectRepsOverkill(ledger: ReadonlyArray<LedgerLite>, cpr: ReadonlyMap<string, number>, at?: string): SavingHit[] {
  const over = ledger.filter((l) => !l.reused && l.reps >= 2 && l.codes.length === 1 && (l.flake ?? "") !== "flaky" && !/gate/.test(l.label));
  if (!over.length) return [];
  const usd = r2(over.reduce((s, l) => s + (cpr.get(l.label) ?? 0) * (l.reps - 1), 0));
  if (!(usd > 0)) return [];
  return [{ key: "reps-overkill", kind: "reps_overkill", title: "揺れない問題で回を重ねて全部同じ答え", safe: false, at, usd,
    detail: `${over.length}問で余分な回 ${over.reduce((s, l) => s + l.reps - 1, 0)}（回を減らすと揺れを見落とす恐れ＝質に関わる）`,
    evidence: { ids: capList(over.map((l) => l.id), 20), run_labels: capList(over.map((l) => l.label)), counts: { problems: over.length } } }];
}

/** ⑦ 出力が長い（action ごと・平均 1000 字句を超える）。使っていない部分の目安は 40% */
export const OVERLONG_OUT = 1000, OVERLONG_CUT = 0.4;
export function detectOverlongOutput(usage: ReadonlyArray<UsageRowLite>, at?: string): SavingHit[] {
  const by = new Map<string, UsageRowLite[]>();
  for (const u of usage) { if (!u.action || !priceOf(u.model)) continue; by.set(u.action, [...(by.get(u.action) ?? []), u]); }
  const out: SavingHit[] = [];
  for (const [action, rs] of by) {
    const avg = rs.reduce((s, u) => s + u.output_tokens, 0) / rs.length;
    if (rs.length < 5 || avg < OVERLONG_OUT) continue;
    const usd = r2(rs.reduce((s, u) => s + (u.output_tokens * OVERLONG_CUT * priceOf(u.model)!.out) / 1e6, 0));
    const grp = /^brain_f/.test(action) ? "brain" : action.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
    out.push({ key: `overlong-output:${grp}`, kind: "overlong_output", title: `出力が長い（${grp === "brain" ? "ブレインの判断 brain_fresh/brain_full" : action}・短くすると判断の質に関わる）`, safe: false, at, usd,
      detail: `${action} ${rs.length}回・出力 平均 ${Math.round(avg)}`,
      evidence: { actions: [action], counts: { calls: rs.length, avg_out: Math.round(avg) } } });
  }
  // brain_fresh と brain_full は同じ鍵にまとまる（aggregate で足す）
  return out;
}

// ─── 自分で直す道（質を変えないスイッチ） ─────────────────────────────────
/** 種類 → 既にある質を変えないスイッチ。off（offValues）の回があれば、次の回から want（undefined＝消して既定に戻す）にする */
export type SafeAction = { id: string; env: string; offValues: string[]; want?: string; kinds: SavingKind[]; why: string; /** 他の担当のスイッチ（まだ無いかもしれない）。ソースに名前がある時だけ使う */ external?: boolean };
export const SAFE_ACTIONS: readonly SafeAction[] = [
  { id: "input-diff", env: "EXAM_INPUT_DIFF", offValues: ["off"], kinds: ["regen_same_input", "version_same_content", "duplicate_run"], why: "入力が main と同じ問題×回は呼ばない（答えは同じ）" },
  { id: "baseline-pin", env: "EXAM_BASELINE_PIN", offValues: ["off"], kinds: ["regen_same_input", "version_same_content"], why: "main の作り直しで要求が同じ段は前の答え" },
  { id: "baseline-incremental", env: "EXAM_BASELINE_INCREMENTAL", offValues: ["off"], kinds: ["version_same_content"], why: "main の答えは変わった問題だけ作り直す" },
  { id: "peak-wait", env: "EXAM_PEAK_WAIT_MIN", offValues: ["off", "0"], kinds: ["peak_hour"], why: "安い時間が30分以内なら待ってから流す（半額）" },
  { id: "judge-cache", env: "EXAM_JUDGE_CACHE", offValues: ["off"], kinds: ["duplicate_run", "other"], why: "同じ答えの判定は控えを使う" },
  { id: "reuse-conv", env: "EXAM_REUSE_CONV", offValues: ["off"], kinds: ["duplicate_run"], why: "会話が同じなら前の答えを使い回す（会話を見て決める）" },
  { id: "reps-confidence", env: "EXAM_REPS", offValues: ["old", "wide"], kinds: ["reps_overkill"], why: "回数は自信が低い問題だけ足す（既定）" },
  { id: "warm-coalesce", env: "EXAM_WARM_COALESCE", offValues: ["off"], kinds: ["version_same_content", "duplicate_run"], why: "同じ版の取り置きを1本にまとめる（perf/exam-main-key）", external: true },
  { id: "main-key", env: "EXAM_MAIN_KEY", offValues: ["off"], kinds: ["version_same_content"], why: "main の答えはブレインのファイルの指紋で鍵（関係ない push で作り直さない・perf/exam-main-key）", external: true },
  { id: "flash-screen", env: "EXAM_FLASH_SCREEN", offValues: ["off"], kinds: ["flash_eligible_pro"], why: "flash で先に見て pro で確かめる（perf/exam-flash-screen）", external: true },
];

/** その回で off だった質を変えないスイッチ（ソースにある物だけ）→ 自分で直す候補 */
export function offSafeSwitches(env: Record<string, string | undefined>, available: (name: string) => boolean = () => true): SafeAction[] {
  return SAFE_ACTIONS.filter((a) => {
    const v = String(env[a.env] ?? "").trim().toLowerCase();
    return !!v && a.offValues.includes(v) && (!a.external || available(a.env));
  });
}
/** スイッチが off の印（無駄の見込みは同じ種類の他の印の $ を後で足す・ここは 0） */
export function detectSwitchesOff(env: Record<string, string | undefined> | undefined, available?: (name: string) => boolean, at?: string): SavingHit[] {
  if (!env) return [];
  return offSafeSwitches(env, available).map((a) => ({ key: `switch-off:${a.env.toLowerCase()}`, kind: a.kinds[0], title: `節約のスイッチ ${a.env} が off で流れた`, safe: true, at, usd: 0,
    detail: `${a.env}=${env[a.env]}（${a.why}）`, evidence: { switches: [`${a.env}=${env[a.env]}`] } }));
}

/** 全部の見つけ方を回す */
export function detectSavings(inp: SavingsInput): SavingHit[] {
  const at = inp.at;
  const cpr = costPerRepByLabel(inp.usage, inp.ledger);
  return [
    ...detectBaselineWaste(inp.baseline, at),
    ...detectPeak(inp.usage, inp.isPeak, inp.nextCheap, at),
    ...detectFlashEligible(inp.ledger, inp.modelCheckByType, cpr, inp.flashTypeMinN, inp.usage, at),
    ...detectCacheMiss(inp.usage, at),
    ...detectDuplicateRuns(inp.ledger, cpr, inp.coord, at),
    ...detectRepsOverkill(inp.ledger, cpr, at),
    ...detectOverlongOutput(inp.usage, at),
    ...detectSwitchesOff(inp.env, inp.available, at),
  ];
}

// ─── まとめ・足し合わせ ──────────────────────────────────────────────────
const MAX_EV = 20, MAX_DAYS = 7;
function mergeArr<T>(a: ReadonlyArray<T> | undefined, b: ReadonlyArray<T> | undefined, cap = MAX_EV): T[] | undefined { const x = capList([...(a ?? []), ...(b ?? [])], cap); return x.length ? x : undefined; }
/** 新しい印を前に。counts は上書き（最後の窓の数）。days は mode=add（1回の試験＝今日に足す）／set（今日の全部＝上書き） */
export function mergeSavingEvidence(oldEv: SavingEvidence | null | undefined, add: SavingEvidence, o: { day?: string; usd?: number; mode?: "add" | "set" } = {}): SavingEvidence {
  const e = oldEv ?? {};
  const out: SavingEvidence = {};
  const set = <K extends keyof SavingEvidence>(k: K, v: SavingEvidence[K] | undefined) => { if (v !== undefined) out[k] = v; };
  set("run_labels", mergeArr(add.run_labels, e.run_labels));
  set("routes", mergeArr(add.routes, e.routes));
  set("actions", mergeArr(add.actions, e.actions));
  set("ids", mergeArr(add.ids, e.ids));
  set("versions", mergeArr(add.versions, e.versions));
  set("switches", mergeArr(add.switches, e.switches));
  if (add.counts || e.counts) out.counts = { ...(add.counts ?? e.counts) };
  const days: Record<string, number> = { ...(e.days ?? {}), ...(add.days ?? {}) };
  if (o.day && typeof o.usd === "number") days[o.day] = r2(o.mode === "set" ? o.usd : (days[o.day] ?? 0) + o.usd);
  const keep = Object.keys(days).sort().slice(-MAX_DAYS);
  if (keep.length) out.days = Object.fromEntries(keep.map((d) => [d, days[d]]));
  return out;
}
/** 1日あたりの見込み＝記録した日の平均（無ければ 0） */
export function perDayOf(ev: SavingEvidence | null | undefined): number {
  const v = Object.values(ev?.days ?? {}); return v.length ? r2(v.reduce((s, x) => s + x, 0) / v.length) : 0;
}
/** 同じ鍵をまとめる（$ と数は足す・印は合わせる） */
export function aggregateSavingHits(hits: ReadonlyArray<SavingHit>): SavingHit[] {
  const m = new Map<string, SavingHit>();
  for (const h of hits) {
    if (!isSavingKey(h.key)) continue;
    const a = m.get(h.key);
    if (!a) { m.set(h.key, { ...h, evidence: mergeSavingEvidence(null, h.evidence) }); continue; }
    a.usd = r2(a.usd + h.usd);
    a.evidence = mergeSavingEvidence(h.evidence, a.evidence);
    if (h.detail && a.detail && !a.detail.includes(h.detail)) a.detail = `${a.detail}／${h.detail}`.slice(0, 400);
  }
  return [...m.values()].sort((a, b) => b.usd - a.usd);
}
/** JST の日付 */
export function jstDay(iso: string): string { const t = Date.parse(iso); return new Date((Number.isFinite(t) ? t : Date.now()) + 9 * 3_600_000).toISOString().slice(0, 10); }

/** 既存の行と足し合わせる（新しい鍵は open か needs_owner＝質に関わる物・状態・題は人が付けた物を残す） */
export function mergeSavingRow(existing: SavingRow | null, h: SavingHit, nowIso: string, o: { mode?: "add" | "set"; label?: string } = {}): SavingRow {
  const at = h.at ?? nowIso, day = jstDay(at);
  const ev = mergeSavingEvidence(existing?.evidence ?? null, { ...h.evidence, ...(o.label ? { run_labels: [o.label, ...(h.evidence.run_labels ?? [])] } : {}) }, { day, usd: h.usd, mode: o.mode ?? "add" });
  if (!existing) {
    return { key: h.key, title: h.title, kind: h.kind, detail: h.detail ?? null, est_usd_per_day: perDayOf(ev), evidence: ev, status: h.safe ? "open" : "needs_owner", safe: h.safe,
      fix_ref: null, occurrences: 1, first_seen: at, last_seen: at };
  }
  // 直した・自動で直したのに再び出た → 状態は残す（render で ⚠ を出す）
  return { ...existing, detail: h.detail ?? existing.detail, evidence: ev, est_usd_per_day: perDayOf(ev), occurrences: (existing.occurrences ?? 0) + 1,
    first_seen: existing.first_seen ?? at, last_seen: existing.last_seen && existing.last_seen > at ? existing.last_seen : at };
}

// ─── 自分で直す（決める所だけ・純関数） ────────────────────────────────────
export type AutoApplied = { env: string; value: string | null; key: string; at: string; why: string; from: string };
export type AutoFile = { applied: AutoApplied[] };
/**
 * 見つかった印から、次の回で自動で戻すスイッチを決める。① その回で off だった質を変えないスイッチ（switch-off:）、
 *   ② $ の出た種類に対応するスイッチが off だった物。既に自動で戻した物は足さない。
 */
export function planAutoApply(hits: ReadonlyArray<SavingHit>, env: Record<string, string | undefined>, prev: AutoFile, nowIso: string, available?: (name: string) => boolean): AutoApplied[] {
  const off = offSafeSwitches(env, available);
  const kinds = new Set(hits.filter((h) => h.usd > 0 || h.key.startsWith("switch-off:")).map((h) => h.kind));
  const have = new Set(prev.applied.map((a) => a.env));
  const out: AutoApplied[] = [];
  for (const a of off) {
    if (have.has(a.env)) continue;
    const hit = hits.find((h) => h.key === `switch-off:${a.env.toLowerCase()}`) ?? hits.find((h) => a.kinds.includes(h.kind) && h.usd > 0);
    if (!hit && !a.kinds.some((k) => kinds.has(k))) continue;
    out.push({ env: a.env, value: a.want ?? null, key: hit?.key ?? `switch-off:${a.env.toLowerCase()}`, at: nowIso, why: a.why, from: `${a.env}=${env[a.env]}` });
  }
  return out;
}
/**
 * 試験の始まりで env に当てる。explicit（--switch= や引数で人が決めた名前）は触らない。返り値はログ用。
 *   EXAM_SAVINGS_AUTO=off なら何もしない
 */
export function applyAutoToEnv(env: Record<string, string | undefined>, file: AutoFile, explicit: ReadonlySet<string> = new Set()): string[] {
  if (!examSavingsAutoEnabled(env)) return [];
  const notes: string[] = [];
  for (const a of file.applied) {
    if (explicit.has(a.env)) { notes.push(`${a.env}: 人が決めた値を使う（節約の自動は当てない）`); continue; }
    const cur = env[a.env];
    const act = SAFE_ACTIONS.find((s) => s.env === a.env);
    if (!act || !act.offValues.includes(String(cur ?? "").trim().toLowerCase())) continue; // off でなければ触らない
    if (a.value === null) delete env[a.env]; else env[a.env] = a.value;
    notes.push(`${a.env}: ${cur} → ${a.value ?? "既定"}（節約の台帳 ${a.key}・止める EXAM_SAVINGS_AUTO=off）`);
  }
  return notes;
}

// ─── 竹内さんへの質問（質に関わる案） ─────────────────────────────────────
export function ownerQuestionFor(r: Pick<SavingRow, "key" | "title" | "detail" | "est_usd_per_day" | "kind">): Record<string, unknown> {
  const rec = RECOMMEND[r.kind] ?? RECOMMEND.other;
  return {
    kind: "question", topic: "費用",
    question: `試験の節約: ${r.title}（見込み 約 $${r.est_usd_per_day.toFixed(2)}/日）。質に関わるので決めてください。${r.detail ? `中身: ${r.detail}` : ""}`.slice(0, 600),
    options: rec.options, recommended: rec.recommended, why: rec.why,
    source_kind: "exam_savings", source_ref: `exam_savings:${r.key}`, priority: 2, dedupe_key: `exam-savings:${r.key}`,
  };
}
const RECOMMEND: Partial<Record<SavingKind, { options: string[]; recommended: string; why: string }>> & { other: { options: string[]; recommended: string; why: string } } = {
  overlong_output: { options: ["出力を短くする（判断の理由を短く・決まった形）を試験で比べてから入れる", "今のまま"], recommended: "出力を短くする形を試験で比べてから入れる", why: "道が変わらなければ出力の費用が約4割減る・比べてから決めるので質は守れる" },
  reps_overkill: { options: ["揺れない問題は1回で止める", "今のまま（回を重ねる）"], recommended: "今のまま（既定の自信で足す回数で十分）", why: "揺れの見落としは質を下げる・額が小さいうちは守りを優先" },
  other: { options: ["入れる（試験で比べてから）", "入れない"], recommended: "試験で比べてから入れる", why: "質に関わるので比べた数字で決める" },
};

// ─── 種（10/23 竹内さんの「無駄な部分優先」の時に分かっていた物） ─────────────
type Seed = Omit<SavingRow, "evidence" | "occurrences" | "first_seen" | "last_seen" | "id">;
const S = (key: string, kind: SavingKind, status: SavingStatus, safe: boolean, est: number, title: string, detail: string, fix_ref: string | null = null): Seed => ({ key, kind, status, safe, est_usd_per_day: est, title, detail, fix_ref });
export const SEED_SAVINGS: readonly Seed[] = [
  S("version-same-content", "version_same_content", "open", true, 9.9, "main の答えを作り直したのに前の版と同じ答え（関係ない push でも作り直す）", "10/23 見えた分 $9.9/日。main の答えの鍵がコミット全体で、ブレインに効かない push でも作り直す", "perf/exam-main-key（ブレインのファイルの指紋で鍵・作業中）"),
  S("flash-eligible-pro", "flash_eligible_pro", "open", true, 6.0, "flash で道が同じだった型を pro で流した（flash の証明の回数が足りない）", "ブレインの呼び出しの flash 0%（10/21〜23）。model-check が n=3 で止まり型の証明 5回に届かない。pro のブレイン約 $18/日の半分を flash にした場合の見込み", "perf/exam-flash-screen（flash で先に見て pro で確かめる・作業中）"),
  S("peak-hour-calls", "peak_hour", "fixed", true, 0.5, "2倍の時間に呼んだ（安い時間まで30分以内＝待てた）", "2倍の時間の終わり30分以内に流していた", "32c2cde9 EXAM_PEAK_WAIT_MIN（既定30分待つ）"),
  S("cache-miss:brain_fresh", "cache_miss_prefix", "open", true, 3.3, "前置きのキャッシュが当たらない（brain_fresh）", "決まった前置きが約35k で切れる（作戦の段 B が回ごとに変わる）。B を後ろに寄せれば外れの入力 約1.19万→約0.7万（brain_full 並み）・1053回/日"),
  S("m0-reuse", "other", "needs_owner", false, 0, "main の1回目の答え（m0）を担当の1回目に使い回す", "入力が同じでなくても使い回す案＝揺れ・差の見落としがあり質に関わる。見込みは未計測"),
  S("overlong-output:brain", "overlong_output", "needs_owner", false, 1.8, "出力が長い（ブレインの判断 brain_fresh/brain_full）", "出力 平均 約1.1k（2008回/日・出力 $4.6/日）。4割短くできれば約 $1.8/日。判断の質に関わる"),
];

// ─── 見せ方 ─────────────────────────────────────────────────────────────
export function renderTopSavings(rows: ReadonlyArray<Pick<SavingRow, "key" | "title" | "status" | "est_usd_per_day" | "occurrences" | "fix_ref" | "safe">>, n = 5): string {
  const open = rows.filter((r) => r.status === "open" || r.status === "needs_owner").sort((a, b) => b.est_usd_per_day - a.est_usd_per_day).slice(0, n);
  if (!open.length) return "節約の台帳: 開いている案なし";
  const sum = open.reduce((s, r) => s + r.est_usd_per_day, 0);
  const lines = [`節約の台帳（開いている上位 ${open.length}・合わせて約 $${sum.toFixed(2)}/日）:`];
  for (const r of open) lines.push(`  [${SAVING_STATUS_JA[r.status]}${r.safe ? "" : "・質に関わる"}] 約 $${r.est_usd_per_day.toFixed(2)}/日 ${r.title}（${r.key}・${r.occurrences}回）${r.fix_ref ? ` → ${r.fix_ref}` : ""}`);
  return lines.join("\n");
}
export function renderRunSavings(hits: ReadonlyArray<SavingHit>, auto: ReadonlyArray<AutoApplied>, rows?: ReadonlyArray<Pick<SavingRow, "key" | "status" | "fix_ref">>): string {
  const ag = aggregateSavingHits(hits).filter((h) => h.usd > 0 || h.key.startsWith("switch-off:"));
  if (!ag.length && !auto.length) return "節約の台帳: この回の無駄は見つからない";
  const st = new Map((rows ?? []).map((r) => [r.key, r]));
  const lines = [`節約の台帳: この回の無駄 ${ag.length}種・約 $${ag.reduce((s, h) => s + h.usd, 0).toFixed(3)}`];
  for (const h of ag.slice(0, 8)) {
    const r = st.get(h.key);
    const back = r && (r.status === "fixed" || r.status === "auto_applied") ? `・⚠ ${SAVING_STATUS_JA[r.status]}のはず（${r.fix_ref ?? ""}）` : r ? `・${SAVING_STATUS_JA[r.status]}` : "";
    lines.push(`  $${h.usd.toFixed(3)} ${h.title}（${h.key}${back}）`);
  }
  for (const a of auto) lines.push(`  ↺ 次の回から自動で戻す: ${a.from} → ${a.value ?? "既定"}（${a.why}・止める EXAM_SAVINGS_AUTO=off）`);
  return lines.join("\n");
}

/** 他の担当の直し（external のスイッチ）がソースに入ったか → その種類の案に「直しが入った・数え直しで減ったら fixed に」と知らせる */
export function externalFixNotes(rows: ReadonlyArray<Pick<SavingRow, "key" | "kind" | "status">>, available: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const a of SAFE_ACTIONS.filter((x) => x.external && available(x.env))) {
    for (const r of rows.filter((x) => (x.status === "open" || x.status === "needs_owner") && a.kinds.includes(x.kind))) out.push(`直しのスイッチ ${a.env} が入った（${a.why}）→ ${r.key} が次の数え直しで減っていれば --set-status ${r.key} fixed`);
  }
  return out;
}
