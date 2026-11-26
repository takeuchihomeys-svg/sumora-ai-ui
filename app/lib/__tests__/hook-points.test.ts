// npx tsx app/lib/__tests__/hook-points.test.ts
// 2026-11-21 作業員K2: 刺さった点（SENT_HOOK_POINTS・SENT_HOOK_WEIGHT・既定 off）
import assert from "node:assert/strict";
import { hookPointsOf, normalizeHookPoints, sentHookRecordOn, sentHookWeightOn, isImageOnlyQuote, quotedTextForHook, sentHookImageTextOn } from "../hook-points";
import { sentLikePoints, type SentLikeProfile } from "../sent-like-fit";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const card = "🌟物件A 301号室🌟\n（オススメポイント）\n・2LDK 55㎡の広々とした間取り\n・築3年の新しいお部屋\n・駅徒歩5分";

t("既定 off", () => {
  assert.equal(sentHookRecordOn({}), true); assert.equal(sentHookRecordOn({ SENT_HOOK_POINTS: "off" }), false); assert.equal(sentHookWeightOn({}), false);
  assert.equal(sentHookRecordOn({ SENT_HOOK_POINTS: "on" }), true); assert.equal(sentHookWeightOn({ SENT_HOOK_WEIGHT: "on" }), true);
});
t("広さに刺さった", () => { assert.deepEqual(hookPointsOf(card, "めっちゃ広いですね！いいですね"), ["広さ・間取り"]); });
t("刺さらなかった（遠い）・了承だけは空", () => {
  assert.deepEqual(hookPointsOf(card, "ちょっと駅から遠いですね"), []);
  assert.deepEqual(hookPointsOf(card, "ありがとうございます"), []);
  assert.deepEqual(hookPointsOf("", "いいですね"), []);
});
t("保存値の読み（知らない語は捨てる）", () => { assert.deepEqual(normalizeHookPoints(["新しさ", "謎", 3, "新しさ"]), ["新しさ"]); assert.deepEqual(normalizeHookPoints(null), []); });
t("像の比べ: 刺さった軸は2倍・上限は同じ・無ければ今と同じ", () => {
  const base: SentLikeProfile = { n: 2, plans: ["2LDK"], areaSqm: 50, ageYears: 10, walk: 8 };
  const c = { floorPlan: null, areaSqm: 52, buildingAge: 30, walkMinutes: 20 };
  assert.equal(sentLikePoints(base, c).points, 4);
  assert.equal(sentLikePoints({ ...base, hookPoints: ["広さ・間取り"] }, c).points, 8);
  assert.equal(sentLikePoints({ ...base, hookPoints: ["新しさ"] }, c).points, 4);
  assert.equal(sentLikePoints({ ...base, hookPoints: ["広さ・間取り"] }, { floorPlan: "2LDK", areaSqm: 52, buildingAge: 5, walkMinutes: 5 }).points, 10);
});
// 2026-11-26 作業員A（#793）: 画像の引用は資料の要約を引用先の文の代わりに
t("画像だけの引用の見分け・代わりの文・既定 on", () => {
  assert.equal(isImageOnlyQuote("[画像]"), true); assert.equal(isImageOnlyQuote(""), true); assert.equal(isImageOnlyQuote("【物件 101号室】家賃8万円"), false);
  assert.equal(quotedTextForHook("物件", "101", "家賃8万円・1LDK"), "【物件 101】\n家賃8万円・1LDK"); assert.equal(quotedTextForHook("物件", "101", null), "");
  assert.equal(sentHookImageTextOn({}), true); assert.equal(sentHookImageTextOn({ SENT_HOOK_IMAGE_TEXT: "off" }), false);
});
console.log(`${n} ok`);
