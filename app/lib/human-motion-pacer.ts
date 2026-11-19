// app/lib/human-motion-pacer.ts — 拡張の動きの学習（/api/human-motion）の書き込みを、重なった時だけ間を空けて少しずつ書く（DB を止めない守り）
//
// 2026-11-18 作業員H（統括役の頼み・本番 12:16〜12:22 の DB の時間切れ 10件）:
//   その時刻に human_motion_learn への POST が 5分で 241件（03:00 は 390件・普段 0）まとまって来て、statement timeout と重なった（11/13 の DB の止まりと同じ型）。
//   1回の要求は1行の insert だが、たくさんの拡張（タブ）が同じ時刻に送ると、1行ずつの insert が一度に並ぶ。
//   拡張（background.js）は 429 を受けても送り直さない（失敗は console に出すだけ）＝429 で返すとデータが落ちる。
//   → 落とさない形: 短い時間に要求が重なった時（この関数の中で 10秒に 8回より多い）は、受け取りだけ返して、行を手元に溜め、
//     間を空けて（1.5秒ごと）25行ずつまとめて1回で書く（一括 insert）。重なっていない時は今まで通りその場で1行書く。
//   写真を表に入れる行（shot_b64 が大きい）は溜めない（今まで通りその場で書く）。
//   止める: HUMAN_MOTION_PACE=off（既定 on）。テスト: app/lib/__tests__/human-motion-pacer.test.ts
type Env = Record<string, string | undefined>;
export function humanMotionPaceOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.HUMAN_MOTION_PACE ?? "").trim().toLowerCase() !== "off";
}
export const PACE_WINDOW_MS = 10_000;
export const PACE_BURST = 8;
export const PACE_BATCH = 25;
export const PACE_GAP_MS = 1_500;

/** 窓の中の要求の時刻（関数の中だけ・インスタンスごと） */
export class BurstMeter {
  private times: number[] = [];
  constructor(private windowMs = PACE_WINDOW_MS, private burst = PACE_BURST) {}
  /** 1回を数えて、重なっているか（窓の中が burst を越えたか）を返す */
  hit(now: number): boolean {
    this.times.push(now);
    while (this.times.length && now - this.times[0] > this.windowMs) this.times.shift();
    return this.times.length > this.burst;
  }
}

/** 溜めた行を間を空けて少しずつ書く（書く関数は外から渡す＝テストできる形） */
export class PacedWriter<R> {
  private queue: R[] = [];
  private running: Promise<void> | null = null;
  constructor(private deps: {
    insertMany: (rows: R[]) => Promise<{ error: { message?: string; code?: string } | null }>;
    insertOne: (row: R) => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
    batch?: number; gapMs?: number;
    log?: (s: string) => void;
  }) {}
  get pending(): number { return this.queue.length; }
  /** 行を溜める。書く流れが止まっていれば始めて、その Promise を返す（waitUntil に渡す） */
  push(row: R): Promise<void> {
    this.queue.push(row);
    if (!this.running) this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }
  private async drain(): Promise<void> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const batch = this.deps.batch ?? PACE_BATCH, gap = this.deps.gapMs ?? PACE_GAP_MS;
    await sleep(gap); // 最初の束も少し待って集める
    while (this.queue.length) {
      const rows = this.queue.splice(0, batch);
      const r = await this.deps.insertMany(rows).catch((e) => ({ error: { message: e instanceof Error ? e.message : String(e) } }));
      if (r.error) {
        // まとめて書けない時（無い列 等）は1行ずつ今までの形で（落とさない）
        this.deps.log?.(`[human-motion-pacer] まとめて書けない → 1行ずつ: ${String(r.error.message ?? "").slice(0, 120)}`);
        for (const row of rows) await this.deps.insertOne(row).catch(() => {});
      }
      if (this.queue.length) await sleep(gap);
    }
  }
}
