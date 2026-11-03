// app/lib/__tests__/reading-tags.test.ts — お客様の読み方の候補の札（純関数・文は作り物）
import { worryCandidatesOf, readBeyondOf, utterTypesOf, readingCandidateGate, worryCandidateLine } from "../reading-tags";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };

t("心配の候補", worryCandidatesOf("彼氏と同棲予定で、12月中に入居したいです").join() === "timing,partner", worryCandidatesOf("彼氏と同棲予定で、12月中に入居したいです"));
const rb = readBeyondOf("こちら空いてますか？", "かしこまりました！！\n募集状況確認させて頂き、最大限割引しました初期費用の御見積書とあわせてお送りさせて頂きます！！\n全力でサポートさせて頂きます！！");
t("表の質問に加えて答えた事（費用・サポート）", rb.includes("cost") && rb.includes("support"), rb);
t("お客様が言った心配は read_beyond に入れない", !readBeyondOf("初期費用いくらですか", "初期費用の御見積書をお送りさせて頂きます").includes("cost"));
t("発言の型", utterTypesOf({ customerText: "初期費用いくらですか？駅近で築浅がいいです", turnNo: 1 }).join() === "early_cost_ask,station_near,new_build");
t("繰り返し・間・短い", utterTypesOf({ customerText: "まだ空いてますか", prevCustomerTexts: ["まだ空いてますか？"], replyGapMinutes: 2000 }).join() === "repeat_ask,slow_reply,short_reply");
t("線: 件数と当たりの割合", readingCandidateGate([{ tag: "cost", n: 40, hit: 30 }, { tag: "partner", n: 5, hit: 5 }, { tag: "timing", n: 20, hit: 10 }]).join() === "cost");
t("候補と書く1行", /候補/.test(worryCandidateLine(["cost"])) && /決めるのはあなた/.test(worryCandidateLine(["cost"])) && worryCandidateLine([]) === "");

console.log(`reading-tags: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);

{
  // 2026-11-04 答えた心配（言われた心配のうち竹内さんの文が答えた物・read_beyond と重ならない）
  const { answeredWorryOf, readBeyondOf } = require("../reading-tags");
  const cust = "審査通りますか？初期費用はいくらですか";
  const staff = "審査面に関しましては通過する可能性十分に御座います！！全力でサポートさせて頂きます！！";
  const a = answeredWorryOf(cust, staff), b = readBeyondOf(cust, staff);
  const ok = a.join() === "screening" && !b.includes("screening") && b.includes("support");
  console.log(ok ? "answered-worry: pass" : "answered-worry: FAIL " + a.join() + " / " + b.join()); if (!ok) process.exit(1);
}
