// npx tsx app/lib/__tests__/compose-brief.test.ts
import assert from "node:assert/strict";
import { readTurnUnderstanding, readSevenFields, buildSentencePlan } from "../compose-sentence-plan";
import { buildComposeBrief, draftDoubts, composeSure, linkReport, composeBriefMode, composeBriefDigest, closingOfText, dateWordsOf, BRIEF_INTAKE, BRIEF_NONE } from "../compose-brief";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

const meta = {
  turn_contract: { asks: [{ quote: "審査はどのくらいかかりますか", kind: "question", route: "reply", answer: "審査は通常3日〜10日程", basis: "company_fact" }], lead_with: 0 },
  seven_read: { key_point: "審査の期間を先に答える", lead: "answer_only" },
};
const plan = buildSentencePlan(readTurnUnderstanding(meta), readSevenFields(meta), { scene: "question" });
const brief = buildComposeBrief({ plan, s7: readSevenFields(meta), meta, scene: "question", customerText: "審査はどのくらいかかりますか？", materialText: "", recentStaffTexts: [] });

t("既定 off・shadow/on は記録だけ", () => {
  assert.equal(composeBriefMode({}), "off");
  assert.equal(composeBriefMode({ COMPOSE_BRIEF: "on" }), "shadow");
});

t("指示書: 役目の並び・事実の id と出所・期日の言葉は事実にある物だけ・答えの出所", () => {
  assert.ok(brief.roles.length >= 1);
  assert.deepEqual(brief.facts[0], { id: "f1", value: "審査は通常3日〜10日程", from: "会社の事実" });
  assert.ok(brief.dates.includes("3日") && brief.dates.includes("10日"));
  assert.equal(brief.skeleton.answerSource, "company_fact");
  assert.equal(brief.closing.name, "none");
  assert.equal(brief.values, BRIEF_NONE);
});

t("書いた後の確かめ: 指示書どおりの文は印なし・足した金額と期日と締めの違いは印", () => {
  assert.deepEqual(draftDoubts(brief, "審査は通常3日〜10日程でございます！！"), []);
  const d = draftDoubts(brief, "審査は通常3日〜10日程です！！明日中にご連絡致します。初期費用は120,000円です。\n何卒よろしくお願い致します。").map((x) => x.kind);
  assert.ok(d.includes("fact_added"));
  assert.ok(d.includes("date_word"));
  assert.ok(d.includes("closing_mismatch"));
  assert.equal(closingOfText("お気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！"), "viewing_cta");
  assert.deepEqual(dateWordsOf("11月中旬から下旬"), ["11月中旬"]);
});

t("自信の印と連携の表", () => {
  const s = composeSure(brief, { orderType: "T4_x", appealAsked: true, doubts: [{ kind: "fact_added", why: "" }] });
  assert.equal(s.level, "low");
  assert.ok(s.cues.includes("weak_type") && s.cues.includes("value_not_in_material"));
  assert.equal(composeSure(brief, { orderType: "T10_result_ready", appealAsked: false, doubts: [] }).level, "high");
  const link = linkReport(brief, "- 締め: 誘い無し → 結び無し");
  assert.equal(link.find((l) => l.field === "closing")?.reached, true);
  assert.equal(link.find((l) => l.field === "values")?.has, false);
  assert.ok(BRIEF_INTAKE.length >= 5);
  assert.match(composeBriefDigest(brief, { link }), /^cb2:役目=/);
});

t("材料に根拠があるのに約束: 疑いの印に記録だけ（決め直さない）", () => {
  const m2 = { turn_contract: { asks: [{ quote: "手数料はかかりますか", route: "promise", answer: "手数料を確認する", basis: "company_fact" }], lead_with: 0 } };
  const p2 = buildSentencePlan(readTurnUnderstanding(m2), readSevenFields(m2), { scene: "question" });
  const b2 = buildComposeBrief({ plan: p2, s7: readSevenFields(m2), meta: m2, scene: "question", customerText: "手数料はかかりますか？", materialText: "", recentStaffTexts: [] });
  assert.equal(b2.groundedPromises.length, 1);
  assert.ok(draftDoubts(b2, "手数料について確認させて頂きます！！").some((d) => d.kind === "promise_grounded"));
  assert.equal(brief.groundedPromises.length, 0);
});

console.log(`compose-brief: ${n} pass`);
