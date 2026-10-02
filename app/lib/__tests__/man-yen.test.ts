// app/lib/__tests__/man-yen.test.ts — 2026-10-02 家賃の万の表示を切り捨てない（⑯ が見つけた G6・松浦さん 上限 8.5万）
//   実行: npx tsx --env-file=.env.local app/lib/__tests__/man-yen.test.ts（line-webhook-text が supabase を読むため）
import { manYen } from "../man-yen";
import { manYen as manYenWebhook } from "../line-webhook-text";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };
for (const [yen, want] of [[85000, "8.5"], [80000, "8"], [123400, "12.34"], [75500, "7.55"], [100000, "10"]] as const) {
  t(`${yen} → ${want}万`, manYen(yen) === want, manYen(yen));
  t(`${yen}: line-webhook-text の manYen と同じ`, manYen(yen) === manYenWebhook(yen));
}
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
