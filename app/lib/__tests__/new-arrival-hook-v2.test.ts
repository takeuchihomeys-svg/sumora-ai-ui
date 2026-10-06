// app/lib/__tests__/new-arrival-hook-v2.test.ts
// 「新着1件に刺さった」の基準 v2（new-arrival-hook.newArrivalHookV2Of）の回帰テスト。実物の文（お客様の名前は伏せた）で、
//   scripts/audit-new-arrival-hook-criteria.ts で目で読んだ v1 の誤り・漏れを1つずつ固定する。
// 実行: npx tsx app/lib/__tests__/new-arrival-hook-v2.test.ts
import { newArrivalHookV2Of, newArrivalHookOf, textNamesProperty, staffIntroNames, isPlausibleStarName, ocrSameName, type HookMessageV2 } from "../new-arrival-hook";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ""}`); }
}
const T0 = Date.parse("2026-09-01T03:00:00Z");
const at = (h: number) => new Date(T0 + h * 36e5).toISOString();
const staff = (h: number, text: string, extra: Partial<HookMessageV2> = {}): HookMessageV2 => ({ sender: "staff", text, created_at: at(h), ...extra });
const cust = (h: number, text: string, extra: Partial<HookMessageV2> = {}): HookMessageV2 => ({ sender: "customer", text, created_at: at(h), ...extra });
const run = (star: string, messages: HookMessageV2[], o: Partial<Parameters<typeof newArrivalHookV2Of>[0]> = {}) =>
  newArrivalHookV2Of({ starName: star, starRoom: o.starRoom ?? null, sentAt: at(0), messages, aix: o.aix ?? [], estimates: o.estimates, viewings: o.viewings, imageNameOf: o.imageNameOf, otherNames: o.otherNames });
const starMsg = (name: string) => staff(0, `🌟${name}\n新着でかなり条件のいいお部屋となります！！敷金礼金なし`);
const newOne = staff(0.01, "新着で1件オススメできるお部屋が募集に出ましたのでお送りさせていただきました！！");

console.log("── 名前の照合 ──");
t("鍵全体", textNamesProperty("フィレンツェは初期費用おいくらぐらいでしょうか？", "フィレンツェ"));
t("英字の1字違い（LOCHAS↔LOHAS）", textNamesProperty("【LOHAS豊中稲津町 302号室】初期費用", "LOCHAS豊中稲津町"));
t("カナの1字違いは同じ物件にしない（セレーテ難波ミラク↔セレニテ難波グランデシュッド）", !textNamesProperty("物件名：セレーテ難波ミラク幸番館", "セレニテ難波グランデシュッド"));
t("略した名前＋助詞（リーゾナブルの初期費用）", textNamesProperty("クラウンハイムとリーゾナブルの初期費用欲しいです！", "リーゾナブルシティ"));
t("同じシリーズの先頭だけでは決めない（スプランディッド堀江↔本町グラン）", !textNamesProperty("【スプランディッド本町グラン 705号室】", "スプランディッド堀江", ["スプランディッド本町グラン"]));
t("画像の読み違い（グラントコート難波↔グランドコート難波）は同じ物件", ocrSameName("グラントコート難波", "グランドコート難波"));
t("同じシリーズの別の建物は画像の読み違いにしない（スプランディッド堀江↔本町）", !ocrSameName("スプランディッド堀江", "スプランディッド本町"));
t("同じシリーズでも後ろまで言えば当たる", textNamesProperty("スプランディッド堀江の見積お願いします", "スプランディッド堀江", ["スプランディッド本町グラン"]));
t("物件名でない🌟（本文の読み違い）", !isPlausibleStarName("お申込み後の流れとなります。") && !isPlausibleStarName("1件新着で隼斗さんにかなりオススメ出来るお部屋が募集に出ました！！"));
t("スタッフの文の🌟と【】から部屋の名前", JSON.stringify(staffIntroNames("🌟ECORO TOYONAKA 704\n（オススメポイント）\n【ECORO TOYONAKA 704号室】 初期費用さらに")) === JSON.stringify(["ECORO TOYONAKA", "ECORO TOYONAKA 704"]) || staffIntroNames("🌟ECORO TOYONAKA 704\n（オススメポイント）").length >= 1);

console.log("── 強い刺さり（頼んだ）──");
{
  const h = run("ペディハイツ塚口", [starMsg("ペディハイツ塚口 103号室"), cust(0.9, "少し、時間を下さい！💦 と、見積もりだしてもらえますか？")]);
  t("「見積もりだしてもらえますか」→ strong ask_estimate", h.level === "strong" && h.signals.includes("ask_estimate"), h);
}
{
  const h = run("KIIレジデンス西中島Ⅱ", [starMsg("KIIレジデンス西中島Ⅱ 202号室"), cust(1.0, "ありがとうございます。 仕事終わりみます🙇🏻‍♀️"), cust(1.8, "これだと初期費用いくらぐらいなんですか？")]);
  t("v1 の漏れ: 最初はお礼・2通目で「これだと初期費用いくら」→ strong", h.level === "strong", h);
}
{
  const h = run("サンプリエール", [starMsg("サンプリエール 501号室"), cust(10, "ご紹介ありがとうございます！ サンプリエール501号室、とても気になっています！ぜひ内見してみたいです あと少し不安な点があります")]);
  t("v1 の漏れ: 同じ文の「不安」で内見の依頼を消さない", h.level === "strong" && h.signals.includes("ask_viewing"), h);
}
{
  const h = run("ネスト谷六", [starMsg("ネスト谷六 205"), cust(0.04, "待ってください！！ここがいいです！"), staff(0.5, "かしこまりました！！ ネスト谷六205号室お申込みさせていただきます😊！！")]);
  t("スタッフが🌟の名前で「かしこまりました…お申込み」→ strong staff_apply", h.level === "strong" && h.signals.includes("staff_apply"), h);
}
{
  const h = run("LOCHAS豊中稲津町", [starMsg("LOCHAS豊中稲津町 302"), cust(0.7, "ありかどうこざいます！ ここだったら初期費用いくらでしょうか？")],
    { starRoom: "302", aix: [{ aix_type: "estimate_sheet", generated_text: "【LOHAS豊中稲津町 302号室】 初期費用さらに 🌟30,000円割引させて頂き", created_at: at(2.1) }] });
  t("見積書の AIX の綴りの揺れ（LOHAS）でも結ぶ", h.signals.includes("aix_estimate"), h);
}

console.log("── 誤り（v1 が刺さったにしていた）──");
{
  const h = run("Luxe難波南", [staff(-0.1, "ご希望のご条件に近いお部屋ピックアップさせて頂きました！！"), starMsg("Luxe難波南1308号室"), cust(6, "プレサンス心斎橋ブライト気になります！"), staff(13.8, "かしこまりました！！ プレサンス心斎橋ブライトの初期費用お見積書お送りさせていただきます😊！！")]);
  t("束の後に別の部屋の名前 → 刺さっていない", h.level === "none" && h.bundle, h);
}
{
  const h = run("シャーメゾンウエストケーブ", [starMsg("シャーメゾンウエストケーブ 201号室"), cust(1.6, "こちらの物件数日前に内覧しました😢 すみません")]);
  t("「数日前に内覧しました」（過去形）→ 断り", h.level === "none" && h.declined, h);
}
{
  const h = run("ハピネス吹田", [starMsg("ハピネス吹田 306"), newOne, cust(0.7, "とても嬉しい物件なのですが初期費用が高くて…( ; ; )")]);
  t("「初期費用が高くて」→ 見積の依頼ではなく断り", h.level === "none" && h.declined, h);
}
{
  const h = run("アトリエール堺寺地町", [starMsg("アトリエール堺寺地町 102号室"), cust(41, "ご連絡ありがとうございます！ 今回初期費用はかかりますが、他のところに決定しそうです。")]);
  t("「他のところに決定しそう」→ 刺さっていない", h.level === "none", h);
}
{
  const h = run("サザンクロス", [starMsg("サザンクロス 102"), cust(1.9, "沢山ありがとうございます🙇‍♀️ ここで決めたいです！ちなみにオンライン内見とかって難しいですよね？😢"), cust(1.91, "[画像]", { image_url: "https://x/y.jpg" }), cust(1.92, "これです！")]);
  t("直後にお客様の画像（他のサイトの画面）→ その画像の部屋の話", h.level === "none", h);
}
{
  const h = run("AUFTAKT 天王寺", [staff(-0.01, "天王寺区全域からペット飼育可能な1LDK以上のお部屋ピックアップさせていただきました😊！！"), starMsg("AUFTAKT 天王寺 304号室"), cust(0.1, "こちらがいいですねー"), staff(1.0, "かしこまりました！！ ノステルコート夕陽丘の内覧開始日と初期費用確認させていただきます😊！！")]);
  t("名前の無い返事 → スタッフの次の返事が別の部屋の名前 → 刺さっていない", h.level === "none", h);
}
{
  const h = run("フェルザ住之江公園", [starMsg("フェルザ住之江公園 505"), cust(5, "お世話になっております。 フェルザ住之江公園の内見はやはりなしで、別の2件でお願いします。")]);
  t("「〇〇の内見はやはりなしで」→ 内覧の依頼にしない", !h.signals.includes("ask_viewing"), h);
}
{
  const h = run("ライオンズマンション日本橋", [starMsg("ライオンズマンション日本橋 902号室"), newOne, cust(1.8, "ありがとうございます。 少し検討いたします。 ブラービの内覧ですが、週末が大阪にいないため22日以降でお願いします")]);
  t("一覧に無い別の部屋の名前（ブラービの内覧）→ 刺さっていない", h.level === "none", h);
}
{
  const h = run("スプランディッド堀江", [starMsg("スプランディッド堀江 1101"), cust(1.9, "ここも気になるかもです！")],
    { starRoom: "1101", aix: [{ aix_type: "estimate_sheet", generated_text: "【スプランディッド本町グラン 705号室】 初期費用さらに", created_at: at(46) }], otherNames: ["スプランディッド本町グラン"] });
  t("同じシリーズの別の建物の見積書は数えない", !h.signals.includes("aix_estimate"), h);
}
{
  const h = run("グリーンプラザ瓦町", [starMsg("グリーンプラザ瓦町 1003"), cust(2, "ありがとうございます")], { starRoom: "1003", aix: [{ aix_type: "estimate_sheet", generated_text: "【グリーンプラザ瓦町 205号室】 初期費用さらに", created_at: at(100) }] });
  t("同じ建物の別の号室の見積書は数えない", !h.signals.includes("aix_estimate"), h);
}
{
  const h = run("セレニテ難波グランデノール", [starMsg("セレニテ難波グランデノール 302号室"), staff(0.01, "【セレニテ難波グランデノール 302号室】 初期費用さらに 🌟70,000円割引させて頂き")],
    { aix: [{ aix_type: "estimate_sheet", generated_text: "【セレニテ難波グランデノール 302号室】 初期費用さらに", created_at: at(0.01) }] });
  t("新着に同封した見積書（お客様の文の前）は刺さった印にしない", h.level === "none", h);
}
{
  const h = run("お申込み後の流れとなります。", [cust(1, "内覧したいです")]);
  t("🌟の名前が物件でない記録は数えない", h.level === "none" && h.badName, h);
}

console.log("── 弱い刺さり ──");
{
  const h = run("アンプルールフェール今津", [starMsg("アンプルールフェール今津 103号室"), newOne, cust(0.7, "ここもいいですね！！")]);
  t("「ここもいいですね」だけ → weak（強い材料にはしない）", h.level === "weak", h);
}
{
  const h = run("クラウンハイム本町EAST", [starMsg("クラウンハイム本町EAST 405号室"), cust(0.4, "形があまり好きじゃないんですよね、、")]);
  t("「好きじゃない」は前向きにしない", h.level === "none", h);
}
{
  const h = run("ふぁみ～ゆ夕陽ヶ丘", [starMsg("ふぁみ～ゆ夕陽ヶ丘202号室"), cust(18.9, "おせわになっております。 すごく良い物件ですが、場所がもう少し島之内とか御堂筋と堺筋の間のほうが")]);
  t("「すごく良い物件ですが、場所がもう少し」→ 断り", h.level === "none" && h.declined, h);
}

console.log("── v1 は残す（前の版の当て直し用）──");
t("v1 の関数はそのまま", newArrivalHookOf({ starName: "サンプリエール", sentAt: at(0), messages: [cust(1, "初期費用いくらですか？")], aix: [] }).hooked);

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
