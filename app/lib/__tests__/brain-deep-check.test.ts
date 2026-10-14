// app/lib/__tests__/brain-deep-check.test.ts — 根拠が足りない時だけ追加で調べる（実行: npx tsx app/lib/__tests__/brain-deep-check.test.ts）
//   例は 30日の洗い出し（scripts/audit-brain-deep-check.ts）の番を伏せて作った
import assert from "node:assert/strict";
import { classifyDeepCheckTopics, decideDeepCheck, newMaterialOnly, deepCheckBlock, pastConversationLines, STAFF_ONLY_RE, queryKeywords, adoptSecondJudgement } from "../brain-deep-check";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const tc = (asks: Array<Record<string, unknown>>) => ({ turn_contract: { asks } });

t("型: 入居可能日・水回り・保証人・駐車場", () => {
  assert.deepEqual(classifyDeepCheckTopics("最短でも入居可能日は11月中旬でしょうか？"), ["move_in"]);
  assert.ok(classifyDeepCheckTopics("ここって洗面台とトイレ一緒な感じですか？").includes("layout"));
  assert.ok(classifyDeepCheckTopics("サンハイツ園部は保証人が必要なのですか？").includes("guarantor"));
  assert.ok(classifyDeepCheckTopics("駐車場は近くのパーキングでよろしいですか？").includes("parking"));
});
t("型: 探す条件・物件の持ち込みは質問にしない", () => {
  assert.deepEqual(classifyDeepCheckTopics("ペット可の部屋ありますか？"), []);
  assert.deepEqual(classifyDeepCheckTopics("独立洗面台でトイレ別のお部屋希望です"), []);
  assert.deepEqual(classifyDeepCheckTopics("サウスパーク 3階\nhttps://suumo.jp/x\nby SUUMO"), []);
});
t("管理会社しか知らない事", () => {
  for (const s of ["ここって空いてますでしょうか？", "内覧できますか？", "審査通りますか？", "礼金交渉できたりしますか？", "初期費用いくらになりますか？"]) assert.ok(STAFF_ONLY_RE.test(s), s);
  assert.ok(!STAFF_ONLY_RE.test("洗面台とトイレ一緒ですか？"));
});
t("ブレインの gap=material → かける", () => {
  const d = decideDeepCheck({ parsed: tc([{ quote: "洗面台とトイレは一緒か", route: "promise", gap: "material" }]), customerText: "ここって洗面台とトイレ一緒な感じですか？", postApply: false, env: {} });
  assert.equal(d.run, true); assert.equal(d.by, "brain"); assert.ok(d.topics.includes("layout"));
});
t("gap=material でも管理会社の事はかけない", () => {
  const d = decideDeepCheck({ parsed: tc([{ quote: "募集状況（空いているか）", route: "promise", gap: "material" }]), customerText: "ここ空いてますか？", postApply: false, env: {} });
  assert.equal(d.run, false);
});
t("網: gap 欄が無い出力で 約束×資料で答えられる型×お客様の文も質問", () => {
  const d = decideDeepCheck({ parsed: tc([{ quote: "入居可能日は11月中旬か", route: "promise" }]), customerText: "最短でも入居可能日は11月中旬でしょうか？", postApply: false, env: {} });
  assert.equal(d.run, true); assert.equal(d.by, "net");
});
t("網: ブレインが gap を判断していれば網は出さない", () => {
  const d = decideDeepCheck({ parsed: tc([{ quote: "入居可能日は11月中旬か", route: "promise", gap: "staff" }]), customerText: "最短でも入居可能日は11月中旬でしょうか？", postApply: false, env: {} });
  assert.equal(d.run, false); assert.equal(d.reason, "brain_judged");
});
t("網: 返信で答えた・お客様の文が質問でない → かけない", () => {
  assert.equal(decideDeepCheck({ parsed: tc([{ quote: "入居可能日", route: "reply" }]), customerText: "入居可能日はいつですか？", postApply: false, env: {} }).run, false);
  assert.equal(decideDeepCheck({ parsed: tc([{ quote: "ペット可否", route: "promise" }]), customerText: "小若江 貸家\nhttps://suumo.jp/x", postApply: false, env: {} }).run, false);
});
t("戻す・申込以降", () => {
  const p = tc([{ quote: "洗面台とトイレは一緒か", route: "promise", gap: "material" }]);
  assert.equal(decideDeepCheck({ parsed: p, customerText: "x", postApply: false, env: { BRAIN_DEEP_CHECK: "off" } }).run, false);
  assert.equal(decideDeepCheck({ parsed: p, customerText: "x", postApply: true, env: {} }).run, false);
  assert.equal(decideDeepCheck({ parsed: tc([{ quote: "入居可能日は11月中旬か", route: "promise" }]), customerText: "入居可能日は11月中旬でしょうか？", postApply: false, env: { BRAIN_DEEP_CHECK_NET: "off" } }).run, false);
});
t("1回目にある材料は足さない", () => {
  assert.deepEqual(newMaterialOnly(["【設備】あり", "", "【契約条件】敷金1ヶ月"], "...【設備】あり..."), ["【契約条件】敷金1ヶ月"]);
  assert.ok(deepCheckBlock({ queries: ["洗面台とトイレ"], notes: ["X"] }).includes("「洗面台とトイレ」"));
});
t("過去の会話の行（型の語・新しい順・時点より前）", () => {
  const lines = pastConversationLines({
    messages: [
      { sender: "staff", text: "当日はお近くのコインパーキングにお停めください", created_at: "2026-10-01T01:00:00Z" },
      { sender: "customer", text: "了解です", created_at: "2026-10-01T02:00:00Z" },
      { sender: "staff", text: "駐車場は後で", created_at: "2026-10-06T01:00:00Z" },
    ],
    topics: ["parking"], beforeMs: Date.parse("2026-10-05T00:00:00Z"),
  });
  assert.equal(lines.length, 1); assert.ok(lines[0].includes("コインパーキング"));
});
t("型に当たらない依頼は言葉の語で探す", () => {
  const kw = queryKeywords(["火災保険って、昨日の話のルームサポートの中に入ってるから他で入る必要ない？"]);
  assert.ok(kw.includes("火災保険") && kw.includes("ルームサポート"), kw.join(","));
  const lines = pastConversationLines({
    messages: [{ sender: "staff", text: "ルームサポートには火災保険も含まれております", created_at: "2026-10-12T01:00:00Z" }, { sender: "customer", text: "こんにちは", created_at: "2026-10-12T02:00:00Z" }],
    topics: [], keywords: kw, beforeMs: Date.parse("2026-10-13T00:00:00Z"),
  });
  assert.equal(lines.length, 1);
});
t("2回目は返信で答えた依頼が増えた時だけ使う・返信の依頼の印ではかけない", () => {
  assert.equal(adoptSecondJudgement(tc([{ quote: "x", route: "aix" }]), tc([{ quote: "x", route: "promise" }])).adopt, false);
  assert.equal(adoptSecondJudgement(tc([{ quote: "x", route: "aix" }]), tc([{ quote: "x", route: "reply" }])).adopt, true);
  assert.equal(decideDeepCheck({ parsed: tc([{ quote: "洗面台とトイレ一緒か", route: "reply", gap: "material" }]), customerText: "洗面台とトイレ一緒ですか？", postApply: false, env: {} }).run, false);
});
console.log(`${n} passed`);
