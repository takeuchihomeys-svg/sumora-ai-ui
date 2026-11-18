// app/lib/__tests__/second-appeal-judge.test.ts — 2通目の訴求の判断（純関数）
import { secondAppealJudgeOn, secondFormScene, parseAppealJudge, judgedAppealNote, countAppeals, overAppealCount, appealJudgePrompt, pickTakeuchiExamples, secondAppealCountBySceneOn, equipmentItemsOf, equipmentRichOf, appealJudgeSystem, APPEAL_JUDGE_SYSTEM } from "../second-appeal-judge";
let pass = 0, fail = 0;
// 手本・型の要約は DB から（ここは作り物）
const DATA = { forms: { "物件オススメ・新規ピックアップ": { n: 3, avgPoints: 2, first: [{ el: "shikirei", pct: 50 }], phrases: [{ text: "敷金礼金なしで初期費用を抑える事ができ", n: 2 }], links: [{ key: "name_osusume", pct: 60 }], closing: [{ kind: "viewing", pct: 50 }] } }, examples: [1, 2, 3, 4].map((k) => ({ scene: "物件オススメ・新規ピックアップ", els: ["shikirei"], body: `手本${k} 敷金礼金なしで初期費用を抑える事ができ、YUMAさんにかなりオススメ出来るお部屋となります！！`, sent_on: `2026-10-0${k}` })) };
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
t("既定 on・off で戻る", secondAppealJudgeOn({}) && !secondAppealJudgeOn({ AIX_SECOND_APPEAL_JUDGE: "off" }));
t("場面", secondFormScene("新着1件") === "物件オススメ・新着1件" && secondFormScene(null) === "物件オススメ・新規ピックアップ");
const j = parseAppealJudge('前 {"first":{"text":"敷金礼金なしで初期費用を抑えられる","why":"費用を気にされている"},"second":null,"count":1,"form":"〇〇さんにかなりオススメ出来るお部屋","closing":"receipt","closingWhy":"退去予定"} 後');
t("判断を読む", !!j && j.count === 1 && j.closing === "receipt" && j.second === null, j);
t("締めが知らない値なら読まない", parseAppealJudge('{"first":{"text":"a","why":"b"},"count":1,"closing":"x"}') === null);
const note = j ? judgedAppealNote(j, "物件オススメ・新規ピックアップ", DATA) : "";
t("注記: 判断・型・手本・金額を書かない", note.includes("【ブレインの訴求の判断") && note.includes("【竹内さんの2通目の型") && note.includes("手本") && note.includes("節約額は書かない"), note.slice(0, 200));
t("訴求の数（敷金礼金なし＋初期費用を抑えるは1つ）", countAppeals("敷金礼金なしで初期費用を抑える事ができ、YUMAさんにかなりオススメ出来るお部屋となります！！\nお手隙の際にご査収ください😌！！") === 1);
t("並べすぎ", overAppealCount("2018年5月築で築年数浅く、独立洗面台・浴室乾燥機付き、駅徒歩5分、敷金礼金なし、ペット飼育可能", { count: 1 }));
const p = appealJudgePrompt({ firstMessage: "🌟X 101\n（オススメポイント）\n・敷金礼金なしのため初期費用を抑えられます！！\n・角部屋で日当たり良好", customerPoints: "初期費用を抑えたい", conditions: "", scene: "物件オススメ・新規ピックアップ", notViewable: false, data: DATA });
t("判断の入力に候補と型", p.candidates.length === 2 && p.prompt.includes("【竹内さんの2通目の型"), p.candidates);
t("手本は3通まで", pickTakeuchiExamples(DATA.examples, "物件オススメ・新規ピックアップ", ["shikirei"], 3).length === 3);
t("手本が無くても注記は作れる（手本なし）", !!j && judgedAppealNote(j, "物件オススメ・新規ピックアップ", { forms: {}, examples: [] }).includes("【ブレインの訴求の判断"));
// ── 2026-11-18 推す点の数を場面で変える（SECOND_APPEAL_COUNT_BY_SCENE・既定 off）──
{
  t("数の場面: 既定 off", !secondAppealCountBySceneOn({}) && secondAppealCountBySceneOn({ SECOND_APPEAL_COUNT_BY_SCENE: "on" }));
  const rich1 = "🌟X 101\n・インターネット無料\n・浴室乾燥機\n・独立洗面台\n・オートロック\n・宅配ボックス\n・敷金礼金なし";
  t("設備5個 → 揃った部屋", equipmentItemsOf(rich1).length === 5 && equipmentRichOf(rich1), equipmentItemsOf(rich1));
  t("設備4個 → 揃っていない", !equipmentRichOf("・インターネット無料\n・浴室乾燥機\n・独立洗面台\n・オートロック"));
  t("揃っていない時の決まりは今までと同じ文", appealJudgeSystem(false) === APPEAL_JUDGE_SYSTEM);
  t("揃った時の決まりは3〜5個・JSON に more", /3〜5個/.test(appealJudgeSystem(true)) && /"more"/.test(appealJudgeSystem(true)) && !/1〜2個だけ/.test(appealJudgeSystem(true)));
  const j5 = parseAppealJudge('{"first":{"text":"インターネット無料","why":"在宅"},"second":{"text":"浴室乾燥機","why":"雨の日"},"more":[{"text":"独立洗面台","why":"身支度"},{"text":"オートロック","why":"女性の一人暮らし"}],"count":4,"form":"x","closing":"viewing","closingWhy":"y"}');
  t("3個以上の判断を読む（count は並べた数）", !!j5 && j5.count === 4 && j5.more?.length === 2, j5);
  const j5n = j5 ? judgedAppealNote(j5, "物件オススメ・新規ピックアップ", DATA) : "";
  t("注記に3番目以降と2番目", j5n.includes("・3番目以降: 独立洗面台・オートロック") && j5n.includes("・2番目: 浴室乾燥機") && j5n.includes("3〜5個"), j5n);
  t("並べすぎの確かめは数に合わせる（4個の判断で4要素は並べすぎでない）", !!j5 && !overAppealCount("インターネット無料・浴室乾燥機・独立洗面台・オートロック付きのお部屋", j5));
  const jOld = parseAppealJudge('{"first":{"text":"a","why":"b"},"second":null,"more":[{"text":"c","why":"d"}],"count":1,"closing":"receipt"}');
  t("2番目が無い時は more を読まない（今まで通り1個）", !!jOld && jOld.count === 1 && !jOld.more, jOld);
  const pr = appealJudgePrompt({ firstMessage: rich1, customerPoints: "", conditions: "", scene: "物件オススメ・新規ピックアップ", notViewable: false, data: DATA, rich: true } as never);
  t("揃った時の判断の入力に設備の一覧", pr.prompt.includes("## 設備が揃ったお部屋（1通目の設備 5個"), pr.prompt.slice(-300));
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
