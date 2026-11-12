// app/lib/__tests__/aix-second-reread.test.ts — ブレインと押された AIX が違う2通目の読み直し（npx tsx で回す）。
//   番は竹内さんの実物（exam-cache/anatomy-seven/aix-second-pairs.json・押したのは全部 物件オススメ・名前は YUMA に伏せ済み）の直前のブレインの記録
import { aixSecondRereadOn, brainPressedDiffer, stripBrainDirection, parseReread, rereadNote, buildRereadUser, BRAIN_DIRECTION_KEYS } from "../aix-second-reread";
import { buildBrainStrategyNote } from "../brain-strategy-note";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
const P = "property_recommendation";

t("既定 off", !aixSecondRereadOn({}) && aixSecondRereadOn({ AIX_SECOND_REREAD: "on" }));
// 実物の直前のブレインの一手（48組の内訳: 返信 25・物件ピックアップした 12・物件確認した 8・見積書 2・全力サポート 1）
const acts: Array<[string | null, number]> = [[null, 25], ["property_send", 12], ["property_check_result", 8], ["estimate_sheet", 2], ["zenryoku_support", 1]];
const differ = acts.reduce((s, [a, n]) => s + (brainPressedDiffer(a, P) ? n : 0), 0);
t("違う番は 36/48（返信・物件確認した・見積書・全力サポート）", differ === 36, differ);
t("物件ピックアップした→物件オススメは同じ一手", !brainPressedDiffer("property_send", P) && !brainPressedDiffer(P, "property_send"));
t("同じ AIX は違わない・ピッカー付きも頭で比べる", !brainPressedDiffer(P, P) && !brainPressedDiffer("property_check_result/vacancy", "property_check_result"));
t("押された AIX が無ければ違うと言わない", !brainPressedDiffer(null, null) && !brainPressedDiffer("estimate_sheet", ""));

// #2 実物: ブレインは返信（action なし）・方向「お礼を受けて、立売堀の募集状況の確認結果と10万円以下…のピックアップを出来次第お送りする旨を、待ちの…」
const meta2 = {
  action: null, reply_direction: "お礼を受けて、立売堀の募集状況の確認結果と10万円以下・桜川/新町/西長堀のピックアップを出来次第お送りする旨を、待ちの形で",
  reason: "お礼のみ・約束を待ちの形で", winning_pattern: "ピックアップを出来次第お送りする", customer_emotion: "安くしたい", latent_intent: "初期費用を抑えたい",
};
const before = buildBrainStrategyNote(meta2 as never, { fresh: true, actionLabel: "物件オススメ" });
t("#2 旧: 古い方向「出来次第お送りする」がそのまま渡り、注意書きも無い", before.includes("出来次第お送りする") && !before.includes("別アクション"), before.slice(0, 300));
const stripped = stripBrainDirection(meta2 as Record<string, unknown>)!;
const after = buildBrainStrategyNote(stripped as never, { fresh: true, actionLabel: "物件オススメ" });
t("#2 直した後: 方向・勝ちパターン・判断理由は渡らない", !after.includes("出来次第") && !after.includes("判断理由") && !after.includes("勝ちパターン"), after);
t("#2 直した後: お客様の読み（気持ち・潜在）は残る", after.includes("安くしたい") && after.includes("初期費用を抑えたい"), after);
t("元の meta は書き換えない", meta2.reply_direction.includes("出来次第"));
t("方向の欄の一覧", BRAIN_DIRECTION_KEYS.includes("reply_direction") && BRAIN_DIRECTION_KEYS.includes("winning_pattern") && !(BRAIN_DIRECTION_KEYS as readonly string[]).includes("latent_intent"));

// 読み直しの答えの読み取り
const ok = parseReread('{"why":"約束していた条件に合う1件が見つかった","answers":"10万円以下・桜川周辺のご希望","points":["敷金礼金なし","築浅","家賃管理費込"]}');
t("読み直しを読む", !!ok && ok.why.includes("1件") && ok.points.length === 3, ok);
t("道の言葉があれば捨てる（案B へ）", parseReread('{"why":"本来は返信にすべき番","answers":"","points":[]}') === null);
t("壊れた JSON・空は null", parseReread("わかりません") === null && parseReread('{"why":"","answers":"","points":[]}') === null);
t("長すぎる欄は切る・要点は3つまで", (parseReread(`{"why":"${"あ".repeat(200)}","answers":"x","points":["a","b","c","d"]}`)?.why.length ?? 0) <= 60 && parseReread('{"why":"a","points":["1","2","3","4"]}')!.points.length === 3);

// 注記（案A と案B）
const a = rereadNote({ pressedLabel: "物件オススメ", brainLabel: null, reread: ok });
t("案A: 押された AIX が正・読み直しの3つ", a.includes("物件オススメ）が正") && a.includes("ブレインの勧めは返信") && a.includes("なぜ今これを送るのか") && a.includes("敷金礼金なし"), a);
const b = rereadNote({ pressedLabel: "物件オススメ", brainLabel: "物件確認した", reread: null });
t("案B: 方向を使わない・会話と1通目だけ", b.includes("ブレインの勧めは物件確認した") && b.includes("会話だけで書く") && !b.includes("なぜ今"), b);

// 読み直しに渡す材料（#17 実物の1通目の頭・お客様の言葉）
const u = buildRereadUser({ pressedLabel: "物件オススメ", meaning: "【このボタン・ピッカーの意味（竹内基準）】物件オススメ", firstMessage: "🌟エグゼ難波ウエストリバー 502\n\n1件新着でYUMAさんにかなりオススメ出来るお部屋が募集に出ました！！", customerText: "この2箇所気になったんですけど、どうですか？？(どう？)", readings: ["気持ち: 迷い"] });
t("材料: 押された AIX・1通目・お客様の発言・読み（方向は入らない）", u.includes("【押された AIX】物件オススメ") && u.includes("エグゼ難波") && u.includes("この2箇所") && u.includes("方向ではない"), u);

console.log(`aix-second-reread: ${pass} ok / ${fail} NG`);
if (fail) process.exitCode = 1;
