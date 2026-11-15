// app/lib/__tests__/appeal-record.test.ts — 2026-11-15 作業員K
//   実行: npx tsx app/lib/__tests__/appeal-record.test.ts
//   文は竹内さんの一押しの型（お送りさせて頂きましたお部屋の中でも…）を元に、物件名・お客様は伏せた形
import { appealRecordFromText, compareAppealRecords, appealStrengthOf, appealAimOf, appealRecordMode } from "../appeal-record";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra ?? ""); } };

const tk = "お送りさせて頂きましたお部屋の中でも特に〇〇 302号室は敷金礼金なしで初期費用をかなり抑えられるお部屋となっております😊！！\n\n7.5帖とお広めです！！\n\nお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！";
const r = appealRecordFromText(tk, { surface: "reply", writer: "takeuchi", wants: [{ key: "low_initial", from: "conditions" }, { key: "station_near", from: "conditions" }] });
t("推した点: 敷礼0・初期費用・広さ", ["zero_deposit", "low_initial", "spacious"].every((k) => r.points.includes(k as never)), r.points);
t("希望に応えた点: 初期費用だけ（駅近は推していない）", r.why.length === 1 && r.why[0].topic === "low_initial" && r.fit.wantTotal === 2 && r.fit.wantHit === 1);
t("束の中から1件", r.relevance.oneOfMany);
t("強さ: 案内する（ご都合よろしいお日にち）", r.strength === "invite");
t("狙う返事: 内覧", r.aim === "viewing");
t("外れを先に: 無し", !r.fit.gapFirst);

const gap = "最寄り駅〇〇駅となりますがこちらのお部屋如何でしょうか！！\n\n新築で設備も充実しております！！";
t("外れを先に（となりますが）", appealRecordFromText(gap, { surface: "aix_second", writer: "takeuchi" }).fit.gapFirst);
t("強さ: 抑える → strong", appealStrengthOf("お部屋抑えさせて頂きますのでお気軽にお申し付けください") === "strong");
t("強さ: 併せて → together", appealStrengthOf("こちらのお部屋も併せてご案内させて頂きます") === "together");
t("強さ: ご査収 → door", appealStrengthOf("お手隙の際にご査収ください😊！！") === "door");
t("狙う返事: 見積", appealAimOf("最大限お値引きした御見積書お作りさせて頂きます！！") === "estimate");
t("今推す理由: 退去予定・問い合わせ", (() => { const x = appealRecordFromText("退去予定のお部屋で、お問い合わせも多いお部屋です", { surface: "reply", writer: "ai" }); return x.whyNow.includes("退去予定") && x.whyNow.includes("問い合わせが多い"); })());

const ai = appealRecordFromText("お送りさせて頂きましたお部屋の中でも特に〇〇 302号室は駅徒歩5分・オートロック・宅配ボックス付きです！！\n\nお気軽にご連絡ください！！", { surface: "reply", writer: "ai", wants: [{ key: "low_initial", from: "conditions" }] });
const c = compareAppealRecords(r, ai);
t("比べ: 竹内さんの点（敷礼0・初期費用・広さ）が AI に無い", ["zero_deposit", "low_initial", "spacious"].every((k) => c.missingPoints.includes(k as never)), c.missingPoints);
t("比べ: 強さと狙う返事がずれる", !c.strengthSame && !c.aimSame);
t("比べ: 同じ記録は全部合う", (() => { const x = compareAppealRecords(r, r); return x.pointsOverlap === 1 && x.strengthSame && x.aimSame && x.whySame; })());
t("スイッチ既定 off・shadow", appealRecordMode({}) === "off" && appealRecordMode({ APPEAL_RECORD: "shadow" }) === "shadow" && appealRecordMode({ APPEAL_RECORD: "on" }) === "off");

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
