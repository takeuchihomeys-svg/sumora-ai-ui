// app/lib/__tests__/second-appeal-judge.test.ts — 2通目の訴求の判断（純関数）
import { secondAppealJudgeOn, secondFormScene, parseAppealJudge, judgedAppealNote, countAppeals, overAppealCount, appealJudgePrompt, pickTakeuchiExamples } from "../second-appeal-judge";
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
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
