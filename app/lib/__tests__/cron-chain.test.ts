// 朝の数えの cron を1本の後ろから順に呼ぶ（2026-11-15 作業員H・CRON_CHAIN_<宿>・既定 off）
// 実行: npx tsx app/lib/__tests__/cron-chain.test.ts
import { NextRequest } from "next/server";
import { cronChainOn, runCronChain } from "../cron-chain";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
(async () => {
  t("既定 off・宿の名前ごと", !cronChainOn("prod-yardstick", {}) && cronChainOn("prod-yardstick", { CRON_CHAIN_PROD_YARDSTICK: "on" }) && !cronChainOn("line-watch-eval", { CRON_CHAIN_PROD_YARDSTICK: "on" }));
  const host = new NextRequest("https://x.vercel.app/api/cron/prod-yardstick?days=7", { headers: { authorization: "Bearer s" } });
  const seen: string[] = [];
  const r = await runCronChain(host, [
    { name: "compose-prod-daily", run: async (q) => { seen.push(`${q.nextUrl.pathname}|${q.headers.get("authorization")}|${q.nextUrl.search}`); return Response.json({ ok: true, summary: "文の当たり…" }); } },
    { name: "broken", run: async () => { throw new Error("boom"); } },
    { name: "slow", run: () => new Promise<Response>(() => {}) },
    { name: "rag-watch-daily", run: async () => Response.json({ ok: true, skipped: "RAG_WATCH_DAILY_CRON=off" }) },
  ], { budgetMs: 1000 });
  t("子は自分の path・同じ鍵・宿の query は渡さない", seen[0] === "/api/cron/compose-prod-daily|Bearer s|", seen);
  t("1つの子の失敗・時間切れで止めない（4つとも結果）", r.length === 4 && r[0].ok && r[0].summary === "文の当たり…" && !r[1].ok && r[1].error === "boom" && !r[2].ok && /時間切れ/.test(r[2].error ?? "") && r[3].ok && r[3].summary === "skipped: RAG_WATCH_DAILY_CRON=off", r);
  const r2 = await runCronChain(host, [{ name: "a", run: async () => Response.json({ ok: true }) }], { deadlineMs: Date.now() - 1 });
  t("宿の時間の残りが無ければ呼ばない", r2.length === 1 && !r2[0].ok && /残りが無い/.test(r2[0].error ?? ""));
  console.log(`\n${pass} OK / ${fail} NG`);
  if (fail) process.exit(1);
})();
