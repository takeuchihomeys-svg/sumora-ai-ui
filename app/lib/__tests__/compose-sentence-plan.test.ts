// npx tsx app/lib/__tests__/compose-sentence-plan.test.ts
import assert from "node:assert/strict";
import {
  composeSentencePlanOn, readTurnUnderstanding, readSevenFields, buildSentencePlan, sentencePlanNote, sentencePlanDigest,
  understandingCoverage, planFieldsOf, scoreFields, tallyFields, appealPointsOf, latentKindOf, type TakeuchiGold,
} from "../compose-sentence-plan";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

t("スイッチは既定 off", () => {
  assert.equal(composeSentencePlanOn({}), false);
  assert.equal(composeSentencePlanOn({ COMPOSE_SENTENCE_PLAN: "on" }), true);
  assert.equal(composeSentencePlanOn({ COMPOSE_SENTENCE_PLAN: "off" }), false);
});

// 実物（q088・試験の答案の brain）: 畳の交換の問い＝確認の約束
const q088 = {
  appeal_timing: { kind: "none", level: "avoid", reason: "質問＝答えるだけ" },
  turn_contract: { situation: "DWELL 204号室の畳交換可否を確認している段階", asks: [{ quote: "こちら畳は変えて頂けるのですか？？", route: "promise", about: "property_equipment", property: "DWELL お客様NO 204" }], lead_with: 0, close_only: false },
};

t("材料が今ある物だけ: 主＝約束・物件と何の事が設計図に出る・7つの欄は空のまま（作り話で埋めない）", () => {
  const u = readTurnUnderstanding(q088);
  assert.equal(u.main?.role, "promise");
  assert.equal(u.main?.property, "DWELL お客様NO 204");
  assert.equal(u.src.main, "turn_contract");
  const s = readSevenFields(q088);
  assert.equal(s.leadTo, null); // avoid は誘導先にしない
  assert.equal(s.latentCover, null);
  const p = buildSentencePlan(u, s);
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].rank, "main");
  assert.match(p.rows[0].part ?? "", /DWELL お客様NO 204の 物件の設備・間取り/);
  assert.ok(p.empty.includes("訴求") && p.empty.includes("要点の押さえ方") && p.empty.includes("信頼の作り方"));
  const note = sentencePlanNote(p);
  assert.match(note, /1\. 【主】確かめる約束/);
  assert.doesNotMatch(note, /【従】/);
  const cov = understandingCoverage(u, s, p);
  assert.equal(cov["何の物件"].got && cov["何の物件"].inPlan, true);
  assert.equal(cov["今の状況"].got, true);
  assert.equal(cov["今の状況"].inPlan, false);
  assert.equal(cov["訴求"].got, false);
});

t("AIX の番の主は返信の行にしない（注記は空＝今まで通り）", () => {
  const u = readTurnUnderstanding({ turn_contract: { asks: [{ quote: "初期費用は？", route: "aix", about: "property_cost" }], lead_with: 0 } });
  const p = buildSentencePlan(u, readSevenFields({}));
  assert.equal(p.aixMain, true);
  assert.equal(sentencePlanNote(p), "");
  assert.match(sentencePlanDigest(p), /主=aix/);
});

t("作業員14 の主と従が来ればそれに従う（turn_contract より先）", () => {
  const u = readTurnUnderstanding({
    turn_read: { main: { what: "土曜日の内覧の日の確定", about: "viewing_day", role: "viewing" }, subs: [{ what: "審査の相談", about: "procedure", route: "reply" }] },
    turn_contract: { asks: [{ quote: "審査通りますか", route: "reply", about: "procedure" }] },
  });
  assert.equal(u.src.main, "turn_read");
  const p = buildSentencePlan(u, readSevenFields({}));
  assert.deepEqual(p.rows.map((r) => [r.rank, r.role]), [["main", "viewing"], ["sub", "answer"]]);
});

// 作業員5 の SevenRead（takeuchi-seven-read.ts の形）。竹内さんの q072（9/13 以降の内覧・埋まるか）を読んだ形
const sevenQ072 = {
  point: { what: "9/13まで空いているか", how: "埋まる可能性が高いと言い切る", skipped: null },
  bridge: { what: "撮影・オンライン内見で抑えた状態で13日以降に内覧", how: "時間枠を出す" },
  lead: "apply",
  appeal: { property: "スプランディッド難波WESTⅡ", point: "好条件", how: "同じ条件の方も申込む" },
  latent: { what: "9/13まで待つ間に埋まって逃す", fact: "同じ条件で探している方も申込む", how: "先に抑える道を出す" },
  point_how: ["assert", "name_property"], trust_how: ["preempt", "effort"],
  push: { push: true, strength: "strong", reason: "物件の残り×日程を出した" },
};

t("7つの欄（作業員5 の形）: 主→心配→信頼→誘導の順・訴求は誘導の行・押す強さと理由", () => {
  const meta = { seven_read: sevenQ072, turn_contract: { asks: [{ quote: "今見てる物件埋まる可能性高いですかね", route: "reply", about: "vacancy", property: "スプランディッド難波WESTⅡ" }] } };
  const s = readSevenFields(meta);
  assert.equal(s.src.leadTo, "seven_read");
  assert.equal(s.latentCover?.kind, "先に取られる");
  assert.deepEqual(s.appeal?.points, ["条件の合い方"]);
  const p = buildSentencePlan(readTurnUnderstanding(meta), s);
  assert.deepEqual(p.rows.map((r) => r.role), ["answer", "worry", "trust", "apply"]);
  assert.equal(p.rows[0].rank, "main");
  assert.match(p.rows[0].how ?? "", /言い切る・物件名・号室で名指し/);
  assert.match(p.rows[0].next ?? "", /オンライン内見で抑えた/);
  assert.match(p.rows[1].part ?? "", /待つ間に埋まって逃す／使う事実/);
  assert.match(p.rows[1].how ?? "", /先回り・事実の裏付け|先回り/);
  assert.match(p.rows[2].how ?? "", /こちらの手間を見せる/);
  assert.match(p.rows[3].part ?? "", /^訴求: スプランディッド難波WESTⅡの 好条件/);
  assert.match(p.rows[3].how ?? "", /押す強さ: 強.*物件の残り/);
  const note = sentencePlanNote(p);
  assert.match(note, /2\. 【従】奥の心配への答え/);
  assert.match(note, /足さない/);
});

t("材料の網: 気持ちの型（不安の型だけ）と appeal_timing の suggest", () => {
  const s = readSevenFields({ turn_read: { intent: "内覧したい", mood: { base: "審査の不安", object: "職業・収入", degree: "中" }, feeling: "収入が少なく通るか" }, appeal_timing: { kind: "viewing", level: "suggest" } });
  assert.equal(s.latentCover?.kind, "審査");
  assert.equal(s.latentCover?.what, "収入が少なく通るか");
  assert.equal(s.leadTo, "viewing");
  const s2 = readSevenFields({ turn_read: { mood: { base: "刺さっている", object: "家賃" } } });
  assert.equal(s2.latentCover, null);
});

t("訴求・潜在の言葉の型", () => {
  assert.deepEqual(appealPointsOf("敷金礼金0円でフリーレント"), ["初期費用"]);
  assert.equal(latentKindOf("年末にかかる引越しを避けたい"), "入居日・時期");
  assert.equal(latentKindOf("一人になっても探してもらえるか"), "事情の変化");
});

t("物差し: 欄ごとの当たり（竹内さんに値がある番だけ当たりを数える・空を埋めたら extra）", () => {
  const gold: TakeuchiGold = { id: "x", roles: ["greet", "answer", "apply", "apply", "viewing"], mainRole: "answer", property: "スプランディッド難波WESTⅡ", about: "vacancy", part: "9/13まで空いているか", leadTo: "apply", bridgeRole: "apply", appeal: ["条件の合い方"], latent: "先に取られる", keyHow: ["assert"], trustHow: ["preempt"] };
  const meta = { seven_read: sevenQ072, turn_contract: { asks: [{ quote: "埋まる可能性高いですかね", route: "reply", about: "vacancy", property: "スプランディッド難波WESTⅡ" }] } };
  const u = readTurnUnderstanding(meta), s = readSevenFields(meta);
  const f = scoreFields(gold, planFieldsOf(u, s, buildSentencePlan(u, s)));
  assert.equal(f["主の役目"], "hit");
  assert.equal(f["何の物件"], "hit");
  assert.equal(f["何の事"], "hit");
  assert.equal(f["誘導先"], "hit");
  assert.equal(f["潜在意識のカバー"], "hit");
  assert.equal(f["役目の組み合わせ"], "miss"); // 竹内さんは worry・trust の文を別に書いていない
  assert.equal(f["主→従の順"], "hit");
  const empty = scoreFields(gold, planFieldsOf(readTurnUnderstanding({}), readSevenFields({}), buildSentencePlan(readTurnUnderstanding({}), readSevenFields({}))));
  assert.equal(empty["訴求"], "miss");
  assert.equal(empty["主の役目"], "miss");
  const tl = tallyFields([f, empty]);
  assert.equal(tl["主の役目"].goldHas, 2);
  assert.equal(tl["主の役目"].hit, 1);
});

t("受けが主の番（検討します）: 主の役目と順は受け同士で当たり", () => {
  const gold: TakeuchiGold = { id: "y", roles: ["uke", "uke", "viewing"], mainRole: "uke", property: null, about: "reaction_to_sent", part: null, leadTo: "viewing", bridgeRole: "viewing", appeal: [], latent: null, keyHow: [], trustHow: [] };
  const meta = { turn_contract: { asks: [], close_only: true }, appeal_timing: { kind: "viewing", level: "suggest" } };
  const u = readTurnUnderstanding(meta), s = readSevenFields(meta);
  const p = buildSentencePlan(u, s);
  assert.deepEqual(p.rows.map((r) => r.role), ["uke", "viewing"]);
  const f = scoreFields(gold, planFieldsOf(u, s, p));
  assert.equal(f["主の役目"], "hit");
  assert.equal(f["役目の組み合わせ"], "hit");
  assert.equal(f["訴求"], "both_empty");
});

console.log(`${n} pass`);
