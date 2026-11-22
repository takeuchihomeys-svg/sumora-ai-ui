// app/lib/cron-log-wrap.ts — cron の route を包んで cron_run_logs に1行残す（記録だけ・動きは変えない・作業員N・2026-11-21）
//
// 統括役の決め（11/21）: vercel.json にあるのに cron_run_logs に1度も記録が無い cron 33本のうち31本に記録を足す。
//   check-stale（穴の型①「作ったのに回っていない」）が、止まった cron を見つけられるようにするため。
//   包むだけ: 元の処理の戻り値・例外はそのまま。記録の書き込みに失敗しても握りつぶす（cron-logger と同じ）。止める CRON_LOG_WRAP=off。
//   hourly: 高頻度の cron（毎分・2分・5分）は、失敗の時と、毎時0分の回だけ書く（1日 2,500行は DB に重い・統括役 11/21）。
import { startCronLog, finishCronLog } from "./cron-logger";

export const cronLogWrapOn = (env: Record<string, string | undefined> = process.env) => (env.CRON_LOG_WRAP ?? "").trim().toLowerCase() !== "off";

/** hourly の時、成功の回を書くか（純関数・毎時0分の回だけ） */
export function hourlySample(nowMs: number): boolean {
  return new Date(nowMs).getUTCMinutes() === 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withCronLog<A extends any[], R extends Response>(cronName: string, handler: (...args: A) => Promise<R>, o: { hourly?: boolean } = {}): (...args: A) => Promise<R> {
  return async (...args: A) => {
    if (!cronLogWrapOn()) return handler(...args);
    const t0 = Date.now();
    if (o.hourly) {
      // 先に書かない＝終わってから「失敗か、毎時0分の回」だけ1行
      try {
        const res = await handler(...args);
        if (res.status >= 400 || hourlySample(t0)) { const id = await startCronLog(cronName); await finishCronLog(id, res.status < 400, { status: res.status, via: "withCronLog:hourly" }); }
        return res;
      } catch (e) {
        const id = await startCronLog(cronName);
        await finishCronLog(id, false, { via: "withCronLog:hourly" }, e instanceof Error ? e.message : String(e));
        throw e;
      }
    }
    const id = await startCronLog(cronName);
    try {
      const res = await handler(...args);
      await finishCronLog(id, res.status < 400, { status: res.status, via: "withCronLog" });
      return res;
    } catch (e) {
      await finishCronLog(id, false, { via: "withCronLog" }, e instanceof Error ? e.message : String(e));
      throw e;
    }
  };
}
