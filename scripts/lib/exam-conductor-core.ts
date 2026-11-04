// scripts/lib/exam-conductor-core.ts — 試験の統括の純関数（関所の時間・早めの打ち切り・揺れの回数・問題の選び・入れる順番の表への書き戻し）
//   scripts/exam-conductor.ts が使う。DB・ファイル・子の実行は持たない（テストは scripts/__tests__/exam-conductor.test.ts）
import type { FlakeObs } from "./exam-flake";
import { flakeVerdict } from "./exam-flake";

// ─── 関所の時間 ───────────────────────────────────────────────────────────
const jstHM = (d: Date) => { const j = new Date(d.getTime() + 9 * 3600_000); return { h: j.getUTCHours(), dow: j.getUTCDay() }; };
/** DeepSeek の安い時間（平日 JST 10〜13・15〜19 は2倍＝流さない） */
export function cheapNow(d = new Date()): boolean { const { h, dow } = jstHM(d); if (dow === 0 || dow === 6) return true; return !((h >= 10 && h < 13) || (h >= 15 && h < 19)); }
/** 本数の上限（JST 9〜22 は1本・それ以外は2本） */
export function maxExamsNow(d = new Date()): number { const { h } = jstHM(d); return h >= 9 && h < 22 ? 1 : 2; }

// ─── ① 早めの打ち切り ─────────────────────────────────────────────────────
//   brain-exam の合格は「その問題の回の過半数が合格」（passN*2 > n）。予定の回数 n のうち落ちた回 f が f*2 >= n になった時点で、その問題はもう合格できない。
//   前（main）で合格していた問題がそうなったら「悪化が確定」＝残りを回しても判断（悪化0か）は変わらない → 止める。
//   どの問題も合否が決まった（残りの回で変わらない）時も止める（残りは答えを変えない回＝無駄）。
//   ※ 行の score.pass は試験の中の採点。最後の集計（rescore）で変わる事がまれにある＝打ち切った後に --report で集計し直した数を正とする
export type RowLite = { id: string; rep: number; error?: string; score?: { pass?: boolean }; foreignMsgs?: number; pcMismatch?: string[] };
/** 2026-11-04 作業員2の頼み: 混ざりの印のある回（他の問題の発言が混ざった・条件の行が回す前に違った）は、悪化とも合格とも数えない（brain-exam の混ざりの印と同じ見方） */
export function isMixedRow(r: RowLite): boolean { return (r.foreignMsgs ?? 0) > 0 || (r.pcMismatch ?? []).some((k) => k !== "他の問題の発言"); }
export type EarlyVerdict = { stop: "worse" | "settled" | null; why: string; worse: string[] };
/** flaky: 揺れる問題。11/03 指揮役: n7 で q015 の 3/4→2/4（1回の差）で全体を止めた → 揺れる問題は main の落ちる割合より2回以上多く落ちた時だけ止める（普通の問題は今の線） */
export function earlyVerdict(cur: RowLite[], base: RowLite[], planned: Record<string, number>, flaky: ReadonlySet<string> = new Set()): EarlyVerdict {
  const tally = (rows: RowLite[]) => { const m = new Map<string, { p: number; f: number }>(); for (const r of rows) { if (r.error || isMixedRow(r)) continue; const x = m.get(r.id) ?? { p: 0, f: 0 }; if (r.score?.pass) x.p++; else x.f++; m.set(r.id, x); } return m; };
  const c = tally(cur), b = tally(base);
  const basePass = (id: string) => { const x = b.get(id); return !!x && x.p * 2 > x.p + x.f; };
  /** main の落ちる割合を今の予定の回数に当てた「いつもの落ちる回数」 */
  const baseFails = (id: string, n: number) => { const x = b.get(id); return x && x.p + x.f ? (x.f / (x.p + x.f)) * n : 0; };
  const worse: string[] = [];
  let unsettled = 0;
  for (const [id, n] of Object.entries(planned)) {
    const x = c.get(id) ?? { p: 0, f: 0 };
    const failLocked = x.f * 2 >= n, passLocked = x.p * 2 > n;
    if (failLocked && basePass(id) && (!flaky.has(id) || x.f - baseFails(id, n) >= 2)) worse.push(id);
    if (!failLocked && !passLocked) unsettled++;
  }
  if (worse.length) return { stop: "worse", why: `前に合格していた ${worse.join(",")} が残りの回でも合格に届かない（悪化の確定）`, worse };
  if (Object.keys(planned).length && unsettled === 0) return { stop: "settled", why: "全部の問題の合否が決まった（残りの回は答えを変えない）", worse };
  return { stop: null, why: `決まっていない問題 ${unsettled}`, worse };
}

/** 最後の結果の悪化を「確かな悪化」と「揺れの範囲の差」に分ける（11/03 指揮役）:
 *  前に合格（過半数）で今は不合格の問題のうち、揺れる問題で、合格の回数の差が main の割合に当てて2回未満なら「揺れの範囲」 */
/** 2026-11-04 つなぎの芯の頼み: 今と前（基準）の両方で、失敗・混ざりの無い回が1つ以上ある問題（＝本当に比べた問題）。0 なら「悪化0」ではなく「比べられない」 */
export function comparedIds(cur: RowLite[], base: RowLite[]): string[] {
  const ok = (rows: RowLite[]) => new Set(rows.filter((r) => !r.error && !isMixedRow(r)).map((r) => r.id));
  const b = ok(base);
  return [...ok(cur)].filter((id) => b.has(id));
}
/** 2026-11-04 作業員1（統括役の了承 (b)）: 依頼の作業ツリーの brain-exam.ts が止める印を見ない（3e9a855 より前）時は、上限で止めても子が止まらず殺されて輪になる。
 *  その時は上限を延ばす（longMin・既定 120分）。behind＝依頼の作業ツリーの HEAD が origin/main より古い commit の数（分からなければ null） */
export function staleExamGuard(src: string, behind: number | null, maxMin: number, longMin: number): { maxMin: number; oldStop: boolean; laneOld: boolean; note: string } {
  const oldStop = !src.includes("stopAsked(");
  // 2026-11-04 (i): レーンの直し（取った会話を skip で渡す）が無い brain-exam.ts はレーンが全部 YUMA2 になる＝その依頼だけ1レーン
  const laneOld = !src.includes("skip: LANES");
  const laneNote = laneOld ? "古い brain-exam（レーンが同じ会話になる）・1レーンで回す" : "";
  const behindNote = behind != null && behind > 0 ? `作業ツリーが origin/main より ${behind}個古い` : "";
  if (!oldStop) return { maxMin, oldStop, laneOld, note: [laneNote, behindNote].filter(Boolean).join("・") };
  const m = maxMin > 0 ? Math.max(maxMin, longMin) : maxMin;
  return { maxMin: m, oldStop, laneOld, note: [`古い brain-exam（止める印を見ない）・上限を延ばした ${maxMin}→${m}分`, laneNote, behindNote].filter(Boolean).join("・") };
}
export function splitWorse(cur: RowLite[], base: RowLite[], flaky: ReadonlySet<string>): { sure: Array<{ id: string; why: string }>; flake: Array<{ id: string; why: string }> } {
  const tally = (rows: RowLite[]) => { const m = new Map<string, { p: number; n: number }>(); for (const r of rows) { if (r.error || isMixedRow(r)) continue; const x = m.get(r.id) ?? { p: 0, n: 0 }; x.n++; if (r.score?.pass) x.p++; m.set(r.id, x); } return m; };
  const c = tally(cur), b = tally(base);
  const sure: Array<{ id: string; why: string }> = [], flake: Array<{ id: string; why: string }> = [];
  for (const [id, x] of c) {
    const y = b.get(id);
    if (!y || !(y.p * 2 > y.n) || x.p * 2 > x.n) continue;
    const gap = (y.p / y.n) * x.n - x.p;
    const why = `合格 前 ${y.p}/${y.n} → 今 ${x.p}/${x.n}`;
    (flaky.has(id) && gap < 2 ? flake : sure).push({ id, why });
  }
  return { sure, flake };
}

// ─── ③ 問題ごとの揺れで回数を決める ─────────────────────────────────────────
//   試験の揺れの記録（scripts/lib/exam-flake の観測・30日）から、同じ問題・同じモデルで答えが割れた問題を「揺れる」とみて回数を増やす。
//   揺れる問題は flakyReps（3〜6・既定 4）、それ以外は normal（既定 2）。依頼で名指しした揺れる問題（--flaky）も揺れる扱い。
/** 11/04 竹内さんの決定（使い回せる物は使い回す）: 揺れの記録で回数を決める＝安定（独立に3回以上同じ答え）は1回・分からないは normal・揺れるは flakyReps */
export function repsPlan(ids: string[], obsOf: (id: string) => FlakeObs[], o: { normal: number; flakyReps: number; forced?: string[]; model?: string; stableReps?: number }): { reps: Record<string, number>; flaky: Array<{ id: string; why: string }>; stable?: string[] } {
  const fr = Math.min(6, Math.max(3, o.flakyReps));
  const reps: Record<string, number> = {}, flaky: Array<{ id: string; why: string }> = [], stable: string[] = [];
  for (const id of ids) {
    if (o.forced?.includes(id)) { reps[id] = fr; flaky.push({ id, why: "依頼で名指し" }); continue; }
    const obs = obsOf(id);
    // 一番新しい観測の問題の版・モデルで見る（問題を直した前の観測は数えない）
    const last = [...obs].filter((x) => !x.legacy && (!o.model || x.model.includes(o.model))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    const v = last ? flakeVerdict(obs, { problemHash: last.problemHash, model: last.model }) : null;
    if (v?.verdict === "flaky") { reps[id] = fr; flaky.push({ id, why: v.why }); }
    else if (v?.verdict === "stable" && o.stableReps != null) { reps[id] = Math.max(1, o.stableReps); stable.push(id); }
    else reps[id] = o.normal;
  }
  return { reps, flaky, stable };
}

// ─── ④ 問題の選び（正解の組・場面の地図） ─────────────────────────────────────
//   --pick=types:型A,型B[@N] … spec の型（場面）ごとに N 問（既定 3・問題の番号の幅に散らして選ぶ）
//   --pick=gold           … 正解の組（scripts/parts-eval/gold-20.json の問題）
//   --pick=map            … 場面の地図（exam-queue/scene-map.json の {スイッチ: {types?, only?, perType?, repeat?}}）から
//   --pick=rag            … brain-exam の --select=rag に任せる（直した差分から関係する問題）
//   どれも --only と足し合わせる（重なりは1つ）
export type SpecLite = { id: string; type: string };
export type SceneMap = Record<string, { types?: string[]; only?: string[]; perType?: number; repeat?: number }>;
export function spreadPick<T>(xs: T[], n: number): T[] { if (xs.length <= n) return xs; const out: T[] = []; for (let i = 0; i < n; i++) out.push(xs[Math.floor((i * xs.length) / n)]); return out; }
export function pickProblems(pick: string, spec: SpecLite[], o: { golds?: string[]; map?: SceneMap; switchName?: string; only?: string[] }): { ids: string[]; selectRag: boolean; repeat?: number; why: string } {
  const only = o.only ?? [];
  const uniq = (xs: string[]) => [...new Set(xs)];
  const byTypes = (types: string[], per: number) => types.flatMap((t) => spreadPick(spec.filter((p) => p.type === t).map((p) => p.id), per));
  if (!pick) return { ids: only, selectRag: false, why: "--only のまま" };
  if (pick === "rag") return { ids: only, selectRag: true, why: "brain-exam --select=rag" };
  if (pick === "gold") return { ids: uniq([...only, ...(o.golds ?? [])]), selectRag: false, why: `正解の組 ${o.golds?.length ?? 0}問` };
  if (pick.startsWith("types:")) {
    const [ts, per] = pick.slice(6).split("@");
    const types = ts.split(",").filter(Boolean);
    const unknown = types.filter((t) => !spec.some((p) => p.type === t));
    if (unknown.length) throw new Error(`spec に無い型: ${unknown.join(",")}（有る型: ${uniq(spec.map((p) => p.type)).join(",")}）`);
    return { ids: uniq([...only, ...byTypes(types, Number(per || 3))]), selectRag: false, why: `型 ${types.join(",")} を ${Number(per || 3)}問ずつ` };
  }
  if (pick === "map") {
    // スイッチが複数（,）の依頼は、地図にある名の項目を足し合わせる（型・名指しは和・数と回数は大きい方）
    const names = String(o.switchName ?? "").split(/[,\s]+/).filter(Boolean);
    const es = names.map((n) => o.map?.[n]).filter((x): x is NonNullable<typeof x> => !!x);
    const e = o.switchName && o.map?.[o.switchName] ? o.map[o.switchName] : es.length ? { types: uniq(es.flatMap((x) => x.types ?? [])), only: uniq(es.flatMap((x) => x.only ?? [])), perType: Math.max(1, ...es.filter((x) => x.types?.length).map((x) => x.perType ?? 3)), repeat: es.some((x) => x.repeat) ? Math.max(...es.map((x) => x.repeat ?? 0)) : undefined } : undefined;
    if (!e) throw new Error(`場面の地図にスイッチ ${o.switchName} が無い（exam-queue/scene-map.json に {"${o.switchName}": {"types": [...], "only": [...]}} を足す）`);
    return { ids: uniq([...only, ...(e.only ?? []), ...byTypes(e.types ?? [], e.perType ?? 3)]), selectRag: false, repeat: e.repeat, why: `場面の地図（${(e.types ?? []).join(",") || "-"}・${(e.only ?? []).length}問）` };
  }
  throw new Error(`--pick=${pick} は無い（types:型@N ／ gold ／ map ／ rag）`);
}

// ─── ② 入れる順番の表（release-order.md）への書き戻し ───────────────────────────
//   スイッチの列にそのスイッチ名がある行の「状態」（最後の列）を結果に置き換える。行が無ければ表はそのまま（changed=false）
export function updateReleaseOrder(md: string, switchName: string, status: string): { md: string; changed: boolean } {
  if (!switchName) return { md, changed: false };
  const lines = md.split(/\r?\n/);
  const eol = md.includes("\r\n") ? "\r\n" : "\n";
  let changed = false;
  const hdr = lines.findIndex((l) => /^\|.*スイッチ.*\|.*状態.*\|\s*$/.test(l));
  if (hdr < 0) return { md, changed: false };
  const cols = lines[hdr].split("|").map((s) => s.trim());
  const swCol = cols.indexOf("スイッチ"), stCol = cols.indexOf("状態");
  const safe = status.replace(/\|/g, "／").replace(/\r?\n/g, " ");
  for (let i = hdr + 2; i < lines.length && lines[i].startsWith("|"); i++) {
    const cells = lines[i].split("|");
    if (cells.length <= Math.max(swCol, stCol)) continue;
    if (!switchName.split(/[,s]+/).filter(Boolean).some((n) => cells[swCol].includes(n))) continue;
    cells[stCol] = ` ${safe} `;
    lines[i] = cells.join("|");
    changed = true;
  }
  return { md: lines.join(eol), changed };
}

// ─── 2026-11-04 統括役（竹内さん「何で詰まるのか原因を調べて改善する」）: 大きい1本が後ろを全部待たせていた（grp-reply 2時間・grpb-after 2時間超×2） ─────
//   (a) 小さい依頼（問題数×回数）を先に。同じ大きさは先に入った順。4時間以上待った依頼は大きさを見ない（大きい物がずっと後ろにならない）。priority（小さいほど先・既定 5）で上書き
//   (b) 1本の時間の上限（既定 40分・依頼の maxMin で上書き）＝ exam-conductor.ts で止めて途中までの結果を出し、残りを分けた依頼にする（remainingIds）
//   (c) 1本の問題数の上限（12問）を超える依頼は足す時に分ける（splitIds）
export type JobSizeLite = { runner?: string; only?: string; repeat?: number; cmds?: string[]; createdAt: string; priority?: number };
export function jobSize(j: JobSizeLite): number {
  if (j.runner === "cmd") return (j.cmds?.length ?? 1) * 10;
  if (j.runner === "tsc" || j.runner === "tsc-remote") return 0;
  const n = (j.only ?? "").split(",").filter(Boolean).length || 30;
  return n * Math.max(1, j.repeat ?? 1);
}
export const AGE_NO_SIZE_MS = 4 * 3600_000;
export function compareJobs(a: JobSizeLite, b: JobSizeLite, nowMs: number = Date.now()): number {
  const pa = a.priority ?? 5, pb = b.priority ?? 5;
  if (pa !== pb) return pa - pb;
  const sa = nowMs - Date.parse(a.createdAt) >= AGE_NO_SIZE_MS ? 0 : jobSize(a);
  const sb = nowMs - Date.parse(b.createdAt) >= AGE_NO_SIZE_MS ? 0 : jobSize(b);
  if (sa !== sb) return sa - sb;
  return a.createdAt.localeCompare(b.createdAt);
}
export const JOB_MAX_PROBLEMS = 12;
/** 問題の id を12問ずつに分ける（揺れる問題は入っている側に付ける） */
export function splitIds(ids: string[], max: number = JOB_MAX_PROBLEMS): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += max) out.push(ids.slice(i, i + max));
  return out.length ? out : [[]];
}
/** 時間の上限で止めた時に、予定の回数まで流し終わっていない問題 */
export function remainingIds(planned: Record<string, number>, rows: RowLite[]): string[] {
  const done = new Map<string, number>();
  for (const r of rows) if (!r.error) done.set(r.id, (done.get(r.id) ?? 0) + 1);
  return Object.entries(planned).filter(([id, n]) => (done.get(id) ?? 0) < n).map(([id]) => id);
}

/**
 * 2026-11-05 作業員1（統括役の指示・11/04 夜に手で分けた形を係で）: 依頼の大きさから時間を見積もり、上限に収まらない依頼は足す時に分ける。
 *   見積もり: 回数（問題ごとの reps・揺れる問題は多い）× 前と今の2（前が取り置き済みでも多めに見る）÷（1レーン 1時間に約60回 × レーン）＋ 下見 20分×15問ごと。
 *   古い作業ツリー（止める印・レーンの直しが無い）は1レーン。分ける時は重い問題から軽い塊へ入れて重さをそろえる（12問は今まで通りの上限）。
 */
export function estimateJobMin(ids: ReadonlyArray<string>, reps: Readonly<Record<string, number>>, o: { lanes: number; runsPerHourPerLane?: number; overheadPer15Min?: number }): number {
  const runs = ids.reduce((s, id) => s + (reps[id] ?? 2), 0) * 2;
  const rate = (o.runsPerHourPerLane ?? 60) * Math.max(1, o.lanes);
  return Math.round((runs / rate) * 60 + (o.overheadPer15Min ?? 20) * Math.ceil(ids.length / 15));
}
export function splitByTime(ids: ReadonlyArray<string>, reps: Readonly<Record<string, number>>, o: { lanes: number; maxMin: number; targetMin?: number; maxProblems?: number; runsPerHourPerLane?: number }): string[][] {
  const maxP = o.maxProblems ?? JOB_MAX_PROBLEMS;
  const target = Math.max(20, Math.min(o.targetMin ?? 70, Math.floor(o.maxMin * 0.8)));
  const total = estimateJobMin(ids, reps, o);
  let n = Math.max(Math.ceil(total / target), Math.ceil(ids.length / maxP), 1);
  for (; n <= ids.length; n++) {
    const parts: Array<{ ids: string[]; w: number }> = Array.from({ length: n }, () => ({ ids: [], w: 0 }));
    for (const id of [...ids].sort((a, b) => (reps[b] ?? 2) - (reps[a] ?? 2))) {
      const p = parts.filter((x) => x.ids.length < maxP).reduce((m, x) => (x.w < m.w ? x : m));
      p.ids.push(id); p.w += reps[id] ?? 2;
    }
    const ok = parts.every((p) => estimateJobMin(p.ids, reps, o) <= target || p.ids.length <= 1);
    if (ok || n === ids.length) return parts.filter((p) => p.ids.length).map((p) => ids.filter((x) => p.ids.includes(x)));
  }
  return [ [...ids] ];
}

/**
 * 2026-11-05 作業員1（弱い所 id 293・統括役の指示）: 止めた回の片付け先を、この回の出力から全部拾う。
 *   1本の回は「テストの会話: YUMA3（…）」、レーンの回は「レーン（…）: 4本 YUMA2（…・線 scripts/.replay-out/brain-exam-floor-<label>-yuma2.json）・…」。
 *   main の子（前を作る・label が main- で始まる）の行も同じ出力に出る＝その label・会話も拾う（子の置き場は brain-exam-main）。
 *   旧は「テストの会話:」の最後の1本だけを見て、レーンの回は「読めない」で片付けなかった（殺された回の行が残り、次の回が「他の問題の発言」で回し直す）。
 */
export function cleanupTargets(outText: string, label: string): Array<{ conv: string; label: string; child: boolean }> {
  const out = new Map<string, { conv: string; label: string; child: boolean }>();
  for (const m of outText.matchAll(/(YUMA\d+)（[0-9a-f]{6,}・線 scripts\/\.replay-out\/brain-exam-floor-(.+?)-yuma\d+\.json）/g)) {
    const lb = m[2];
    out.set(`${lb}|${m[1]}`, { conv: m[1], label: lb, child: lb !== label && /^main-/.test(lb) });
  }
  for (const m of outText.matchAll(/テストの会話: (YUMA\d+)（[^\n]*?線 scripts\/\.replay-out\/brain-exam-floor-(.+?)(?:-yuma\d+)?\.json/g)) {
    out.set(`${m[2]}|${m[1]}`, { conv: m[1], label: m[2], child: m[2] !== label && /^main-/.test(m[2]) });
  }
  if (!out.size) { const c = [...outText.matchAll(/テストの会話: (YUMA\d+)（/g)].pop()?.[1]; if (c) out.set(`${label}|${c}`, { conv: c, label, child: false }); }
  return [...out.values()];
}
