// app/lib/material-prefetch.ts — ブレインの材料の読みを先に始めて並べて待つ（BRAIN_MATERIAL_PARALLEL・既定 off）
// 入り切りは段階で読む（rollout.stageOnNow("BRAIN_MATERIAL_PARALLEL")・既定 off・竹内さんの決め 11/27「部品は段階で読む」）
// 2026-11-27 作業員L（統括役の頼み「材料の区間の約15の読みを1つずつ待っている所を並べる」・下書き1回 約75秒のうち材料 19〜24秒）:
//   ・読みの中身は変えない: 置き場（take）で使う関数と、先に始める関数は同じ物（register に1回だけ書く）。off の時は今まで通り置き場で初めて呼ぶ
//   ・答えの使い方も変えない: 置き場で await して、今までと同じ順に材料へ足す＝ブレインに渡す文字の並びは同じ（並べるのは待ちだけ）
//   ・失敗も同じ: 先に始めた読みが失敗したら、置き場で同じ例外を投げる（置き場の try/catch がそのまま効く）
//   ・同時に走らせる数に上限（既定 4・BRAIN_MATERIAL_PARALLEL_MAX）＝昼の DB の重さを増やさない
//   ・先に始めるのは、入力が会話の id・今の通の並び・状態だけで決まる読み（前の部品の答えに依らない物）だけ（依る物は今まで通り置き場で）
type Env = Record<string, string | undefined>;
export const materialParallelMax = (env: Env = typeof process !== "undefined" ? process.env : {}) => {
  const n = Number(String(env.BRAIN_MATERIAL_PARALLEL_MAX ?? "").trim());
  return Number.isFinite(n) && n >= 1 ? Math.min(8, Math.floor(n)) : 4;
};

/** 同時に走らせる数の上限（純粋な道具） */
export function makeLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let running = 0; const q: Array<() => void> = [];
  const next = () => { if (running >= max) return; const go = q.shift(); if (go) { running++; go(); } };
  return <T>(fn: () => Promise<T>) => new Promise<T>((resolve, reject) => {
    q.push(() => { Promise.resolve().then(fn).then(resolve, reject).finally(() => { running--; next(); }); });
    next();
  });
}

type Settled = { ok: true; v: unknown } | { ok: false; e: unknown };
export type MaterialPrefetch = {
  /** 読みを登録する（on の時だけ、ここで上限の中で先に始める）。guard が false の読みは始めない（置き場で今まで通り） */
  register<T>(key: string, fn: () => Promise<T>, guard?: boolean): void;
  /** 置き場で答えを受け取る。先に始めていればその答え（失敗は同じ例外）・始めていなければ今まで通りここで呼ぶ */
  take<T>(key: string): Promise<T>;
  /** 先に始めた読みの名前（印・ログ用） */
  started(): string[];
};
export function createMaterialPrefetch(on: boolean, max = 4, adopted: ReadonlyMap<string, Promise<Settled>> | null = null): MaterialPrefetch {
  const fns = new Map<string, () => Promise<unknown>>();
  const runs = new Map<string, Promise<Settled>>();
  const limit = makeLimiter(max);
  const startedKeys: string[] = [];
  return {
    register(key, fn, guard = true) {
      fns.set(key, fn);
      if (!on || !guard || runs.has(key)) return;
      startedKeys.push(key);
      // 8秒の待ちの間に先に始めた読み（同じ関数・同じ最新の通の時だけ渡される）があればそれを使う
      const early = adopted?.get(key);
      runs.set(key, early ?? limit(fn).then((v): Settled => ({ ok: true, v }), (e): Settled => ({ ok: false, e })));
    },
    async take<T>(key: string): Promise<T> {
      const r = runs.get(key);
      if (r) { runs.delete(key); const s = await r; if (s.ok) return s.v as T; throw s.e; }
      const fn = fns.get(key);
      if (!fn) throw new Error(`material-prefetch: 登録されていない読み ${key}`);
      return (await fn()) as T;
    },
    started() { return [...startedKeys]; },
  };
}

// ─── 2026-11-27 作業員L（統括役の案 2）: 8秒の待ち（続けての送信を待つ・長さも後の判断も変えない）の間に、新しい発言に依らない読みを先に始める ─────
//   入口（generate-draft-bg-async）が待ちの前に earlyStart（その時の一番新しい通の時刻を控える）・ブレインが材料の初めに adoptEarly で受け取る。
//   待ちの間に新しい通が来た（一番新しい通の時刻が違う）・古い（60秒より前）時は、先に始めた答えを捨てて、ブレインが今まで通り読み直す。
//   受け取りは1回だけ（受け取ったら消す）・同じ関数で作った読みだけ（material-prefetch-server.materialEarlyJobs）・同じ箱（関数の実体）の中だけ
export const EARLY_MAX_AGE_MS = 60_000;
type EarlyEntry = { at: number; latestAt: string | null; runs: Map<string, Promise<Settled>> };
const earlyStore = new Map<string, EarlyEntry>();
export function earlyStart(conversationId: string, latestAt: string | null, jobs: Record<string, () => Promise<unknown>>, max = 4, nowMs = Date.now()): string[] {
  const limit = makeLimiter(max);
  const runs = new Map<string, Promise<Settled>>();
  for (const [k, fn] of Object.entries(jobs)) runs.set(k, limit(fn).then((v): Settled => ({ ok: true, v }), (e): Settled => ({ ok: false, e })));
  earlyStore.set(conversationId, { at: nowMs, latestAt, runs });
  return [...runs.keys()];
}
/** 受け取る（純粋に近い: 控えの中だけ）。一番新しい通の時刻が同じで新しい時だけ。受け取ったら消す */
export function adoptEarly(conversationId: string | null | undefined, latestAt: string | null, nowMs = Date.now()): Map<string, Promise<Settled>> | null {
  if (!conversationId) return null;
  const e = earlyStore.get(conversationId);
  if (!e) return null;
  earlyStore.delete(conversationId);
  if (nowMs - e.at > EARLY_MAX_AGE_MS) return null;
  if ((e.latestAt ?? "") !== (latestAt ?? "") || !latestAt) return null; // 待ちの間に新しい通が来た＝捨てて読み直す
  return e.runs;
}
