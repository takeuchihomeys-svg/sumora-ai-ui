// npx tsx app/lib/__tests__/compose-plan-rows-v2.test.ts
//   点検役の実例（line_watch_turns 12362・12562・12838・12196・12164・11865・12680・12348）を、名前と値を伏せた形で行ごとの正解にする
import assert from "node:assert/strict";
import { readTurnUnderstanding, readSevenFields, buildSentencePlan } from "../compose-sentence-plan";
import { asksFactsOf } from "../compose-asks-facts";
import { buildPlanRowsV2, planRowsV2Note, planRowsV2Digest, composePlanRowsV2On, rowsPresence } from "../compose-plan-rows-v2";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
function rows(meta: Record<string, unknown>, o: { scene: string; customerText: string; recentStaff?: Array<{ text: string; aix?: boolean }>; staffOnlyTurn?: boolean }) {
  const u = readTurnUnderstanding(meta), s7 = readSevenFields(meta);
  const plan = buildSentencePlan(u, s7, { scene: o.scene });
  return { plan, ...buildPlanRowsV2({ plan, s7, meta, scene: o.scene, customerText: o.customerText, facts: asksFactsOf(meta), closing: null, recentStaff: o.recentStaff ?? [], staffOnlyTurn: o.staffOnlyTurn }) };
}
const roleSeq = (r: ReturnType<typeof rows>) => r.rows.map((x) => `${x.role}.${x.sub}`);

t("12362 型（抑えられる部屋の問い）: 少なさの信頼の行が立つ・事実の値つき", () => {
  const meta = { turn_contract: { asks: [{ quote: "抑えられるのは送ってもらった間取りですか", kind: "question", route: "reply", answer: "抑えられるのは1LDKの202号室・他は申込が入っており2番手", basis: "material" }], lead_with: 0 } };
  const r = rows(meta, { scene: "apply", customerText: "抑えられるところは送ってもらった間取りですか？", recentStaff: [{ text: "🌟（物件）202", aix: true }] });
  const tr = r.rows.find((x) => x.role === "trust");
  assert.ok(tr, roleSeq(r).join(","));
  assert.equal(tr!.sub, "scarcity");
  assert.ok(tr!.uses.some((u) => u.field === "fact.value" && /2番手/.test(u.value)));
  assert.equal(r.rows.find((x) => x.role === "press")?.source, "material");
});
t("12562 型（検討して来週連絡）: 締めはお客様の言った時期を使う・最後", () => {
  const meta = { turn_contract: { asks: [{ quote: "検討して来週連絡します", kind: "report", route: "reply", answer: "ゆっくり検討してもらう", basis: "conversation" }], lead_with: 0 }, turn_read: { intent: "検討する・保留・相談" } };
  const r = rows(meta, { scene: "considering", customerText: "少し検討して来週ご連絡します", recentStaff: [{ text: "🌟（物件）101", aix: true }] });
  const last = r.rows[r.rows.length - 1];
  assert.equal(last.role, "close");
  assert.equal(last.sub, "their_timing");
  assert.deepEqual(last.uses, [{ field: "latent.expect", value: "来週" }]);
  assert.equal(r.rows[0].role, "head");
});
t("12348 型（スタッフしか知らない番）: 潜在の行を立てない", () => {
  const meta = { turn_contract: { asks: [{ quote: "空いてますか", kind: "question", route: "aix", answer: null, basis: "judgement", aix: "property_check" }], lead_with: 0 }, seven_read: { latent: { what: "埋まってしまう不安" } } };
  const r = rows(meta, { scene: "question", customerText: "このお部屋まだ空いてますか？", staffOnlyTurn: true });
  assert.ok(!r.rows.some((x) => x.role === "latent"));
  assert.ok(r.dropped.some((d) => d.role === "latent" && /staff_only_no_latent/.test(d.why)));
});
t("12196 型（条件の言い直し）: 前の条件を全部繰り返さない印", () => {
  const meta = { turn_contract: { asks: [{ quote: "この物件は外してください", kind: "request", route: "promise", answer: "家賃12万以内でピックアップしてお送りする", basis: "conversation", about: "search_condition" }], lead_with: 0 } };
  const r = rows(meta, { scene: "conditions", customerText: "この物件は外してください。家賃は12万以内で", recentStaff: [{ text: "西区周辺全域から家賃8万〜12万・1LDK・36㎡以上でピックアップしてお送りさせて頂きます", aix: false }] });
  assert.ok(r.rows.some((x) => x.stand.some((s) => s.startsWith("no_full_repeat"))), JSON.stringify(r.rows.map((x) => x.stand)));
});
t("11865 型（継続の約束）: 継続の約束は主の答えの後の最後", () => {
  const meta = { turn_contract: { asks: [{ quote: "他のサイトの物件は本当にあるのか", kind: "question", route: "reply", answer: "ポータルにはおとり物件がある場合がある", basis: "general" }], lead_with: 0 }, seven_read: { lead: "keep" } };
  const r = rows(meta, { scene: "question", customerText: "他のサイトに載ってる物件は本当にあるんですか？" });
  const pi = r.rows.findIndex((x) => x.role === "press"), ci = r.rows.findIndex((x) => x.role === "close");
  assert.ok(pi >= 0 && ci > pi, roleSeq(r).join(","));
  assert.equal(r.rows[pi].certainty, "basically");
});
t("竹内さんの並びの表・digest・既定 off", () => {
  assert.ok((rowsPresence("conditions", "keep")?.roles.get("close")?.share ?? 0) >= 0.9);
  const meta = { turn_contract: { asks: [{ quote: "q", kind: "question", route: "reply", answer: "a", basis: "material" }], lead_with: 0 } };
  const r = rows(meta, { scene: "question", customerText: "q？" });
  assert.match(planRowsV2Digest(r.rows), /^r2:press\.conclusion\|fact\.value\|material\|assertable\|asked_order\|/);
  assert.equal(composePlanRowsV2On({}), false);
  assert.equal(planRowsV2Note(r.rows, {}), "");
  assert.match(planRowsV2Note(r.rows, { COMPOSE_PLAN_ROWS_V2: "on" }), /^- 1文ずつの設計図/);
});
console.log(`compose-plan-rows-v2: ${n} pass`);
