// app/lib/__tests__/condition-source-gate.test.ts
// 2026-09-30 竹内（黒明様の事例）「エリアに『4階のお部屋・11階のお部屋』が入っている。SUUMO でこの物件空いてるかって送られてきた物件で、
//   お客さんが希望している条件でない。西中島南方も希望の条件じゃない」の回帰テスト。
// 本物のお客様の発言（180日の実物）をそのまま使う。混入の例と、誤って止めてはいけない本物の条件の例の両方。
// 実行: npx tsx app/lib/__tests__/condition-source-gate.test.ts
import { classifyConditionTurn, gateExtractedConditions, decideAreaMode, classifyImageTranscript, isApplyPaperText, inquiryShapesOf, mergeAreaForBrainBridge } from "../condition-source-gate";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const SEP = "\n⁣\n";

console.log("── 黒明様（今回の実物）");
{
  // 9/23 13:49（こちらが送った Luxe難波WEST 403・1104号室の話）
  const msg = "4階のお部屋は11月初旬で入居出来るなら良かったのですが、、\n11階の方を抑えつつ、新着でオススメ物件あればご連絡いただきたいです🙇‍♂️";
  const turn = classifyConditionTurn(msg);
  t("物件の問い合わせ（条件の部分なし）", turn.kind === "property_inquiry" && turn.conditionText === "", JSON.stringify(turn));
  // 当時 P4 が読んだ値をそのまま出口の手前に当てる（入口で止まるが、他の経路で来ても落ちる）
  const g = gateExtractedConditions({ desired_area: "4階のお部屋・11階のお部屋", move_in_time: "11月初旬", other_requests: "11階の方を抑えつつ、新着でオススメ物件があればご連絡いただきたい" }, turn,
    { desired_area: "大阪市西区　大阪市浪速区", other_requests: "共益費込み、できれば60000円程度" });
  t("希望エリアに「4階のお部屋・11階のお部屋」を足さない", g.extracted.desired_area === undefined, JSON.stringify(g.extracted));
  t("入居時期「11月初旬」を書かない（403号室の仮の話）", g.extracted.move_in_time === undefined, JSON.stringify(g.extracted));
  t("その他に「抑えつつ」「新着でご連絡」を書かない", g.extracted.other_requests === undefined, JSON.stringify(g.extracted));

  // 9/24 01:27 スタッフの【ご転職先情報】の書式の貼り返し
  const paper = "また、今回お引越し理由ですが転職となりますでしょうか！転職の場合転職先のご情報お送りの程お願い致します！！\n\n【ご転職先情報】\n・勤務先名 株式会社〇〇\n・勤務先所在地 西中島南方駅最寄り\n・勤続年数 0年\n・年収 0\n・雇用形態（正社員等）正社員\n・勤務先電話番号 \n・保険種類 （社会保険） 社会保険";
  t("転職先の書式は申込・審査の書類", classifyConditionTurn(paper).kind === "apply_form");
  t("書類から西中島南方を足さない", classifyConditionTurn(paper).conditionText === "");

  // 9/22 お客様が送った SUUMO のスクショ（Vision の書き起こし）
  const img1 = "[画像] 物件情報\n\n阿波座 1K 5階\n\n1/20\n\n無料 お問い合わせ\n無料 内見予約\n気になる物件がなくなる前に！\n\n無料 空室状況を問い合わせ\n無料 入居可能時期を問い合わせ\n\n5.9万円/管理費 10000円\n\n間取り: 1K\n広さ: 24.04㎡\n\n築年数: 築14年\n築年月: 2012年12月";
  t("SUUMO の物件ページのスクショは物件の問い合わせ", classifyConditionTurn(img1).kind === "image_property", classifyConditionTurn(img1).kind);
  const img2 = "[画像] 17:49\n\n物件情報\n\n所在地：大阪府大阪市北区茶屋町 8-4 CSTBLD.1階\n\n取引態様：仲介\n\n電話で問い合わせ\n\nSUUMO物件コード：1***\n取り扱い店舗物件コード：8631724";
  t("SUUMO の店舗情報のスクショも物件（北区を足さない）", classifyConditionTurn(img2).conditionText === "");
  t("連投（文＋スクショ）: 文の「このふたつの物件お調べいただきたい」も物件の話",
    classifyConditionTurn(["最後にこのふたつの物件お調べいただきたいです🙇‍♂️\n物件名が分からないのですが、ここの条件次第でご提示いただいた物件するか考えたいです！", img1].join(SEP)).conditionText === "");
}

console.log("── 物件の問い合わせ（実物・条件の欄に書かない）");
{
  const cases: Array<[string, string]> = [
    ["SUUMO の共有（題に駅・間取り・階）", "十三 1LDK 5階 https://suumo.jp/chintai/bc_100000000/ by SUUMO"],
    ["ニフティの共有（5サイト外）", "ＪＲ東西線 海老江 徒歩5分\n1R 5.7万円\n[詳細]\nhttps://myhome.nifty.com/smp/rent/osaka/osakashifukushimaku/suumof_1/\n\nニフティ不動産アプリ版はこちら\nhttps://myhome.nifty.com/apps/"],
    ["賃貸EX の共有（share.google）", "【空室あり!】-パティオライブ ・1K(布忍駅 / 松原市東新町)の賃貸マンション|賃貸EX https://share.google/4Lb2FKIrsN3nDJ7GB"],
    ["物件情報の貼り付け", "物件名:大阪市旭区 太子橋1丁目 (太子橋今市駅 ) 2階 1LDK 物件種目:賃貸アパート 価格:8.2万円 交通:地下鉄谷町線 / 太子橋今市駅 徒歩5分"],
    ["建物名＋部屋番号・見積", "メゾンボヌール203\n見積書\n10/1入居で仲介手数料賃料の半額免除でお願いします！"],
    ["建物名の11階の部屋", "アーバネックス京町堀の11階の部屋でもいいなと考えてます！"],
    ["1階のお部屋（特定の建物）", "1階のお部屋8月くらいに出てないですかね？"],
    ["一階のお部屋も", "一度、一階のお部屋もお願いしたいです！"],
    ["号室の質問", "お調べいただきありがとうございます！\n初期費用の概算もありがとうございます🙇🏻‍♀️\nちなみに、306号室は角部屋でししょうか…？"],
    ["募集出てない？", "BRAVE北新町、常盤町は募集出てないんですか？"],
    ["マンションの空き", "また、大国町駅付近にある、ララプレイス難波シエールというマンションの空きがあるようなんですが、何階の空きがあるか等わかりますでしょうか？"],
    ["内見の時間（夕方あたり）", "すみません、11時以外も空いていますか？\n夕方あたりだと助かるのですが…"],
    ["この物件の初期費用", "ここの物件だと初期費用いくらくらいでしょうか？"],
    ["抑えて", "こちらの物件、念の為抑えていただく事可能でしょうか？🙇‍♂️"],
    ["建物名で決める", "カシータで決めようと思っています。\n10月にもらえる給料でその日お支払いになるので最短10月9日になると思います。。"],
    ["LIFULL の共有", "【賃貸マンション】 Osaka Metro御堂筋線 西中島南方駅 徒歩6分 https://www.homes.co.jp/chintai/room/0000/ by LIFULL HOME'S"],
    ["家賃の交渉（この物件の続き）", "6/6に入居したいです。\n見積書のお値引きの件ですが、センチュリーの物件の時には3万円までお値引きしていただきました。\nこちらの物件につきましても、2万円まで値引き、いただくことは可能でしょうか？"],
  ];
  for (const [name, text] of cases) {
    const turn = classifyConditionTurn(text);
    t(`${name} → 条件の部分なし`, turn.conditionText === "", `${turn.kind} / ${turn.conditionText}`);
  }
}

console.log("── 同居（物件の話＋条件）→ 条件の節だけ残す");
{
  const a = classifyConditionTurn("こちらの物件の空き状況と\n桜川、九条エリアでおすすめの物件がございましたらお送り頂けますでしょうか？\nお手数ばかりおかけしてしまい申し訳ございませんがよろしくお願いいたします……");
  t("桜川・九条エリアは残す", a.kind === "mixed" && a.conditionText.includes("桜川") && a.conditionText.includes("九条エリア"), JSON.stringify(a));
  t("「こちらの物件の空き状況」は落とす", !a.conditionText.includes("空き状況"));
  const b = classifyConditionTurn("ありがとうございます！\nこの物件だと初期費用はどのくらいでしょうか？\n\nあと、本当に申し訳ないんですが、近大周辺でも同じ条件で探して欲しいです。。\nペット2匹で、、、");
  t("近大周辺・ペット2匹は残す", b.conditionText.includes("近大周辺") && b.conditionText.includes("ペット2匹"), JSON.stringify(b));
  t("「この物件だと初期費用」は落とす", !b.conditionText.includes("初期費用はどのくらい"));
  const c = classifyConditionTurn("でさやねぇ\nメロディハイムはかなりの好条件ですまんねぇ\nそれを踏まえて今日、403で内覧し実際の203の位置を確認して\n問題なければ、先行申込しようと考えてたのですが\n実際の私の活動範囲を考えると、北区、福島区、西区でも阿波座、江戸堀がいいかなぁとも思いますし");
  t("活動範囲（北区・福島区・阿波座・江戸堀）は残す", c.conditionText.includes("北区") && c.conditionText.includes("江戸堀"), JSON.stringify(c));
  t("メロディハイム・403で内覧・先行申込は落とす", !c.conditionText.includes("メロディハイム") && !c.conditionText.includes("403") && !c.conditionText.includes("先行申込"), c.conditionText);
  const d = classifyConditionTurn("ご回答いただき、ありがとうございます。\nもし、物件をお持ちであれば、御堂筋線が西中島南方から江坂。JRであれば、新大阪から東淀川、JR淡路近辺で更にご紹介いただければと思います。（勤務先が新大阪駅の南側なので）ご紹介方法は、先の物件と同じ方法でお願いします。\n日程が合えば、集中内見をしたいと思っています。\nよろしくお願いします。");
  t("駅を並べた紹介の依頼は残す（西中島南方〜江坂・新大阪〜東淀川・淡路）", d.conditionText.includes("西中島南方から江坂") && d.conditionText.includes("JR淡路近辺"), JSON.stringify(d));
  t("「集中内見をしたい」は落とす", !d.conditionText.includes("集中内見"));
}

console.log("── 本物の条件（止めてはいけない側・実物）");
{
  const cases: Array<[string, string, string[]]> = [
    ["7畳以上・二階以上", "大国町、桜川で7畳以上、二階以上エレベーター付、なるべく家賃安めでお願いしたいです！", ["大国町", "二階以上"]],
    ["駅徒歩（URL なし）", "駅徒歩3分〜5分とかで", ["駅徒歩3分"]],
    ["物件ありますか（この物件ではない）", "大阪市内でペット可2LDK駅徒歩10分程度\n家賃17万前後で初期費用安い物件ありますか？？", ["大阪市内", "家賃17万"]],
    ["この部屋の広さで（物件を物差しにした条件）", "ご連絡失礼します。\nこの部屋の広さで南向き2階以上キッチン広め\n家賃10万ぐらいで堀江阿波座(中央区)辺りでないでしょうか？😭", ["南向き2階以上", "堀江阿波座"]],
    ["家賃を上げて・他の部屋も", "もう少し家賃あげて、他の部屋もいただけたら、ありがたいです!", ["家賃あげて"]],
    ["家賃を上げて・新大阪、東三国", "もう少し家賃上げて良いので、\n新大阪、東三国でありそうですか？😭😭", ["新大阪、東三国"]],
    ["大国町エリアで7畳以上", "何回も送ってきてもらってるのにすみません🥲\n大国町エリアで1Kでできたら7畳以上の部屋で探してます🙇🏻‍♀️🙇🏻‍♀️\nよろしくお願いします", ["大国町エリア", "7畳以上"]],
    ["エリアを変えて", "先日PDF頂きありがとうございました。\n\nエリアを変えて再度お願いしたいのですが、東三国、江坂エリアで同じような条件にて物件しょうかいはかのうでしょうか", ["東三国", "江坂エリア"]],
    ["周辺でも探して", "伏見駅と竹田駅周辺でも探していただきたいです🙇‍♀️", ["伏見駅"]],
    ["2階以上がいい", "梅田まで30分以内で、家賃7万くらいまでの1Kか1DK探してます！2階以上がいいです", ["梅田まで30分", "2階以上"]],
    ["1階以外（箇条）", "家賃 120,000まで\n鉄筋or鉄骨\n1階以外\nガス火\n広ければ1LDKでもOK (2LDKはそんなに望んでない)\n風呂トイレ別 独立洗面台\nオートロック\nできれば宅配ボックスあり", ["1階以外", "オートロック"]],
    ["この条件で物件探して", "石橋阪大前　　徒歩10〜15分\n　　　　　　　家賃7万以内\n　　　　　　　1階以外\nこの条件で物件探して欲しいです。", ["石橋阪大前", "1階以外"]],
    ["似た条件で他も（物件を物差し）", "こちらの物件築年数だったり、広さ家賃かなり理想的なのですが、似た条件で他も御座いましたら、紹介して頂きたいです！\n初期費用なるべく抑えでありましたら🥹", ["似た条件", "初期費用なるべく抑え"]],
    ["ミナミ周辺で", "返信遅れてすいません\n考えて、もう少し家賃が低いところが良いので、ミナミ周辺で、築年数は少したってても良いので初期費用安いマンション探していただきたいです🙇‍♀️", ["ミナミ周辺"]],
    ["1階の物件希望（条件フォームの中）", "8【その他ご要望あれば】⇒ 1階の物件希望、保証人不要(保証会社だけでいい)、バストイレ別", ["1階の物件希望"]],
    ["11階以上がいい", "11階以上がいいです", ["11階以上"]],
    ["エリアを広げたい", "エリアを西中島南方にも広げたいです", ["西中島南方"]],
    ["勤務先の近く（書類ではない）", "転職先の勤務先が梅田なので梅田周辺で探したいです", ["梅田周辺"]],
    // 全件監査（B・D）で見つけた誤り: 費用の「抑えたい」はお部屋の仮押さえではない
    ["家賃を抑えたい（旭区周辺）", "旭区周辺で家賃もう少し抑えたいです。\n区が変わっても構いません。", ["旭区周辺", "家賃もう少し抑えたい"]],
    ["管理費込みで抑えたい", "管理費込みで5.5万くらいで抑えたいです😢", ["5.5万くらいで抑えたい"]],
    ["初期費用を抑えたい・帰国の時期", "よろしくお願いします\n初期費用を抑えたいです\n今海外にて10月頭に日本に帰ります", ["初期費用を抑えたい", "10月頭"]],
    ["初期費用が抑えれる物件（加美駅付近以外）", "平野区加美駅付近以外で大阪市内で松本マンションのような初期費用が抑えれる物件があったら教えてほしいです。\n間に合えば内見予定の9/9に行きたいです。", ["加美駅付近以外で大阪市内"]],
    ["この部屋みたいに（物件を物差し）", "5帖の部屋にエアコンないのが気になって、\nこの部屋みたいに、2つの部屋ができるだけくっついていなくて、北は中崎町〜南は恵比須町くらいまでで10万円くらいの1LDKあったりしますか??", ["中崎町", "10万円くらいの1LDK"]],
    ["URL＋条件の文（平仮名の文）", "https://suumo.jp/chintai/jnc_000000000/\n離婚するので出来たら安めのとこでペット可があれば嬉しいです", ["ペット可"]],
  ];
  for (const [name, text, must] of cases) {
    const turn = classifyConditionTurn(text);
    t(`${name} → 残す`, must.every((m) => turn.conditionText.includes(m)), `${turn.kind} / ${JSON.stringify(turn.conditionText)} / dropped=${JSON.stringify(turn.dropped)}`);
  }
  const form = "【お部屋お探し中！】\n\n（ご希望のお部屋探しご条件）\n①【ご入居の時期】⇒10月頃\n②【ご希望の家賃（◯万円〜◯万円）】⇒~9万以下\n③【希望の広さ・間取り】⇒1LDK\n⑤【ご希望のエリア・駅名】⇒福島、野田\n⑧【その他ご要望あれば】⇒2階以上、内見は土日希望";
  const ft = classifyConditionTurn(form);
  t("うちのフォーマットはそのまま条件（中の「内見」で落とさない）", ft.kind === "condition_form" && ft.conditionText.includes("内見は土日希望"), ft.kind);
}

console.log("── 自前の条件の一覧（確かめで見つけた誤って止める側・180日の実物・個人の情報は伏せた）");
{
  // c20d02f3（9/18 最初の条件）: 旧版は「間取り:1LDK」を物件の形と読み、印の無い行（入居・ペット・保証人なし・独立洗面台…）を物件の話の続きとして落とした
  const a = "エリア:平野区(または平野区の周りの市内側)\n生野や、東住吉などなど\n (マンション.ハイツ)\n事故物件❌\n独立系保証会社か大東建託で\n家賃:8〜10万以下(共益費込み)\n初期費用30万まで\n仕事が夜職で源泉や給料明細が出せなくて\nその面、相談したいです。\n間取り:1LDK\n入居希望日:10月1日\n・人数:私と赤ちゃんとペット1匹\n    豆柴(4ヶ月)成犬体重5キロ\n・保証人なし\n・子供可\n・ペット犬OK\n・エアコン付き(リビングに最低1台)\n・2階以上はエレベーター必須\n・トイレ風呂別\n・独立洗面台\n・カウンターキッチン\n・室内洗濯機置場\n・浴室乾燥機";
  const ta = classifyConditionTurn(a);
  t("自前の一覧は丸ごと条件（1LDK・入居・ペット・独立洗面台が残る）", ta.kind === "condition_form" && ["1LDK", "10月1日", "ペット犬OK", "独立洗面台", "保証人なし"].every((w) => ta.conditionText.includes(w)), JSON.stringify(ta));
  // 3207c765（7/29）: 「・内覧に関して」の行で通が物件の話と読まれ、家賃・初期費用・ペット可を落とした
  const b = "お世話になります\n改めて、下記の感じで候補あればお願い致します。\n\n・名前　〇〇\n・電話　＊＊＊\n・希望エリア　大阪市内(とりあえず…北区、都島区、旭区、城東区、鶴見区、住吉区、東住吉区、くらいで)\n・希望　1LDK, 2DK, 2LDK、… 希望金額内なら良い\n・家賃　¥60,000代(管理費込)\n・敷金礼金無し　初期費用は抑えたい\n・内覧に関して\n希望に合った物件が見つかり次第\n・入居希望時期\n年内中 (12月初旬までには決めたい)\n・その他\nペット可\n上層階エレベーター希望";
  const tb = classifyConditionTurn(b);
  t("「・内覧に関して」のある一覧も条件（家賃・初期費用・ペット可が残る）", ["60,000", "初期費用は抑えたい", "ペット可"].every((w) => tb.conditionText.includes(w)), JSON.stringify(tb));
  // b58d24e3（5/25）: 「間取り：2LDK以上」「築年数：…問わない」を物件の形として落とした
  const c = "賃料：8万円以下\n初期費用目安：15万円以下\n間取り：2LDK以上\n築年数：中が綺麗だったら築年数は問わない（リノベ済みなど）\nエリア：守口市、門真市、大東市、寝屋川市\n条件：バス・トイレ別・独立洗面台あり・ペット相談できる・室内洗濯機置場";
  t("「間取り：2LDK以上」「築年数：」の一覧は条件", ["2LDK以上", "築年数"].every((w) => classifyConditionTurn(c).conditionText.includes(w)));
  // 656d8f5e（8/14 最初の条件）: 自己紹介（名前・現住所・勤務先）＋番号の条件の一覧を申込の書類と読み、丸ごと落とした
  const d = "名前:〇〇、〇〇\n年齢:23、24\n現住所:大阪府東大阪市〇〇\n勤務先:〇〇、〇〇へ転職\n\n①入居希望日:9/21-10/20\n②希望の家賃帯:共益費込みで11万以下\n③希望の場所・地域・最寄駅等:阪和線　南田辺〜三国ヶ丘、南海高野線　住吉東〜三国ヶ丘\n④希望駅徒歩分数:１０分以内\n⑤希望の広さ（㎡）(間取り):45㎡以上　1LDKでも良い\n⑥初期費用の限度額:40万以内\n⑦希望築年数:こだわりなし\n⑧駐車場・駐輪場の有無:どちらも有\n⑨宅配ボックス:あれば嬉しい\n⑩その他ご要望があれば:エアコン付き、ペット相談可";
  t("自己紹介＋条件の一覧は書類ではない", !isApplyPaperText(d) && classifyConditionTurn(d).kind === "condition_form");
  // 申込の書式（記入欄）は今まで通り書類
  t("【お申込者様記入欄】は書類のまま", classifyConditionTurn("【お申込者様記入欄】\n・入居希望日 10/1\n・氏名、フリガナ 〇〇\n・生年月日 〇〇\n・現住所 〇〇\n・勤務先名 〇〇\n・勤務先所在地 〇〇\n・駐輪場利用の有無 なし\n・ペット なし").kind === "apply_form");
  // 物件の資料の文字（賃料:・管理費等:・間取り:）は一覧にしない
  t("物件の資料の文字は条件の一覧ではない", classifyConditionTurn("【シャトードルチェII】\n賃料:8.9万円\n管理費等:9,000円\n建物階:2階(10階建)\n間取り:1LDK\n専有面積:40㎡").conditionText === "");
  // 1422c7da（8/26）: 「保証人不要で申し込み可能な物件を優先して」は条件（1件の物件の申込ではない）
  t("「申し込み可能な物件を優先」は条件", classifyConditionTurn("そのため、保証会社の審査や入居審査について比較的相談しやすく、保証人不要で申し込み可能な物件を優先してご紹介いただけると助かります。").conditionText.includes("保証人不要"));
}

console.log("── 出口の手前の関所（新しく足す値だけ見る）");
{
  const turn = classifyConditionTurn("エリアを西中島南方にも広げたいです");
  const g = gateExtractedConditions({ desired_area: "大阪市西区・大阪市浪速区・西中島南方" }, turn, { desired_area: "大阪市西区・大阪市浪速区" });
  t("本物の言い直しは足す（既存の区は残す）", g.extracted.desired_area === "大阪市西区・大阪市浪速区・西中島南方", JSON.stringify(g));
  const g2 = gateExtractedConditions({ desired_area: "難波" }, classifyConditionTurn("なんば周辺で探してください"), null);
  t("駅名の言い換え（なんば→難波）は根拠あり", g2.extracted.desired_area === "難波", JSON.stringify(g2));
  const g3 = gateExtractedConditions({ desired_area: "今宮" }, classifyConditionTurn("家賃もう少し上げてください"), { desired_area: "大国町" });
  t("発言に無い駅（前に送った物件の駅）は足さない", g3.extracted.desired_area === undefined, JSON.stringify(g3));
  const g4 = gateExtractedConditions({ other_requests: "2LDKの候補を多めに欲しい・306号室が角部屋かどうか確認したい" }, classifyConditionTurn("2LDKの候補を多めに欲しいです。306号室は角部屋ですか？"), null);
  t("その他: 号室の節だけ落とす", g4.extracted.other_requests === "2LDKの候補を多めに欲しい", JSON.stringify(g4));
  // 掃除の表を作る時の目視で見つけた誤り（今ある「その他」の実物）: 目的語の無い「抑えたい」・条件の依頼は落とさない
  for (const cl of ["出来るだけ抑えたい、エアコン完備", "敷礼なしで抑えたい。ネット無料、保証人不要、2階以上、バストイレ別、温水洗浄便座", "防音の部屋またはタワマンの低層階があれば教えていただきたい", "条件的に厳しい場合は、いずれか一つ条件を変えた場合に良い物件があれば教えてほしい"]) {
    const gg = gateExtractedConditions({ other_requests: cl }, classifyConditionTurn(cl), null);
    t(`その他の実物を落とさない:「${cl.slice(0, 20)}…」`, gg.extracted.other_requests === cl, JSON.stringify(gg.dropped));
  }
  const g5 = gateExtractedConditions({ rent_max: 75000 }, classifyConditionTurn("家賃7.5万までにしてください"), { rent_max: 70000 });
  t("家賃の言い直しは通す", g5.extracted.rent_max === 75000, JSON.stringify(g5));
  const mixed = classifyConditionTurn("こちらの物件家賃6.5万ですが空いてますか？\n西区でも探してください");
  const g6 = gateExtractedConditions({ rent_max: 65000, desired_area: "西区" }, mixed, { desired_area: "浪速区" });
  t("物件の家賃（6.5万）は条件の上限にしない", g6.extracted.rent_max === undefined, JSON.stringify(g6));
  t("同じ連投の「西区でも」は足す", g6.extracted.desired_area === "西区", JSON.stringify(g6));
  // 確かめ（2026-09-30）: LLM が今の語を言い換えて丸ごと返した時（「大阪市北区」→「北区」）に今の語を落とすと、
  //   丸ごと書く経路（条件ブレイン）で登録の区が消える → 今の値に含まれる語は今ある語として残す
  const g7 = gateExtractedConditions({ desired_area: "北区・福島区・西中島南方" }, turn, { desired_area: "大阪市北区・大阪市福島区" });
  t("今の語の言い換え（北区）は落とさない", g7.extracted.desired_area === "北区・福島区・西中島南方", JSON.stringify(g7));
  const g8 = gateExtractedConditions({ other_requests: "ペット可・内見は土日希望" }, classifyConditionTurn("ペット可でお願いします"), { other_requests: "内見は土日希望、駅近" });
  t("その他: 今の値に含まれる節は区切りが違っても落とさない", g8.extracted.other_requests === "ペット可・内見は土日希望", JSON.stringify(g8));
}

console.log("── ブレインの橋（YUMA で本番の旧コードが実際に起こした上書きの再生）");
{
  // 2026-09-30 00:46 JST 本番の旧コード: 連投6通から Haiku が「西本町、西中島南方、天満橋、北浜」を読み、登録の「大阪市北区、大阪市福島区」を丸ごと上書き（履歴なし）
  const target = [
    "https://suumo.jp/chintai/bc_100432851234/ この物件空いてますか？",
    "レジデンス西本町 4階 402号室\n家賃6.8万円 1K\n阿波座駅 徒歩5分\nこちら空いてますか？",
    "4階のお部屋は11月初旬で入居出来るなら良かったのですが、、\n11階の方を抑えつつ、新着でオススメ物件あればご連絡いただきたいです🙇‍♂️",
    "エリアを西中島南方にも広げたいです",
    "11階以上がいいです",
    "こちらの物件の空き状況と\n天満橋、北浜エリアでもおすすめの物件がございましたらお送り頂けますでしょうか？",
  ].join(SEP);
  const turn = classifyConditionTurn(target);
  t("条件の部分に物件の問い合わせ（西本町・阿波座駅 徒歩5分・4階）が入らない", !/西本町|阿波座|4階のお部屋|402/.test(turn.conditionText), turn.conditionText);
  t("条件の部分に言い直し（西中島南方・11階以上・天満橋・北浜）が残る", ["西中島南方", "11階以上", "天満橋", "北浜"].every((w) => turn.conditionText.includes(w)), turn.conditionText);
  const cur = { desired_area: "大阪市北区、大阪市福島区" };
  const g = gateExtractedConditions({ desired_area: "西本町、西中島南方、天満橋、北浜" }, turn, cur);
  t("橋の関所: 西本町（物件の建物名）を落とす", !String(g.extracted.desired_area).includes("西本町"), JSON.stringify(g));
  const merged = mergeAreaForBrainBridge({ current: cur.desired_area, extracted: String(g.extracted.desired_area), conditionText: turn.conditionText, conditionChangeType: "area_change", intent: null });
  t("橋の足し方: 登録の北区・福島区を消さずに足す", merged === "大阪市北区・大阪市福島区・西中島南方・天満橋・北浜", String(merged));
  t("差し替えの言葉がある時だけ置き換える", mergeAreaForBrainBridge({ current: "大阪市北区", extracted: "天王寺", conditionText: "北区じゃなくて天王寺で", conditionChangeType: "area_change", intent: "REPLACE" }) === "天王寺");
  t("除外は書かない", mergeAreaForBrainBridge({ current: "大阪市北区・天満", extracted: "大阪市北区", conditionText: "天満は無しで", intent: "EXCLUDE" }) === null);
  // ② 単体（物件のスクショ風の文）を条件ブレインに渡した時、手元の YUMA の確認で「阿波座駅・徒歩5分」を通勤先・徒歩に書いた → 入口で止める
  t("② 物件のスクショ風の文は条件の部分なし", classifyConditionTurn("レジデンス西本町 4階 402号室\n家賃6.8万円 1K\n阿波座駅 徒歩5分\nこちら空いてますか？").conditionText === "");
}

console.log("── 画像の書き起こし");
{
  t("検索条件の画面は条件", classifyImageTranscript("検索条件\nエリア 大阪市西区 大阪市浪速区\n賃料 下限なし〜7万円\n間取り 1K 1R\nこの条件で検索") === "image_condition");
  const turn = classifyConditionTurn("[画像] 検索条件\nエリア 大阪市西区\n賃料 下限なし〜7万円\nレジデンス西本町 302号室 6.8万円/管理費5000円");
  t("条件の画面の中の物件の行は落とす", turn.conditionText.includes("大阪市西区") && !turn.conditionText.includes("302号室"), JSON.stringify(turn));
  t("本人確認書類（書き起こしなし）は条件ではない", classifyConditionTurn("[画像] 本人確認書類").conditionText === "");
  t("LINE のスクショ（会話）は条件ではない", classifyImageTranscript("17:02\nおはようございます\n了解です！") === "image_other");
  // 確かめ（2026-09-30）: athome の検索結果の一覧（「人気の設備・条件」「条件を絞り込む」のボタン付き）を条件の画面と読み、桜川・浪速区を残していた（31e93a45 の桜川の出所の形）
  const athome = "[画像] 12:34\n写真実績\n人気の設備・条件\n駐車場（近隣含む）\nバス・トイレ別\nペット相談\n2階以上\n即入居可\nおすすめコメントを見る\nサンキャドマスミナミ堀江 13階建\n大阪市浪速区幸町1丁目\n地下鉄千日前線「桜川」駅 徒歩4分\n賃貸マンション\n13階建／築23年6ヶ月\n敷/礼　なし/なし\nワンルーム／16.24㎡／部屋 1202\nLINE問合せOK\n沿線・駅を変更　条件を絞り込む\nathome.co.jp";
  const ta = classifyConditionTurn(athome);
  t("検索結果の一覧のスクショは物件（桜川を条件にしない）", ta.kind === "image_property" && ta.conditionText === "", JSON.stringify(ta));
  const g = gateExtractedConditions({ desired_area: "桜川・大阪市浪速区" }, ta, { desired_area: "大阪市西区" });
  t("一覧のスクショの駅・区は希望エリアに足さない", g.extracted.desired_area === undefined, JSON.stringify(g));
}

console.log("── 申込の書類の見分け");
{
  t("見出しが1つ（勤務先の近く）は書類ではない", !isApplyPaperText("勤務先の近くで探したいです"));
  t("行頭の見出し2つで書類", isApplyPaperText("・勤務先名 〇〇\n・勤務先所在地 大阪市北区"));
  t("「2階以上」は問い合わせの形ではない", inquiryShapesOf("2階以上がいいです").length === 0);
  t("「11階の方を抑えつつ」は問い合わせの形", inquiryShapesOf("11階の方を抑えつつ").length > 0);
}

console.log("── area_mode（cron・拡張と同じ決まり）");
{
  const stations = new Set(["西中島南方", "九条", "阿波座"]);
  const isSt = (s: string) => stations.has(s.replace(/駅$/, ""));
  t("区＋駅が混ざったら ward（区の指定を捨てない）", decideAreaMode(["大阪市西区", "大阪市浪速区", "西中島南方"], isSt) === "ward");
  t("駅だけなら station", decideAreaMode(["九条", "阿波座"], isSt) === "station");
  t("区だけなら ward", decideAreaMode(["大阪市西区"], isSt) === "ward");
  t("市内（区の指定なし）＋駅なら station", decideAreaMode(["大阪市内", "九条"], isSt) === "station");
  t("何も分からなければ auto", decideAreaMode(["ミナミ"], isSt) === "auto");
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
