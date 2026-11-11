// app/lib/__tests__/self-name-mask.test.ts — お客様が名乗った本名を伏せる（npx tsx で回す）。名前は作り物、他は実物の言い回し
import { maskSelfIntroducedNames as m, hasSelfIntroducedName, selfIntroducedNames, maskSelfNamesPair } from "../self-name-mask";
let pass = 0, fail = 0;
const t = (n: string, got: string, want: string) => { if (got === want) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(got)}（期待 ${JSON.stringify(want)}）`); } };
const keep = (n: string, s: string) => t(n, m(s), s);

// 伏せる
t("姓名です！（23d3865f の形）", m("山田花です！"), "YUMAです！");
t("姓 名です、よろしく", m("山田 花子です、よろしくお願いします"), "YUMAです、よろしくお願いします");
t("と申します", m("こんにちは\n田中と申します。\nこの物件について見積もりをお願いしたく"), "こんにちは\nYUMAと申します。\nこの物件について見積もりをお願いしたく");
t("はじめまして〇〇と申します", m("はじめまして、佐藤太郎と申します！"), "はじめまして、YUMAと申します！");
t("名前は〇〇", m("名前は鈴木一郎です"), "名前はYUMAです");
t("氏名：〇〇", m("氏名：高橋 美咲"), "氏名：YUMA");
t("私は〇〇です", m("私は中村です！よろしくお願いします🙇"), "私はYUMAです！よろしくお願いします🙇");
t("かなの名前は合図がある時だけ", m("はじめまして、さくらです！"), "はじめまして、YUMAです！");
t("英字の名前", m("Hana Yamadaです"), "YUMAです");
t("といいます", m("木村といいます"), "YUMAといいます");
t("監査で見つける", String(hasSelfIntroducedName("山田花です！")), "true");

// 伏せない（実物の言い回し）
keep("大丈夫です", "大丈夫です！");
keep("了解です", "了解です😊");
keep("学生です", "学生です！");
keep("10／1希望です", "10／1希望です。");
keep("駅です", "梅田です！");
keep("区です", "生野区です");
keep("物件名（カタカナ）です", "サンメゾンです！");
keep("かなの言葉", "楽しみです！");
keep("かなだけで合図なし", "さくらです");
keep("長い文の中のです", "今週末 外観、駅など 見に行ってきます。 初期費用 だいぶ魅力ですね。");
keep("物件の質問", "13階は何人待ちですか？");
keep("お願いします", "お願いします🤭");
keep("一人です", "一人です");
keep("夜職です", "今学生で、夜職してるんですけどその場合、私個人で契約ってできますかね🥹");
keep("会社名", "連産業株式会社です");
keep("YUMA はそのまま", "YUMAです！");
keep("条件の行", "⑤ご希望エリア・最寄り駅心斎橋付近");

keep("r1 の監査: 助詞の入る言葉", "審査は不安です");
keep("r1 の監査: 追記です", "追記です🙇‍♀️");
keep("r1 の監査: 大丈夫です", "駐車場はなくても大丈夫です！");
keep("r1 の監査: 良いです", "安くて出来たらキッチン広めが良いです！");
t("名乗った名前を取り出す", selfIntroducedNames("こんにちは\n山田 花子です、よろしくお願いします").join(","), "山田 花子,山田花子,山田,花子");
t("こちらの文からも伏せる", JSON.stringify(maskSelfNamesPair("山田花です！", "山田花さんお客様追加頂き有難うございます！！")), JSON.stringify({ customer: "YUMAです！", staff: "YUMAさんお客様追加頂き有難うございます！！" }));
t("止める SELF_NAME_MASK=off", maskSelfNamesPair("山田花です！", "x", { SELF_NAME_MASK: "off" }).customer ?? "", "山田花です！");
t("名乗りが無ければ何もしない", JSON.stringify(maskSelfNamesPair("大丈夫です！", "梅田のお部屋")), JSON.stringify({ customer: "大丈夫です！", staff: "梅田のお部屋" }));
t("括弧の中の読み・別名（監査で1行）", m("お問い合わせいただきました、YUMA（リー・ウェイ）と申します"), "お問い合わせいただきました、YUMA（YUMA）と申します");
t("名前と括弧の両方", m("山田（ヤマダ）と申します"), "YUMA（YUMA）と申します");
keep("括弧の後が名乗りでない", "スプランディッド（7階）が気になります");
console.log(`self-name-mask: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
