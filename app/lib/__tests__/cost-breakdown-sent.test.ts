// AIX【初期費用について】で送った見積書を材料にする（2026-10-27 owner-fb:1016-cost-explain-aix）のテスト
// 実行: npx tsx app/lib/__tests__/cost-breakdown-sent.test.ts
import { pickSentEstimateUrls, costBreakdownSentEstimateOn } from "../cost-breakdown-sent";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, d?: unknown) => { if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${JSON.stringify(d)}`); } };
const rows = [
  { image_url: "u-old", read_at: "2026-10-20T01:00:00Z" },
  { image_url: "u-b", read_at: "2026-10-25T03:02:00Z" },
  { image_url: "u-a", read_at: "2026-10-25T03:00:00Z" },
  { image_url: "u-a", read_at: "2026-10-25T03:00:30Z" },
  { image_url: null, read_at: "2026-10-25T03:05:00Z" },
];
const got = pickSentEstimateUrls(rows);
t("直近の1回の送信だけ・新しい順・重複なし", JSON.stringify(got) === JSON.stringify(["u-b", "u-a"]), got);
t("無ければ空", pickSentEstimateUrls([]).length === 0);
t("最大3件", pickSentEstimateUrls([1, 2, 3, 4].map((i) => ({ image_url: `u${i}`, read_at: `2026-10-25T03:0${i}:00Z` }))).length === 3);
t("既定 off", !costBreakdownSentEstimateOn({}) && costBreakdownSentEstimateOn({ COST_BREAKDOWN_SENT_ESTIMATE: "on" }));
console.log(`\n${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);
