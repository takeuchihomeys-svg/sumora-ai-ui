// app/lib/__tests__/brain-fast-slow.test.ts — 慣れた事は速く・難しい事はじっくり（brain-fast-slow.ts）
// 実行: npx tsx app/lib/__tests__/brain-fast-slow.test.ts
import {
  brainFastSlowEnabled, brainFastPathEnabled, brainSlowSecondEnabled, decideTurnDifficulty, fastDrops, fastEscapeReason, routeFingerprint, pickMajority,
  type TurnDifficultyInput,
} from "../brain-fast-slow";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const priors = { conditions: { n: 100, asIs: 50 }, viewing: { n: 50, asIs: 9 }, ack: { n: 80, asIs: 26 }, question: { n: 90, asIs: 25 } };
const base: TurnDifficultyInput = { customerText: "", scene: "other", priors, priorBase: 0.33 };
const lv = (i: Partial<TurnDifficultyInput>) => decideTurnDifficulty({ ...base, ...i });

// スイッチ（既定 off）
t("既定 off", !brainFastSlowEnabled({}) && !brainFastPathEnabled({}) && !brainSlowSecondEnabled({}));
t("on で2回目・速い道は既定で止める", brainFastSlowEnabled({ BRAIN_FAST_SLOW: "on" }) && !brainFastPathEnabled({ BRAIN_FAST_SLOW: "on" }) && brainSlowSecondEnabled({ BRAIN_FAST_SLOW: "on" }));
t("速い道は FAST=on の時だけ", brainFastPathEnabled({ BRAIN_FAST_SLOW: "on", BRAIN_FAST_SLOW_FAST: "on" }) && !brainFastPathEnabled({ BRAIN_FAST_SLOW_FAST: "on" }));
t("2回目だけ止める", !brainSlowSecondEnabled({ BRAIN_FAST_SLOW: "on", BRAIN_FAST_SLOW_SECOND: "off" }) && brainFastPathEnabled({ BRAIN_FAST_SLOW: "on", BRAIN_FAST_SLOW_SECOND: "off", BRAIN_FAST_SLOW_FAST: "on" }));
t("off の時は何も渡さない材料が無い", fastDrops("easy", {}).size === 0 && fastDrops("easy", { BRAIN_FAST_SLOW: "on" }).size === 0);
const FAST_ON = { BRAIN_FAST_SLOW: "on", BRAIN_FAST_SLOW_FAST: "on" };
t("FAST=on・easy だけ材料を減らす", fastDrops("easy", FAST_ON).has("ragKnowledge") && fastDrops("normal", FAST_ON).size === 0 && fastDrops("hard", FAST_ON).size === 0);

// 慣れた（全部を満たした時だけ）
t("慣れた場面の短い文 → easy", lv({ customerText: "駅から10分以内でお願いします", scene: "conditions" }).level === "easy");
t("お礼だけ（そのまま率が低い場面）は easy にしない", lv({ customerText: "ありがとうございます！", scene: "ack" }).level === "normal");
t("未対応の約束 → normal", lv({ customerText: "駅から10分以内でお願いします", scene: "conditions", pendingPromises: 1 }).level === "normal");
t("初めての返信 → normal", lv({ customerText: "駅から10分以内でお願いします", scene: "conditions", isFirstContact: true }).level === "normal");
t("申込以降 → normal", lv({ customerText: "駅から10分以内でお願いします", scene: "conditions", postApply: true }).level === "normal");
t("画像 → normal", lv({ customerText: "駅から10分以内でお願いします", scene: "conditions", hasImage: true }).level === "normal");
t("気がかりの言葉 → normal", lv({ customerText: "駅から10分以内でお願いします", scene: "conditions", mindWorry: "不安" }).level === "normal");
t("質問2つ → normal", lv({ customerText: "駅近ですか？ペット可ですか？", scene: "conditions" }).level === "normal");
t("前例の少ない場面 → normal", lv({ customerText: "駅から10分以内でお願いします", scene: "cost" }).level === "normal");

// 難しい（1つでも）
t("よく直される場面 → hard", lv({ customerText: "土曜日に内覧できますか？", scene: "viewing" }).level === "hard");
t("質問3つ → hard", lv({ customerText: "駐車場ありますか？ペット可ですか？初期費用はいくらですか？", scene: "question" }).level === "hard");
t("人生の出来事 → hard", lv({ customerText: "転勤が決まったので急ぎで探しています", scene: "conditions" }).level === "hard");
t("条件の変更 → hard", lv({ customerText: "やっぱり予算を上げてもいいです", scene: "conditions" }).level === "hard");
t("条件の文の型は条件の変更にしない", lv({ customerText: "やっぱり予算を上げてもいいです", scene: "conditions", conditionForm: true }).level !== "hard");
t("審査の事情 → hard", lv({ customerText: "x", scene: "question", screeningSensitive: true }).level === "hard");
t("不満 → hard", lv({ customerText: "まだですか？", scene: "question" }).level === "hard");
t("物件の URL 2つは難しいにしない（型どおりの持ち込み）", lv({ customerText: "https://a.example/1 https://a.example/2", scene: "other" }).level === "normal");

// 戻り道
t("受け止めだけの判断は戻らない", fastEscapeReason({ reply_mode: "auto_reply", aix: null, turn_contract: { asks: [{ route: "reply", gap: null }] } }) === null);
t("依頼2つ → 戻る", fastEscapeReason({ turn_contract: { asks: [{ route: "reply" }, { route: "reply" }] } }) !== null);
t("約束 → 戻る", fastEscapeReason({ turn_contract: { asks: [{ route: "promise" }] } }) !== null);
t("材料が足りない → 戻る", fastEscapeReason({ turn_contract: { asks: [{ route: "reply", gap: "material" }] } }) !== null);
t("AIX → 戻る", fastEscapeReason({ aix: "物件ピックアップした" }) !== null);
t("aix が文字の null は戻らない", fastEscapeReason({ aix: "null", action: "null", reply_mode: "auto_reply" }) === null);
t("読めない → 戻る", fastEscapeReason(null) !== null);

// 道の指紋と多数決
const a = { reply_mode: "auto_reply", aix: null, turn_contract: { asks: [{ route: "reply" }, { route: "promise" }] } };
const b = { reply_mode: "auto_reply", aix: null, turn_contract: { asks: [{ route: "promise" }, { route: "reply" }] }, reply_direction: "違う言い回し" };
const c = { reply_mode: "aix", aix: "見積書送る", turn_contract: { asks: [{ route: "aix" }] } };
t("依頼の並びと言い回しは指紋に入らない", routeFingerprint(a) === routeFingerprint(b));
t("道が違えば指紋が違う", routeFingerprint(a) !== routeFingerprint(c));
t("2つ揃えば1回目", JSON.stringify(pickMajority(["x", "x"])) === JSON.stringify({ pick: 0, split: false, agree: true }));
t("2つ違えば割れ（3回目へ）", pickMajority(["x", "y"]).split);
t("3回で2つ揃った方（2回目と3回目）", pickMajority(["x", "y", "y"]).pick === 1 && !pickMajority(["x", "y", "y"]).split);
t("3回で1回目と3回目が揃えば1回目", pickMajority(["x", "y", "x"]).pick === 0);
t("3つとも違えば1回目のまま割れ", JSON.stringify(pickMajority(["x", "y", "z"])) === JSON.stringify({ pick: 0, split: true, agree: false }));
t("読めない答え同士は揃わない", pickMajority(["x", "∅2", "∅3"]).split);

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
