// scripts/lib/exam-lane.ts — 試験（brain-exam）を1つの処理の中で数本の「レーン」に分けて並べて回す土台
//
// 2026-11-04 作業員1・指揮役の了承: brain-exam は問題を1問ずつ回していた（1巡が数時間）。node を増やさずに、同じ処理の中で
//   レーン＝テスト専用の会話1本（YUMA2〜YUMA5）ごとに1問ずつ並べる（EXAM_CONCURRENCY・既定 1＝今まで通り・レーンを作らない）。
//   難しい所: 試験は問題ごとに処理全体の物（process.env・録音の札・試験の時計）を書き換え、brain-core は呼んだ時に読む。
//   → AsyncLocalStorage で「今どのレーンの中か」を持ち、①process.env を Proxy にしてレーンの中の書き換えはレーンだけに効かせる
//     ②録音の札（llm-cassette）③時計のずらし（exam-clock）もレーンの中ならレーンの値を読む。レーンの外（EXAM_CONCURRENCY=1）は今と同じ。
//   このファイルは node:async_hooks 以外を import しない（llm-cassette・exam-clock から読むので輪にしない）。
import { AsyncLocalStorage } from "node:async_hooks";

export type ExamLane<L = unknown> = {
  /** 0 から */ index: number;
  /** 会話の名前（YUMA2 等・ログ用） */ name: string;
  /** process.env の上書き（自分の物として undefined を持つ鍵＝このレーンでは消した） */ env: Record<string, string | undefined>;
  /** 録音の札（llm-cassette.setCassetteTag がレーンの中で書く） */ cassetteTag: Record<string, string>;
  /** 試験の時計のずらし（exam-clock.setExamClockOffset がレーンの中で書く） */ clockOffsetMs: number;
  /** 呼ぶ側（brain-exam）のレーンごとの物（会話・控え・写し等） */ local: L;
};

// 束が分かれても1つに（deepseek-scope と同じく globalThis に置く）
const ALS_KEY = Symbol.for("sumora.examLaneStore");
function als(): AsyncLocalStorage<ExamLane> {
  const g = globalThis as unknown as Record<symbol, AsyncLocalStorage<ExamLane> | undefined>;
  return (g[ALS_KEY] ??= new AsyncLocalStorage<ExamLane>());
}

/** 今のレーン（レーンの外なら undefined） */
export function currentLane<L = unknown>(): ExamLane<L> | undefined {
  const g = globalThis as unknown as Record<symbol, AsyncLocalStorage<ExamLane> | undefined>;
  return g[ALS_KEY]?.getStore() as ExamLane<L> | undefined;
}

export function makeLane<L>(index: number, name: string, local: L, env: Record<string, string | undefined> = {}): ExamLane<L> {
  return { index, name, env: { ...env }, cassetteTag: {}, clockOffsetMs: 0, local };
}

/** fn をそのレーンの中で回す（中の await・setTimeout の先もレーンが付いて回る） */
export function runInLane<T, L>(lane: ExamLane<L>, fn: () => T): T {
  return als().run(lane as ExamLane, fn);
}

/** 並べる数（EXAM_CONCURRENCY・1〜6・無い時は 4・読めない値は 1）。2026-11-04 指揮役: 既定 4（conc-4lane 悪化0・429 0・会話の取り違え0）・=1 で今まで通り。会話の数で実際はもっと少ない（テスト専用の会話は4本） */
export const EXAM_CONCURRENCY_MAX = 6;
export function readConcurrency(env: Record<string, string | undefined> = process.env): number {
  const n = Math.floor(Number(String(env.EXAM_CONCURRENCY ?? "").trim() || "4"));
  return Number.isFinite(n) && n > 1 ? Math.min(EXAM_CONCURRENCY_MAX, n) : 1;
}

// ─── process.env の Proxy ───────────────────────────────────────────────
const PROXY_MARK = Symbol.for("sumora.examLaneEnvProxy");
let realEnv: NodeJS.ProcessEnv | null = null;
const has = (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k);

/** 入れたか */
export function laneEnvProxyInstalled(): boolean {
  return !!(process.env as unknown as Record<symbol, unknown>)[PROXY_MARK];
}
/** 本物の process.env（入れる前の物・入れていなければ今の process.env） */
export function realProcessEnv(): NodeJS.ProcessEnv { return realEnv ?? process.env; }

/**
 * process.env を Proxy に替える（1回だけ）。EXAM_CONCURRENCY>1 の時だけ呼ぶ（1 の時は入れない＝今と同じ）。
 *   読む: レーンの上書き（undefined の上書き＝消した）→ 本物の env。
 *   書く・消す: レーンの中ならレーンの上書きへ・外なら本物の env へ。
 *   的（target）は空の物にして、Proxy の決まり（設定できない鍵の食い違い）に当たらないようにする。
 */
export function installLaneEnvProxy(): boolean {
  if (laneEnvProxyInstalled()) return false;
  const real = process.env;
  realEnv = real;
  const laneEnv = () => currentLane()?.env;
  const handler: ProxyHandler<Record<string, string | undefined>> = {
    get(_t, k) {
      if (k === PROXY_MARK) return true;
      if (typeof k === "symbol") return (real as unknown as Record<symbol, unknown>)[k];
      const le = laneEnv();
      if (le && has(le, k)) return le[k];
      return real[k];
    },
    has(_t, k) {
      if (k === PROXY_MARK) return false;
      if (typeof k === "symbol") return k in real;
      const le = laneEnv();
      if (le && has(le, k)) return le[k] !== undefined;
      return k in real;
    },
    set(_t, k, v) {
      if (typeof k === "symbol") { (real as unknown as Record<symbol, unknown>)[k] = v; return true; }
      const le = laneEnv();
      // 本物の process.env と同じく文字列にする
      if (le) le[k] = String(v);
      else real[k] = v as string;
      return true;
    },
    deleteProperty(_t, k) {
      if (typeof k === "symbol") return delete (real as unknown as Record<symbol, unknown>)[k];
      const le = laneEnv();
      if (le) le[k] = undefined;
      else delete real[k];
      return true;
    },
    ownKeys() {
      const le = laneEnv();
      const keys = new Set(Object.keys(real));
      if (le) for (const k of Object.keys(le)) { if (le[k] === undefined) keys.delete(k); else keys.add(k); }
      return [...keys];
    },
    getOwnPropertyDescriptor(_t, k) {
      if (typeof k === "symbol") return undefined;
      const le = laneEnv();
      let v: string | undefined;
      if (le && has(le, k)) v = le[k];
      else if (has(real, k)) v = real[k];
      else return undefined;
      if (v === undefined) return undefined;
      return { value: v, writable: true, enumerable: true, configurable: true };
    },
    defineProperty(_t, k, d) {
      if (typeof k === "symbol") return false;
      const le = laneEnv();
      const v = d.value === undefined ? undefined : String(d.value);
      if (le) le[k] = v;
      else if (v === undefined) delete real[k]; else real[k] = v;
      return true;
    },
  };
  process.env = new Proxy({} as Record<string, string | undefined>, handler) as NodeJS.ProcessEnv;
  return true;
}
/** テスト用: 本物の env に戻す */
export function uninstallLaneEnvProxy(): void {
  if (realEnv && laneEnvProxyInstalled()) process.env = realEnv;
  realEnv = null;
}

// ─── DeepSeek の 429 で並べる数を減らす ───────────────────────────────────────
/**
 * 429（Too Many Requests）を見たら、次の問題から並べる数を1つ減らす（最小 1）。
 *   同じ時に数本のレーンが 429 を見ても、問題の区切りで1つずつしか減らさない（一度に全部止めない）。
 *   見え方: ①fetch の包みで DeepSeek の答えの status 429（brain-exam が note429 を呼ぶ）②結果の行の失敗の文に 429・rate limit
 */
export const RATE_LIMIT_RE = /\b429\b|rate.?limit|too many requests/i;
export class LaneLimiter {
  limit: number;
  private pending = 0;
  readonly events: Array<{ at: string; from: number; to: number; why: string }> = [];
  private lastWhy = "";
  constructor(readonly max: number) { this.limit = Math.max(1, max); }
  note429(why = "429"): void { this.pending++; this.lastWhy = why; }
  /** 結果の行の失敗の文に 429 らしい物があれば数える */
  noteError(err: string | null | undefined): void { if (err && RATE_LIMIT_RE.test(err)) this.note429(err.slice(0, 80)); }
  /** 問題の区切りで呼ぶ: 溜まった 429 があれば1つ減らす（減らしたら true） */
  atBoundary(now: () => string = () => new Date().toISOString()): boolean {
    if (!this.pending) return false;
    this.pending = 0;
    if (this.limit <= 1) return false;
    const from = this.limit;
    this.limit--;
    this.events.push({ at: now(), from, to: this.limit, why: this.lastWhy });
    return true;
  }
  /** このレーンは次の問題を取ってよいか（番号が今の数より小さいレーンだけ） */
  mayTake(laneIndex: number): boolean { return laneIndex < this.limit; }
}

/**
 * レーンで回す（純粋に近い: 仕事は差し替えられる＝テスト用）。
 *   問題の列を前から順に、空いたレーンが1問ずつ取る（同じ問題の回は1つのレーンの中で順に＝worker が1問の全部の回を回す）。
 *   worker が "stop" を返したら、そのレーンは次を取らない（他のレーンも次を取らない＝止める印と同じ）。
 *   limiter があれば、問題の区切りで並べる数を減らし、番号が数以上のレーンは次を取らない。
 * @returns レーンごとに回した問題（順）
 */
export async function runLanes<T, L>(items: readonly T[], lanes: ReadonlyArray<ExamLane<L>>, worker: (item: T, lane: ExamLane<L>) => Promise<"stop" | void>, o: { limiter?: LaneLimiter; onShrink?: (from: number, to: number) => void } = {}): Promise<T[][]> {
  let next = 0, stopped = false;
  const took: T[][] = lanes.map(() => []);
  // 1本が投げたら他のレーンは次を取らない（回している問題は終わらせる＝片付けを途中で切らない）。全部終わってから最初の失敗を投げる
  const rs = await Promise.allSettled(lanes.map((lane) => runInLane(lane, async () => {
    for (;;) {
      if (stopped || next >= items.length) return;
      if (o.limiter && !o.limiter.mayTake(lane.index)) return;
      const item = items[next++];
      took[lane.index].push(item);
      let r: "stop" | void;
      try { r = await worker(item, lane); } catch (e) { stopped = true; throw e; }
      if (r === "stop") { stopped = true; return; }
      if (o.limiter) { const from = o.limiter.limit; if (o.limiter.atBoundary()) o.onShrink?.(from, o.limiter.limit); }
    }
  })));
  const bad = rs.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (bad) throw bad.reason;
  return took;
}

// ─── 2026-11-06 作業員1（統括役の (c) 案1・竹内さん「試験の速さ・作業速度をはやく」）: 1問の回を空いたレーンに分ける ───
//   今は「同じ問題の回は同じレーンで順に」。依頼の多くは 1〜4問で、4本のレーンの多くが空いていた（例 1問×4回は1本だけが動く）。
//   回の数が先に決まっている問題（--reps-file・揺れる問題・揺れの決め方を使わない時）だけ、回を塊に分けて空いたレーンに配る。
//   回の数が前の回の答えで決まる問題（安定＝いつもと違えば足す・分からない＝割れたら足す）は今まで通り1つのレーンで順に。
//   各回は自分のレーンのテスト用の会話・条件の行・台帳の写しで回る（回の答えはそれぞれ別に作る＝比べ方は変わらない）。
//   営業時間はレーンが1本（係の EXAM_BIZ_ONE_LANE）なので分けない＝夜だけ効く。既定 off（入れる EXAM_SPLIT_REPS=on）
export function splitRepsOn(env: Record<string, string | undefined> = process.env): boolean {
  return (env.EXAM_SPLIT_REPS ?? "").trim().toLowerCase() === "on";
}
/** レーンに配る1つの仕事: 問題と回す回（null＝全部の回を順に・今まで通り） */
export type LaneUnit<P> = { p: P; reps: number[] | null };
/**
 * 問題の列を仕事の列にする。fixedReps(p)＝先に決まっている回の番号（null＝前の回で決まる＝分けない）。
 *   問題の数がレーンの数以上なら分けない（今まで通り）。足りない時は、回の多い問題から塊に割って、仕事の数がレーンの数に近くなるようにする。
 *   塊は続いた回（1,2 と 3,4）＝同じレーンの中では写しの使い回しが効く。
 */
export function planLaneUnits<P>(problems: readonly P[], laneCount: number, fixedReps: (p: P) => number[] | null): LaneUnit<P>[] {
  const whole: LaneUnit<P>[] = problems.map((p) => ({ p, reps: null }));
  if (laneCount <= 1 || problems.length >= laneCount) return whole;
  const fixed = problems.map((p) => fixedReps(p));
  let units = problems.length;
  const parts = problems.map(() => 1);
  // 空いたレーンの分だけ、1塊あたりの回が一番多い問題を1つずつ割る
  for (;;) {
    if (units >= laneCount) break;
    let best = -1, bestPer = 1;
    fixed.forEach((r, i) => { if (!r || r.length <= parts[i]) return; const per = r.length / parts[i]; if (per > bestPer) { bestPer = per; best = i; } });
    if (best < 0) break;
    parts[best]++; units++;
  }
  const out: LaneUnit<P>[] = [];
  problems.forEach((p, i) => {
    const r = fixed[i];
    if (!r || parts[i] <= 1) { out.push({ p, reps: null }); return; }
    // k 個のほぼ同じ大きさの塊（前の塊が1つ多い）
    const k = parts[i], base = Math.floor(r.length / k), extra = r.length % k;
    for (let j = 0, at = 0; j < k; j++) { const n = base + (j < extra ? 1 : 0); out.push({ p, reps: r.slice(at, at + n) }); at += n; }
  });
  // 大きい仕事から先に配る（終わりを揃える）
  return out.map((u, i) => ({ u, i, n: u.reps ? u.reps.length : (fixed[problems.indexOf(u.p)]?.length ?? 1) }))
    .sort((a, b) => b.n - a.n || a.i - b.i).map((x) => x.u);
}
