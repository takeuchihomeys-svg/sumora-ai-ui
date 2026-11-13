// app/lib/__tests__/batch-daytime-guard.test.ts — 夜の一括の cron の昼の守り（純関数）
import { daytimeDecision } from "../batch-daytime-guard";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
t("夜はそのまま", daytimeDecision({ hour: 23, force: false, mode: "adaptive", failures: 5 }).scale === 1);
t("昼・調子が良い＝半分・間2倍", (() => { const d = daytimeDecision({ hour: 13, force: false, mode: "adaptive", failures: 0 }); return d.run && d.scale === 0.5 && d.pauseScale === 2; })());
t("昼・調子が悪い＝動かない", !daytimeDecision({ hour: 13, force: false, mode: "adaptive", failures: 2 }).run);
t("昼・読めない＝動かない", !daytimeDecision({ hour: 13, force: false, mode: "adaptive", failures: null }).run);
t("strict は今まで通り", !daytimeDecision({ hour: 13, force: false, mode: "strict", failures: 0 }).run && daytimeDecision({ hour: 13, force: true, mode: "strict", failures: 0 }).run);

// 2026-11-14 作業員F: recentFailures の cron の数えを count exact → 行（id・200行まで）に。答えは前と同じ・count を頼まない
(async () => {
  type Call = { table: string; select: string; opts?: { count?: string; head?: boolean }; limit?: number };
  const fakeDb = (llmRows: Array<Record<string, unknown>>, cronN: number, calls: Call[]) => ({
    from(table: string) {
      const c: Call = { table, select: "" }; calls.push(c);
      const q: Record<string, unknown> = {};
      const chain = () => q;
      Object.assign(q, {
        select(s: string, o?: Call["opts"]) { c.select = s; c.opts = o; return q; },
        gte: chain, eq: chain, or: chain,
        limit(n: number) { c.limit = n; return q; },
        then(res: (v: unknown) => unknown) {
          const rows = table === "cron_run_logs" ? Array.from({ length: Math.min(cronN, c.limit ?? cronN) }, (_, i) => ({ id: `c${i}` })) : llmRows;
          return Promise.resolve({ data: c.opts?.head ? null : rows, count: c.opts?.count ? cronN : null, error: null }).then(res);
        },
      });
      return q;
    },
  });
  const { recentFailures } = await import("../batch-daytime-guard");
  const llm = [{ error_type: null, env: "production", route: "x" }, { error_type: "alt_skipped_pii", env: "production", route: "x" }, { error_type: null, env: "test", route: "x" }, { error_type: null, env: "production", route: "script:a" }];
  for (const cronN of [0, 1, 3, 50]) {
    const calls: Call[] = [];
    const got = await recentFailures(fakeDb(llm, cronN, calls) as never);
    const old = 1 + cronN; // 前の式: LLM の数えた行（除く物を除いて 1）＋ cron の count
    t(`cron ${cronN}件: 前と同じ数（${old}）`, got === old, { got, old });
    const cron = calls.find((x) => x.table === "cron_run_logs");
    t(`cron ${cronN}件: count を頼まない・200行まで`, !!cron && !cron.opts?.count && !cron.opts?.head && cron.limit === 200, cron);
  }
  console.log(`batch-daytime-guard: ${pass} pass / ${fail} fail`);
  if (fail) process.exit(1);
})();
