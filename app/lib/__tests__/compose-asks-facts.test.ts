// npx tsx app/lib/__tests__/compose-asks-facts.test.ts
import assert from "node:assert/strict";
import { asksFactsOf, recordFactsOf, composeFactsNote, composeAsksFactsOn } from "../compose-asks-facts";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const meta = { turn_contract: { asks: [
  { quote: "審査はどのくらい？", route: "reply", answer: "申込から審査3〜10日", basis: "company_fact" },
  { quote: "空いてますか", route: "promise", answer: "募集状況を確認する", basis: "judgement" },
  { quote: "内覧したい", route: "aix", answer: null, basis: "judgement", aix: "viewing_invite" },
] } };

t("依頼ごとの答えを出所つきで写す（aix の依頼は入れない・約束は約束の中身）", () => {
  const f = asksFactsOf(meta);
  assert.deepEqual(f.map((x) => [x.id, x.from]), [["f1", "会社の事実"], ["f2", "約束の中身"]]);
});
t("記録の値（見積の金額・内覧の日時）は値のまま", () => {
  const r = recordFactsOf({ estimates: [{ property_name: "〇〇ハイツ", room_no: "302", initial_cost_yen: 156980, discount_yen: 30000, created_at: "2026-11-10T03:00:00Z" }], viewing: { dateMD: "11/14", time: "14:00", place: "本町駅" } });
  assert.equal(r[0].text, "〇〇ハイツ 302号室の御見積書: 初期費用 156,980円・割引 30,000円（11/10 送付）");
  assert.equal(r[1].text, "決まっている内覧: 11/14 14:00 本町駅");
  assert.equal(recordFactsOf({ estimates: [{ property_name: "x", initial_cost_yen: null }], viewing: null }).length, 0);
});
t("既定 off は何も足さない", () => {
  assert.equal(composeAsksFactsOn({}), false);
  assert.equal(composeFactsNote(asksFactsOf(meta), {}), "");
  assert.match(composeFactsNote(asksFactsOf(meta), { COMPOSE_ASKS_FACTS: "on" }), /「審査はどのくらい？」→ 申込から審査3〜10日（会社の事実）/);
});
console.log(`compose-asks-facts: ${n} pass`);
