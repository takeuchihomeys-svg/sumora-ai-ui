// npx tsx scripts/lib/__tests__/exam-greeting-decision.test.ts
// 2026-11-21 作業員L（作業員H と決めた）: 竹内さんの決定「続きの番は挨拶を省く」による変化を、試験で悪化と数えない
import assert from "node:assert/strict";
import { greetingSkipIds, stripOpeningGreeting, goldTextForScoring, aixPairForScoring } from "../exam-greeting-decision";
import { scoreAixText } from "../exam-aix-text";

// 本物の正解の文（q071・竹内さんの実送信の頭3行）
const gold = "YUMAさんお世話になっております！！\n2028年3月ご入居とのことで、弊社では2ヶ月前からお引越しのサポートをさせて頂いております。\n2028年1月からお部屋探しをさせて頂ければと思います😊！！";
const s = stripOpeningGreeting(gold);
assert.equal(s.stripped, true);
assert.ok(s.text.startsWith("YUMAさん"), s.text);
assert.ok(!s.text.includes("お世話になっております"));
assert.ok(s.text.includes("2028年3月ご入居とのことで"));

// 印のある問題だけ外す（印は spec.json・SPEC_KEYS には入れない）
const ids = greetingSkipIds([{ id: "q071", greetingDecision: "continuation_skip" }, { id: "q007" }]);
assert.equal(goldTextForScoring("q071", gold, ids).stripped, true);
assert.equal(goldTextForScoring("q007", gold, ids).text, gold);
// 本物の spec.json の6問に印がある
const real = greetingSkipIds();
for (const id of ["q003", "q036", "q071", "q423", "q419", "q176"]) assert.ok(real.has(id), id);

// AIX の文の試験: 本文の会話が続きの番の時だけ、正解と生成の両方から外して比べる
const cont = { recentMessages: [
  { sender: "staff", text: "お部屋お送りさせて頂きます！！", rawCreatedAt: "2026-11-20T12:00:00Z" },
  { sender: "customer", text: "ありがとうございます", rawCreatedAt: "2026-11-20T12:30:00Z" },
] };
const gen = "YUMAさん\n2028年3月ご入居とのことで、弊社では2ヶ月前からお引越しのサポートをさせて頂いております。\n2028年1月からお部屋探しをさせて頂ければと思います😊！！";
const p = aixPairForScoring(cont, gold, gen);
assert.equal(p.stripped, true);
assert.equal(p.gold.replace(/\s+/g, ""), p.gen.replace(/\s+/g, ""));
const sc = scoreAixText({ gold, inputText: gold, body: cont }, gen);
assert.equal(sc.greeting_stripped, true);
// 続きの番でない（別の日に新しく来た）時は外さない
assert.equal(aixPairForScoring({ recentMessages: [cont.recentMessages[0], { ...cont.recentMessages[1], rawCreatedAt: "2026-11-21T09:00:00Z" }] }, gold, gen).stripped, false);
console.log("exam-greeting-decision: ok");
