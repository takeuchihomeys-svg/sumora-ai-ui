// app/lib/__tests__/aix-second-link.test.ts — AIX の2通目とブレイン・1通目のつなぎ目（npx tsx で回す）。1通目・お客様の言葉は竹内さんの実物（名前は YUMA に伏せ済み・exam-cache/anatomy-seven/aix-second-pairs.json）
import { openPromisesAfterFirst, secondDecideGapLine, decideGapOfMeta, gapWords, aixSecondLinkOn, type TimedMsg } from "../aix-second-link";
import { openPromises, splitTurn, timed } from "../second-message-materials";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };

// 実物の1通目（#0 ピックアップの後の推し・#21 新着1件・#28 1件オススメ）
const FIRST0 = "🌟プレジオ神戸WEST 203号室\n\n（オススメポイント）\n・家賃75,000円・管理費15,000円（合計90,000円）\n・間取り：1DK（DK7.5帖、洋室4帖）\n・山陽線「兵庫」徒歩10分\n・敷金礼金なしのため初期費用をかなり抑えてご入居頂けます！！\n・2018年1月築で築年数浅く\n・インターネット無料\n\n🌟最大限割引しました初期費用の御見積書同封させて頂きました！";
const FIRST21 = "🌟グランノーブルⅡ 203\n\n\n（オススメポイント）\n・家賃68,000円・管理費7,700円（合計75,700円）\n・間取り：2LDK（リビング10.3帖、洋室6帖・洋室5.3帖）\n・2019年9月築で築年数浅く\n・ペット共生マンション飼育可能\n・独立洗面台・追い焚き・浴室乾燥機など水回り設備も充実\n・インターネット無料（NURO光）";
const FIRST28 = "🌟ベルフルールN・K 205\n\n（オススメポイント）\n・家賃67,000円・管理費4,100円（合計71,100円）\n・間取り：1LDK（リビング10.5帖、洋室5.1帖）\n・専有面積40.52㎡のゆとりある広さ\n・カウンターキッチン\n・ペット飼育可能・2人入居可能\n・独立洗面台・浴室乾燥機・追い焚き・シャワートイレ完備";
const now = Date.parse("2026-11-10T10:00:00Z");
const recentOf = (promise: string) => [
  { sender: "staff", text: promise, rawCreatedAt: "2026-11-10T08:00:00Z" },
  { sender: "customer", text: "よろしくお願いいたします", rawCreatedAt: "2026-11-10T08:05:00Z" },
];
const ON = { PROMISE_READ_UNIFIED: "on" };

// ① 約束の読み
for (const [name, promise, first, action] of [
  ["#0 ピックアップの約束→物件オススメの札", "ピックアップさせて頂き、出来次第お送りさせて頂きます！！", FIRST0, "property_recommendation"],
  ["#21 新着の約束→物件オススメの札", "新着のお部屋募集に出次第お送りさせて頂きます！！", FIRST21, "property_recommendation"],
  ["ピックアップの約束→物件ピックアップしたの札", "ピックアップさせて頂き、出来次第お送りさせて頂きます！！", FIRST0, "property_send"],
] as const) {
  const recent = recentOf(promise);
  const { turnStaff } = splitTurn(recent, first);
  const old = openPromises(recent, turnStaff, now);
  const offExplicit = openPromises(recent, turnStaff, now, { actionType: action, sentMessage: first, env: {} });
  const fixed = openPromises(recent, turnStaff, now, { actionType: action, sentMessage: first, env: ON });
  t(`${name}: 旧（既定）は開いていると読む＝直す前の再現`, old.length === 1 && old[0].kind === "物件探し", old);
  t(`${name}: スイッチ off は旧と同じ`, JSON.stringify(offExplicit) === JSON.stringify(old), offExplicit);
  t(`${name}: PROMISE_READ_UNIFIED=on で1通目の札が約束を閉じる`, fixed.length === 0, fixed);
}
{
  // 確認の約束は物件オススメの札では閉じない（管理会社への確認の結果は物件確認した の番）
  const recent = recentOf("募集状況確認させて頂き、確認出来次第ご連絡させて頂きます！！");
  const { turnStaff } = splitTurn(recent, FIRST21);
  const fixed = openPromises(recent, turnStaff, now, { actionType: "property_recommendation", sentMessage: FIRST21, env: ON });
  t("確認の約束は物件オススメの札では開いたまま", fixed.length === 1 && fixed[0].kind === "確認", fixed);
  // 1通目の種類が分からない（actionType 無し）時は閉じない（AIX の記録なしで読む）
  const tm: TimedMsg[] = timed(recentOf("ピックアップさせて頂き、出来次第お送りさせて頂きます！！"), [FIRST0], now);
  t("ボタンの種類が無い時は閉じない", openPromisesAfterFirst(tm, { nowMs: now, actionType: null, sentMessage: FIRST0 }).length === 1);
  // 1通目の後にピックアップの約束を言い直していない番（約束が無い）は空
  t("約束が無ければ空", openPromisesAfterFirst(timed([{ sender: "customer", text: "お願いします", rawCreatedAt: "2026-11-10T08:05:00Z" }], [FIRST0], now), { nowMs: now, actionType: "property_recommendation", sentMessage: FIRST0 }).length === 0);
}

// ② 決め手の残り
t("既定 off", !aixSecondLinkOn({}) && aixSecondLinkOn({ AIX_SECOND_LINK: "on" }));
const meta28 = { customer_mindset: { state: "普通の依頼", anxiety: null, hesitation: null, decideGap: { point: "設備", solve: "a", property: "荒本フラワーレジデンス 202", quote: "できればカウンターキッチンだと嬉しい" } } };
const g28 = decideGapOfMeta(meta28);
t("decideGap を meta から読む", g28?.quote === "できればカウンターキッチンだと嬉しい", g28);
t("言葉の塊にカウンターキッチン", gapWords("できればカウンターキッチンだと嬉しい").includes("カウンターキッチン"), gapWords("できればカウンターキッチンだと嬉しい"));
const l28 = secondDecideGapLine(g28, FIRST28);
t("#28 1通目にある→推す軸の一番に", !!l28 && l28.includes("「カウンターキッチン」がある") && l28.includes("推す軸の一番"), l28);
// #21 犬2匹（1通目は「ペット共生マンション飼育可能」・「犬」の字は無い）→ 作らない側
const l21 = secondDecideGapLine({ point: "ペット・条件の可否", solve: "c", property: null, quote: "犬2匹でいい物件があれば" }, FIRST21);
t("#21 1通目に言葉が無い→事実だけ", !!l21 && l21.includes("資料にこの言葉は無い") && !l21.includes("推す軸の一番"), l21);
t("decideGap が無い・言葉が空なら null", secondDecideGapLine(decideGapOfMeta({}), FIRST0) === null && secondDecideGapLine({ point: "設備", quote: " " }, FIRST0) === null && decideGapOfMeta(null) === null);
// 一般の言葉（部屋・物件・希望）だけでは当てない
t("一般の言葉では当てない", !gapWords("良い部屋の希望").some((w) => ["部屋", "希望"].includes(w)), gapWords("良い部屋の希望"));

console.log(`aix-second-link: ${pass} ok / ${fail} NG`);
if (fail) process.exitCode = 1;
