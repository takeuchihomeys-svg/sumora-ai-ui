// app/lib/__tests__/prop-brain-daily.test.ts — 2026-11-18 作業員K
//   実行: npx tsx app/lib/__tests__/prop-brain-daily.test.ts
import { starStats, conditionReachStats, propBrainDailySummary, PROP_BRAIN_DAILY_AUDIT } from "../prop-brain-daily";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra ?? ""); } };

t("連携の地図の audit 名とそろえる", PROP_BRAIN_DAILY_AUDIT === "audit-prop-brain-score");
const s = starStats([
  { writer: "takeuchi", candidates: [{ name: "A", is_star: true, star: "🌟", pool_rank: 1 }, { name: "B", pool_rank: 5 }] },
  { writer: "takeuchi", candidates: JSON.stringify([{ name: "A", is_star: true, pool_rank: 12 }, { name: "B", star: "🌟", pool_rank: 2 }]) },
  { writer: "employee", candidates: [{ name: "A", is_star: true }, { name: "B" }] },
  { writer: "employee", candidates: [{ name: "A" }] },
]);
t("🌟一致: 売上サポの🌟がある回だけ数える", s.all.toolStarN === 2 && s.all.toolStarHit === 1 && s.takeuchi.toolStarHit === 1);
t("上位: pool_rank がある回だけ・上位3／10", s.all.poolN === 2 && s.all.top3 === 1 && s.all.top10 === 1);
t("🌟の無い回は数えない", s.all.snaps === 3 && s.employee.snaps === 1);

const pcOfConv = new Map([["c1", "p1"], ["c2", "p2"]]);
const pcRow = new Map<string, Record<string, unknown>>([
  ["p1", { created_at: "2026-11-01T00:00:00Z", floor_plan: "1LDK", rent_max: 80000 }],
  ["p2", { created_at: "2026-11-17T10:05:00Z", rent_max: 90000 }],
]);
const r = conditionReachStats({
  msgs: [
    { conversation_id: "c1", text: "家賃9万までで探してほしいです", created_at: "2026-11-17T09:00:00Z" },
    { conversation_id: "c1", text: "1LDKでお願いします", created_at: "2026-11-17T09:10:00Z" },
    { conversation_id: "c2", text: "家賃9万以内で探しています", created_at: "2026-11-17T10:00:00Z" },
    { conversation_id: "c1", text: "https://suumo.jp/chintai/xxx この物件空いてますか", created_at: "2026-11-17T11:00:00Z" },
  ],
  pcOfConv,
  hist: [{ property_customer_id: "p1", changed_field: "rent_max", created_at: "2026-11-17T09:02:00Z" }],
  pcRow,
});
t("履歴で届いた（家賃）", r.reached === 1, r);
t("既に入っていた（間取り）", r.already === 1, r);
t("行を作った時に入った（履歴に残らない）", r.atCreate === 1, r);
t("物件の問い合わせは数えない", r.n === 3 && r.missed === 0, r);
t("一行の要約", /🌟一致 50%/.test(propBrainDailySummary(s, r, 7)) && /条件の届き 100%/.test(propBrainDailySummary(s, r, 7)));

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
