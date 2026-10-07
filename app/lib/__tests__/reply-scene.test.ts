// app/lib/__tests__/reply-scene.test.ts — 2026-10-07 場面の整理（実行: npx tsx app/lib/__tests__/reply-scene.test.ts）
//   文は本番の実際のお客様の発言（9/07〜の番・名前は伏せた）
import { resolveReplyScene, phaseGuideForScene, keepMaterial, sceneMaterialsEnabled, stripKnowledgeSections, consideringAvoidTopics, CONSIDERING_AVOID_PUSH, CONSIDERING_DOOR_EXEMPT_NOTE } from "../reply-scene";
import { PHASE_GUIDE } from "../line-reply-prompts";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const sc = (s: string) => resolveReplyScene({ customerText: s }).scene;

const cases: Array<[string, string]> = [
  ["ありがとうございます🙏🏻", "ack"],
  // 3巡目: 「よろしくお願いします」は依頼の語ではない（内覧の駐車場の質問を条件にしていた）
  ["よろしくお願いします\n駐車場は近くのパーキングでよろしいですか？", "question"],
  // 3巡目: お礼の語を除いた残りに中身がある発言は短いお礼にしない（条件・断り・依頼を落とさない＝本番 1,000 発言で 41 が other へ）
  ["[スタンプ]", "ack"],
  ["お願い致します！", "ack"],
  ["本当にご無理を言いまして申し訳ありません。\nよろしくお願い致します。", "ack"],
  ["ありがとうございます！\nアーバネックス気になります！", "other"],
  ["よろしくお願いします！\n心斎橋難波辺りが近めでお願いします。", "other"],
  ["すいません。この物件はいらないです。", "other"],
  ["こちらこそよろしくお願いします🙇", "ack"],
  ["お願いします🤭", "ack"],
  ["ありがとうございます。 検討させていただきます", "considering"],
  ["承知しました。今ルームシェアの話が知人から出ていてまた決まり次第ご連絡してもいいでしょうか", "considering"],
  ["承知致しました。\n\n明日また連絡させて頂きます。", "considering"],
  ["駐車場は近くのパーキングでよろしいですか？", "question"],
  ["2LDKだともう少し上がりますか？", "question"],
  ["家賃をいくらまでにしたら、堺筋本町あたりに物件が出てきますか？", "question"],
  ["ケイアイズとケイメゾン名前違うのはなんかあるんですかね？", "question"],
  ["谷町線大日駅近くで、その他同じような条件でお部屋探していただけますでしょうか？", "conditions"],
  ["できればアパートではなく、マンション希望で、3階以上が理想です", "conditions"],
  ["（あやさんご希望のお部屋探しご条件）\n①ご入居時期  10月29日〜11月1日\n②ご希望家賃（管理費込み）  6万〜7万\n③ご希望間取り", "conditions"],
  ["おはようございます。お伝えするの忘れてました。出来ましたら、敷金・礼金はなしでお願いしたいです。", "conditions"],
  ["田辺５丁目貸家 1階 https://suumo.jp/chintai/bc_100526949079/ by SUUMO", "property_share"],
  ["[画像] 物件種目：【住居用】マンション 物件名：エヴゼ峰渡西Ⅱ", "property_share"],
  ["ありがとうございます！ 今までで1番理想のお部屋です！ ちなみに初期費用はいくらになりますか？", "cost"],
  ["ありがとうございます😊 クレール元町の見積りお願いしたいです。", "cost"],
  ["S-RESIDENCE難波の方到着してます！", "viewing"],
  ["すみません道が混んでて5分から10分ほど遅れます🙇‍♀️", "viewing"],
  ["18時半可能ですか？😭", "viewing"],
  ["先に管理会社に審査通してって感じですか？", "apply"],
  // 2巡目の見直し（30日の番を読んで外れていた物）
  ["①すぐにでも ②七万円位まで ③2DKくらい ④リノベーションされていればある程度大丈夫です ⑤どこでも ⑥１０分 ⑦極端に安い方がいいです", "conditions"],
  ["1LDKで 職場が天王寺なので 近くで探してて  ⁣ 初期費用23万くらいで探しです", "conditions"],
  ["堺筋本町、長堀橋あたりで広くて初期費用安いお部屋ありますか？", "conditions"],
  ["お世話になっております🙇🏻‍♀️ 今の条件だと見つからなそうなので 大国町、桜川、 南船場あたりでいい部屋ございますでしょうか？", "conditions"],
  ["[画像] 御見積書 様  2026年9月6日  この度は、連産業株式会社をご利用頂き", "apply"],
  ["おはようございます エスリード長居の件ですが、 仮おさえしてもらうのは、可能でしょうか？？", "apply"],
  ["着きました", "viewing"],
  ["ちなみに茨木市と高槻市はないですか？", "conditions"],
  ["家賃を15万円までにした場合の物件も あれば教えていただけませんか？🥺", "conditions"],
  ["上本町、谷町とかもありますか？ すいません何度も", "conditions"],
  ["10時半頃に電話かけさせて頂きます。", "other"],
  ["明日の朝イチでご返信いたします🙇‍♂️", "considering"],
  ["2028/3月以降入居 4~7万 2LDK 20年以内 駅から徒歩10分 20万", "conditions"],
  ["大阪市内か 茨木市か高槻市で 出来れば1LDKで 家賃70000円台で 初期費用激安で探してます", "conditions"],
  ["こちらの2つの物件初期費用いくらぐらいでしょうか？", "cost"],
  ["昭和町は治安悪くないですか？😭", "question"],
  ["まず生活保護者可能な賃貸 1.入居時期　12月 2.希望家賃　3万円〜4万円 3.希望の広さ　広い方が良い1DK〜2D K 4.気にしない 5.希望エリア　大阪府淀川区 6.気にしない 7.初期費用の限度　安いに限る", "conditions"],
  ["トイレと洗面所別の物件は高くなってしまいますか？", "question"],
];
for (const [s, want] of cases) t(`${want} ← ${s.replace(/\n/g, " ").slice(0, 24)}（${sc(s)}）`, sc(s) === want);

// PHASE_GUIDE proposing を場面で絞る
const full = PHASE_GUIDE.proposing;
const ack = phaseGuideForScene("proposing", full, "ack");
t(`ack: パターンを絞る（${ack.kept?.join(",")}）`, !!ack.kept && ack.kept.includes("F3") && ack.kept.includes("W") && !ack.kept.includes("I"));
t(`ack: 短くなる（${full.length}→${ack.text.length}字）`, ack.text.length < full.length * 0.5);
t("ack: フェーズの禁止ルールは残す", /【🚫 proposing フェーズ 絶対禁止ルール】/.test(ack.text));
t("ack: ラダーは落とす", !/パターン判定ラダー/.test(ack.text));
const cond = phaseGuideForScene("proposing", full, "conditions");
t(`conditions: I・C1 を含む（${cond.kept?.join(",")}）`, !!cond.kept && cond.kept.includes("I") && cond.kept.includes("C1") && cond.kept.includes("I-拡大"));
const other = phaseGuideForScene("proposing", full, "other");
t("other: 元のまま", other.text === full && other.kept === null);
t("hearing: 元のまま", phaseGuideForScene("hearing", PHASE_GUIDE.hearing, "ack").text === PHASE_GUIDE.hearing);
t("off: 元のまま", phaseGuideForScene("proposing", full, "ack", false).text === full);
// 全部の場面でパターンの名前が PHASE_GUIDE に見つかる（名前の打ち間違いで黙って落ちない）
for (const s of ["ack", "considering", "question", "conditions", "property_share", "cost", "viewing", "apply"] as const) {
  const r = phaseGuideForScene("proposing", full, s);
  t(`${s}: パターンが見つかる（${r.kept?.length ?? 0}）`, (r.kept?.length ?? 0) >= 3);
}

// ナレッジの事例の節を落とす
{
  const k = "\n\n【スモラの営業パターン・原則】\n1. はい😊\n\n【💡 類似ケース（申込に至った実例パターン）】\n1. [申込ケース] {\n  \"a\": 1\n}\n【🏠 内見成功パターン】\n1. x\n【🚫 避けるべき対応（失注実例より）】\n1. y";
  const s = stripKnowledgeSections(k, ["【💡 類似ケース", "【🏠 内見成功パターン"]);
  t("事例の節だけ落ちる", s.includes("営業パターン") && s.includes("避けるべき対応") && !s.includes("申込ケース") && !s.includes("内見成功"));
  t("無ければ元のまま", stripKnowledgeSections("abc", ["【💡"]) === "abc");
}
// 材料の取捨
t("ack は事例を入れない・ナレッジは入れる（v2）", !keepMaterial("ack", "caseStudies") && keepMaterial("ack", "knowledge"));
t("conditions は conditionChange を入れる", keepMaterial("conditions", "conditionChange"));
t("other は全部入れる", keepMaterial("other", "knowledge") && keepMaterial("other", "phrases"));
t("off なら全部入れる", keepMaterial("ack", "knowledge", false));
t("env off", !sceneMaterialsEnabled({ REPLY_SCENE_MATERIALS: "off" }));
t("テストの on は env off に勝つ", sceneMaterialsEnabled({ REPLY_SCENE_MATERIALS: "off" }, "on"));

// 3巡目（10/07）検討中の決まりを1か所に: 避ける話題は催促だけに置き換え・扉の1文は但し書きで許す
{
  const out = consideringAvoidTopics(["申込誘導", "希少性煽り", "内見誘導", "物件追加提案"]);
  t("検討中の避ける話題: 申込誘導→申込の催促・内見誘導→内覧の日程の打診", out.includes(CONSIDERING_AVOID_PUSH) && !out.includes("申込誘導") && !out.includes("内見誘導") && out.includes("希少性煽り"));
  t("検討中の避ける話題: off の時は元のまま", consideringAvoidTopics(["申込誘導"], false)[0] === "申込誘導");
  t("扉の1文の但し書きに竹内さんの許可の形", /お申込みでお部屋抑え/.test(CONSIDERING_DOOR_EXEMPT_NOTE) && /当たらない/.test(CONSIDERING_DOOR_EXEMPT_NOTE));
}
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);

// 7巡目（10/07）: 場面の語の抜け（見張りの外れ W34・W45・W56・W35／365日の発言で変わる 11番を全部読んだ・scripts/audit-r7-scene-words.ts）
console.log("7巡目: 場面の語の抜け");
for (const [s, want] of [
  ["お世話になっております！\nこちらこそ本日よろしくお願いいたします🙇‍♀️\n申し訳ございません💦\nギリギリに着くか少し遅れるかもです😭", "viewing"],
  ["かしこまりました。\n付き添いで1人着いてきます", "viewing"],
  ["もうすぐ着きます！すみません🙇‍♀️", "viewing"],
  ["お願いします！\n数分遅れるかもですすみません💦", "viewing"],
  ["ここと、\nここの頭金おしえてほしいです", "cost"],
  ["今日中に決めて折り返します！", "considering"],
  ["息子に確認の連絡を入れますので夕方くらいになると思いますが折り返しの連絡をさせて頂きます。", "considering"],
  // 書類の話の「ギリギリ間に合いませんでした」は内覧ではない
  ["出来る限り、頑張ります！\nギリギリ間に合いませんでした", "other"],
] as Array<[string, string]>) t(`${s.slice(0, 24)} → ${want}`, sc(s) === want);
process.env.REPLY_SCENE_R7 = "off";
t("REPLY_SCENE_R7=off で前の判定（頭金 → other）", sc("ここと、\nここの頭金おしえてほしいです") === "other");
delete process.env.REPLY_SCENE_R7;
console.log(`\n7巡目の追加まで ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;

// 7巡目: 内覧当日の連絡（isViewingDayNotice・人 13/23 が2行の形・scripts/audit-r7-viewing-day-notice.ts）
import("../reply-subscene").then(({ isViewingDayNotice, isPropertyShareNoAsk }) => {
  t("遅れの連絡 → 当日の連絡", isViewingDayNotice("お願いします！\n数分遅れるかもですすみません💦"));
  t("付き添い → 当日の連絡", isViewingDayNotice("かしこまりました。\n付き添いで1人着いてきます"));
  t("「30分遅れそうですがいけますか」は問い → 当てない", !isViewingDayNotice("少し到着遅れそうで30分ぐらいになりそうなんですけどいけますか。"));
  t("返信の遅れのお詫び → 当てない", !isViewingDayNotice("返信遅くなってしまい申し訳ありません🙇‍♀️他社にも相談していたのですがスモラさんで契約させていただこうと思います、遅れてすみません"));
  t("URL だけ → 物件を送っただけ", isPropertyShareNoAsk("キャナルコート神田 5階\nhttps://suumo.jp/chintai/bc_100527822742/\nby SUUMO"));
  t("URL＋初期費用の問い → 送っただけではない", !isPropertyShareNoAsk("ここの初期費用いくらですか？\nhttps://suumo.jp/chintai/bc_100527713926/"));
  console.log(`\n7巡目の小場面まで ${pass} passed, ${fail} failed`); if (fail) process.exitCode = 1;
});
import("../reply-subscene").then(({ isPropertyShareNoAsk }) => {
  t("懸念＋URL（カードブラック）→ 送っただけではない", !isPropertyShareNoAsk("カードブラックなので…厳しいかと💦\nhttps://www.homes.co.jp/chintai/room/ac5b2014e06f3d0a9a8055d957f39c140d33d703/"));
  t("物件名＋URL＋by SUUMO → 送っただけ", isPropertyShareNoAsk("田辺５丁目貸家 1階\nhttps://suumo.jp/chintai/bc_100526949079/\nby SUUMO"));
  console.log(`\n7巡目（懸念つき）まで ${pass} passed, ${fail} failed`); if (fail) process.exitCode = 1;
});
