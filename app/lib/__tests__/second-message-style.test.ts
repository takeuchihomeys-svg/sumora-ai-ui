// 実行: npx tsx app/lib/__tests__/second-message-style.test.ts
// 2026-09-30 竹内「2通目に送られた AIX テンプレートの文の部分、言い回しが AI くさいから原因見つけて改善する」
//   YUMA の LINE に実際に届いた2通目（AI）と、スタッフが実際に送った2通目（実送信）の本文をそのまま使う。
import { findAiPhrases, roomOnlyMentions, ensureOneEmoji, fixMissingNi, styleStatsOf, sceneOfSecond, AI_PHRASE_RULES } from "../second-message-style";
import {
  buildSecondSceneNote, buildSecondMaterialNote, vacatingFromMaterial, secondSceneOf, leakedExampleFacts, unfoundedCostClaim,
  renderExample, SECOND_MESSAGE_EXAMPLES, type SecondMaterialRow,
} from "../second-message-scene";
import { buildAixChainNote } from "../aix-chain-note";
import { setRecommendClosing, APPLY_CLOSING_LINE } from "../recommend-cta";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, note = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${note}`); } }

// ── YUMA に届いた2通目（AI・9/30）──
const AI_208 = "YUMAさんの福島区ご希望の中でも、玉川駅徒歩4分で築浅の2023年築というのは、かなり珍しい好条件です！！\n\n独立洗面台・浴室乾燥機・インターネット無料と、毎日の暮らしで助かる設備が揃っているのも、この208号室ならではの強みです😊！！";
const AI_107 = "レオパレス天満107号室は家具付きで、お引越しの負担を抑えて始められる点が特に魅力です！！\n\n角部屋で浴室乾燥機もありますので、ご希望の北区エリアでもお値打ちな条件のお部屋となります😊！！\n\n気になる点があれば、いつでもお気軽にご連絡ください😌！！";
const AI_503 = "ご希望の福島区エリアで、福島駅徒歩4分の立地ですので、お送りした中でも特に使いやすいお部屋かと思います😊！！\n\n気になる点があれば、いつでもお気軽にご連絡ください😌！！";
const AI_505 = "YUMAさんのご希望の福島区エリアで、新福島駅徒歩3分はアクセスが良く、かなり使いやすい立地です😊！！\n\nガスコンロ可・収納しっかり・オートロックと、普段の暮らしで助かる設備が揃っているのもオススメできるポイントです！！\n\n気になる点がありましたら、いつでもお気軽にご連絡ください😌！！";
// 直す前にローカルで同じ body から出た物
const AI_LOCAL = "福島区でも玉川駅徒歩4分でこの築浅は本当に珍しく、個人的にも今回ご紹介した中で一番オススメしたいお部屋です😊！！\n\nインターネット無料で水道光熱費以外の固定費も抑えられますので、収納多めのご希望にもしっかり応えられる1件かと思います！！";

// ── スタッフが実際に送った2通目（お客様の名前だけ置き換え）──
const REAL = [
  "お送りさせて頂きましたお部屋の中でも特にLuxe難波西2 1009が芦原橋駅徒歩3分・敷金礼金なしで初期費用をかなり抑える事ができ、Aさんにかなりオススメ出来るお部屋となります！！\n\nAさんお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！",
  "お送りさせて頂きましたお部屋の中でも特にパークハイム永和105が敷金礼金なし・ペット2匹まで可・敷地内駐車場空き1台と、Aさんにかなりオススメ出来るお部屋となります！！\n\nお手隙の際にご査収ください！！",
  "お送りさせて頂きましたお部屋の中でも\nモノトーン難波1002号室礼金1ヶ月必要となりますが、Aさんに特にオススメできるお部屋となります！！\n\n独立洗面台・浴室乾燥機付きで水回りも使いやすく、日本橋駅徒歩11分の立地となります！！\n築年数も浅くロフト付きで収納力もございますので、Aさんのご希望条件にも合うお部屋かと存じます😊！！",
  "お送りさせて頂きましたお部屋の中でも特にメインステージ新大阪 602号室が築年数も新しくご希望の設備全て揃ったAさんにかなりオススメ出来るお部屋となります！！\n\n新大阪駅まで徒歩7分の駅近もかなり魅力的なお部屋となります！！\n\nAさんお気に召されたお部屋ご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！",
  "新着で1件Veena弁天402が、2025年3月築で築年数も新しく費用を抑える事ができ、Aさんにかなりオススメ出来るお部屋となります！！\n\n9月30日退去予定のため、10月1日以降ご内覧可能となります！！\n\nお手隙の際にご査収ください😊！！",
  "こちらのお部屋如何でしょうか😊！！\n2015年築家賃管理費込61,000円、Wi-Fi無料の為毎月の費用を抑える事が出来ます！！\nAさんお気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！",
  "Aさんお世話になっております！！\nかなりオススメ出来るお部屋が新着で募集に出ました！！\n敷金礼金0円の為初期費用面も抑える事が出来ます😊！！\n好条件の為すぐに募集が埋まる可能性が高いお部屋となります！",
  "Aさんお世話になっております！！\n\n新着でスプランディッド堀江1309号室が募集に出ました😊！！\n\n10月末退去予定のお部屋で敷金礼金なし・家賃管理費込188,000円の2LDKです！！\n2023年3月築の築浅で、西大橋駅徒歩6分・四ツ橋駅徒歩8分の好立地となります！！\n\nお手隙の際にご査収ください😊！！",
  // 物件確認の文（同じ建物の部屋を並べる）＝2通目の検査の外だが、号室だけの形が実送信にある事の確認用
  "レジュールアッシュ難波LUXEこちら2部屋募集されております！！\n1104号室は空室\n1504号室は6月末退居予定のお部屋となります！！",
];

console.log("\n■ findAiPhrases: YUMA に届いた AI の2通目は全部当たる");
{
  const keys = (s: string) => findAiPhrases(s).map((h) => h.key);
  t("★ 208号室の通: 強みです・ならでは・珍しい・好条件です・揃っているのも・号室だけで呼ぶ", ["強みです", "ならでは", "珍しい", "好条件です", "揃っているのも", "号室だけで呼ぶ"].every((k) => keys(AI_208).includes(k)), keys(AI_208).join(","));
  t("★ レオパレス天満の通: 魅力です・お値打ち", ["魅力です", "お値打ち"].every((k) => keys(AI_107).includes(k)), keys(AI_107).join(","));
  t("★ 福島駅の通: かと思います", keys(AI_503).includes("かと思います"), keys(AI_503).join(","));
  t("★ 新福島の通: ポイントです・助かる設備・使いやすい立地", ["ポイントです", "助かる設備", "使いやすい立地"].every((k) => keys(AI_505).includes(k)), keys(AI_505).join(","));
  t("直す前のローカルの通: 珍しく・一番オススメしたい・かと思います", ["珍しい", "個人的にも注目", "かと思います"].every((k) => keys(AI_LOCAL).includes(k)), keys(AI_LOCAL).join(","));
}

console.log("\n■ findAiPhrases: スタッフの実送信の2通目は1通も当たらない（誤って作り直しにならない）");
{
  REAL.slice(0, 8).forEach((r, i) => t(`実送信${i + 1}`, findAiPhrases(r).length === 0, JSON.stringify(findAiPhrases(r))));
  t("「好条件の為」「好立地」「魅力的なお部屋」「かと存じます」は実送信にある → 当てない", findAiPhrases("好条件の為すぐに募集が埋まる可能性が高いお部屋となります！\n好立地となります！！\n駅近もかなり魅力的なお部屋となります！！\n合うお部屋かと存じます😊！！").length === 0);
  t("「アクセスも良く」は実送信に1通ある → 出口にしない", findAiPhrases("梅田エリアへのアクセスも良く、Wi-Fi無料のお部屋となります！！").length === 0);
  t("出口の語は全部 exit=true の物だけ", AI_PHRASE_RULES.filter((r) => !r.exit).every((r) => !findAiPhrases("梅田エリアへのアクセスも良く、気になる点があればお気軽に！！").some((h) => h.key === r.key)));
}

console.log("\n■ roomOnlyMentions（号室だけで物件を呼ぶ）");
{
  t("★ この208号室ならでは", roomOnlyMentions(AI_208).length === 1, JSON.stringify(roomOnlyMentions(AI_208)));
  t("行頭の「204号室、間取り的にも」は当たらない（助詞が続かない）… 当てるのは は・が・も・の", roomOnlyMentions("204号室は玉造駅から近く通いやすい立地なので").length === 1);
  t("建物名＋号室は当たらない", roomOnlyMentions("レオパレス天満107号室は家具付きで").length === 0 && roomOnlyMentions("S-RESIDENCE福島玉川Deux 208号室が玉川駅徒歩4分").length === 0);
  t("金額・年は当たらない", roomOnlyMentions("家賃管理費込72,500円で2017年築の角部屋です！！").length === 0);
  t("物件確認の実送信（同じ建物の部屋を並べる）は当たる＝だから出口は物件オススメの2通目だけに掛ける", roomOnlyMentions(REAL[8]).length >= 1);
}

console.log("\n■ ensureOneEmoji（絵文字が無ければ最後の！！の直前に😊・足すだけ）");
{
  const a = ensureOneEmoji("お送りさせて頂きましたお部屋の中でも特にS-RESIDENCE福島玉川Deux 208号室が玉川駅徒歩4分で、YUMAさんにかなりオススメ出来るお部屋となります！！");
  t("絵文字なし → 最後に😊！！", a.added && a.text.endsWith("お部屋となります😊！！"), a.text);
  t("絵文字がある文は触らない", !ensureOneEmoji(REAL[0]).added && ensureOneEmoji(REAL[0]).text === REAL[0]);
  t("！！で終わらない文は触らない", !ensureOneEmoji("お手隙の際にご査収ください！").added);
  t("空は触らない", !ensureOneEmoji("").added);
}

console.log("\n■ fixMissingNi・監査で決めた線");
{
  // ローカル生成（9/30）で出た形
  const r = fixMissingNi("レオパレス天満107号室が北区でバス・トイレ別、浴室乾燥機や宅配BOXも備わり、YUMAさんかなりオススメ出来るお部屋となります！！");
  t("★「YUMAさんかなりオススメ出来る」→「YUMAさんにかなりオススメ出来る」", r.fixed === 1 && r.text.includes("YUMAさんにかなりオススメ出来るお部屋となります！！"));
  t("「さんにかなりオススメ」は触らない", fixMissingNi(REAL[0]).fixed === 0 && fixMissingNi(REAL[0]).text === REAL[0]);
  t("★ 2通目の最後の「気になる点がございましたらいつでもお気軽に」（実送信の2通目 0/477）→ 当たる", findAiPhrases("10月16日以降ご内覧可能となりますので、気になる点がございましたらいつでもお気軽にご連絡ください😊！！").some((h) => h.key === "気になる点があれば") && findAiPhrases(AI_107).some((h) => h.key === "気になる点があれば"));
  t("「気になる物件ございましたら」は当てない", findAiPhrases("気になる物件ございましたらお気軽にお申し付けください😌！！").length === 0);
  t("監査で止めた語: 「充実した設備が揃っており」（実送信の2通目に2通）は当てない", findAiPhrases("ルクレ堺筋本町レジデンス606号室が敷金礼金なし・駅徒歩1分・充実した設備が揃っており、Aさんにかなりオススメ出来るお部屋となります！！").length === 0);
}

console.log("\n■ styleStatsOf / sceneOfSecond（監査の数え方）");
{
  const s = styleStatsOf(REAL[0]);
  t("実送信1: 2段落・絵文字1・！！の直前・建物名＋号室でない（1009 に号室の字なし）", s.paragraphs === 2 && s.emoji === 1 && s.emojiBeforeBang === 1 && s.maruEnd === 0, JSON.stringify(s));
  t("比較の言い方 → compare", sceneOfSecond({ second: REAL[0], aix: "property_send" }) === "compare");
  t("新着 → new_listing", sceneOfSecond({ second: REAL[4], aix: "property_recommendation" }) === "new_listing");
  t("こちらのお部屋如何でしょうか → single", sceneOfSecond({ second: REAL[5], aix: "property_recommendation" }) === "single");
}

console.log("\n■ 資料の事実（property_pickups の行から）");
const ROW_2676: SecondMaterialRow = { // S-RESIDENCE福島玉川Deux 208（空室・礼金あり）
  property_name: "S-RESIDENCE福島玉川Deux", room_no: "208",
  terms: { deposit: 0, keyMoney: 1, moveIn: { kind: "immediate", current: "vacant", availableFrom: "2026-09-30" }, evidence: { moveIn: "現況空き 入居可能時期即入居可", built: "築年数2023年10月" } },
  location: { stations: [{ line: "大阪メトロ千日前線", station: "玉川", walk: 4 }, { line: "阪神本線", station: "野田", walk: 7 }], area: { why: "希望の区（福島区）", code: "AREA_WARD_MATCH" } },
  equipment: { match: [{ label: "バス・トイレ別", result: "ok" }, { label: "ガスコンロ", result: "unlisted" }, { label: "対面キッチン", result: "unlisted" }], facts: { washbasin: { s: "ok", ev: "独立洗面台" }, bath_dryer: { s: "ok", ev: "浴室乾燥機" }, net_free: { s: "ok", ev: "インターネット(Wi-Fi)無料" }, parking: { s: "ng", ev: "駐車場空きなし" }, top_floor: { s: "ng", ev: "2階／15階建" } } },
};
const ROW_2670: SecondMaterialRow = { // レオパレス天満 107（居住中・11月中旬）
  property_name: "レオパレス天満", room_no: "107",
  terms: { deposit: 0, keyMoney: 2, moveIn: { kind: "date", current: "occupied", availableFrom: "2026-11-11" }, evidence: { moveIn: "現況居住中 入居可能時期2026年11月中旬" } },
};
const ROW_ZERO: SecondMaterialRow = { terms: { deposit: 0, keyMoney: 0, moveIn: { kind: "consult", current: "leaving" }, evidence: { moveIn: "退去予定/相談" } } };
{
  const n = buildSecondMaterialNote(ROW_2676);
  t("空室・駅・築年・礼金あり・合う点・記載なし・設備が入る", /空室（ご内覧頂けるお部屋）/.test(n) && /玉川駅 徒歩4分/.test(n) && /2023年10月/.test(n) && /礼金あり/.test(n) && /バス・トイレ別／希望の区（福島区）/.test(n) && /ガスコンロ／対面キッチン/.test(n) && /独立洗面台・浴室乾燥機/.test(n), n);
  t("礼金ありの物件に「敷金礼金なし」と書けるとは渡さない", /「敷金礼金なし」「初期費用を抑える事ができ」は書かない/.test(n));
  t("社内向けの事（駐車場なし・最上階でない・AD）は渡さない", !/駐車場|最上階|15階建|AD/.test(n));
  // 2026-10-01: 退去予定の一文は recommend-viewable が1つ作る（1通目と同じ）→ 資料の事実の側には「居住中」の字も入居可能時期の年も渡さない
  t("★ 居住中の行 → 退去予定のお部屋（「居住中」「2026年」の字は渡さない）", /・現況: 退去予定のお部屋（まだご内覧頂けない）/.test(buildSecondMaterialNote(ROW_2670)) && !/居住中|2026年|最短/.test(buildSecondMaterialNote(ROW_2670)), buildSecondMaterialNote(ROW_2670));
  t("敷金礼金どちらもなし → 書ける", /どちらもなし/.test(buildSecondMaterialNote(ROW_ZERO)) && /退去予定のお部屋/.test(buildSecondMaterialNote(ROW_ZERO)));
  t("行が無い・何も読めない → 空", buildSecondMaterialNote(null) === "" && buildSecondMaterialNote({}) === "");
  t("vacatingFromMaterial: vacant=false / occupied・leaving=true / 不明=null", vacatingFromMaterial(ROW_2676) === false && vacatingFromMaterial(ROW_2670) === true && vacatingFromMaterial(ROW_ZERO) === true && vacatingFromMaterial({}) === null);
}

console.log("\n■ unfoundedCostClaim（礼金のある物件に「費用を抑える事ができ」）");
{
  const out = "お送りさせて頂きましたお部屋の中でも特にS-RESIDENCE福島玉川Deux 208号室が玉川駅徒歩4分・築年数も新しく費用を抑える事ができ、YUMAさんにかなりオススメ出来るお部屋となります！！";
  const first = "🌟S-RESIDENCE福島玉川Deux 208号室\n\n…インターネット無料のため毎月の通信費も抑えてご入居頂けます。";
  t("★ YUMA のテストで出た文（礼金1ヶ月の物件）→ 当たる", unfoundedCostClaim(out, ROW_2676, first) === "費用を抑える事", String(unfoundedCostClaim(out, ROW_2676, first)));
  t("敷金礼金どちらもなしの物件 → 当てない", unfoundedCostClaim(out, ROW_ZERO, first) === null);
  t("資料の敷金礼金が読めない → 当てない", unfoundedCostClaim(out, {}, first) === null && unfoundedCostClaim(out, null, first) === null);
  t("1通目が同じ事を書いている → 当てない", unfoundedCostClaim(out, ROW_2676, "敷金礼金なしで初期費用をかなり抑えてご入居頂けます！！") === null);
  t("「毎月の通信費も抑えて」は当てない", unfoundedCostClaim("インターネット無料のため毎月の通信費も抑えてご入居頂けます！！", ROW_2676, "") === null);
}

console.log("\n■ 場面の形（入口）");
{
  const base = { name: "YUMA", propertyLabel: "S-RESIDENCE福島玉川Deux 208号室", sentCount: 20 };
  const a = buildSecondSceneNote({ ...base, scene: "compare", vacating: false });
  const b = buildSecondSceneNote({ ...base, scene: "new_listing", vacating: false });
  const c = buildSecondSceneNote({ ...base, scene: "single", vacating: false });
  const d = buildSecondSceneNote({ ...base, scene: "compare", vacating: true });
  t("(a) 比較の形＋物件名＋名前が入る", a.includes("「お送りさせて頂きましたお部屋の中でも特にS-RESIDENCE福島玉川Deux 208号室が」") && a.includes("YUMAさんにかなりオススメ出来るお部屋となります！！"));
  t("(b) 新着の形・比較の言い方は書かない指示", b.includes("新着で1件YUMAさんにオススメ出来るお部屋が募集に出ました！！") && b.includes("「お送りさせて頂きましたお部屋の中でも」とは書かない"));
  t("(c) 1件だけの形", c.includes("こちらのお部屋如何でしょうか😊！！") && c.includes("「お送りさせて頂きましたお部屋の中でも」「新着で」とは書かない"));
  t("(d) 退去予定の時だけ退去予定の一文の指示・退去予定の実物が先", d.includes("退去予定のお部屋: ") && !a.includes("退去予定のお部屋: ") && d.indexOf("アドバンス大阪セレーネ") < d.indexOf("Luxe難波西2"));
  // 2026-10-01: 退去予定の一文は決まった形をそのまま渡す／1通目が既に伝えていれば書かせない（退去予定の実物も見せない）
  const LINE = "退去予定のお部屋となり、11月中旬ごろご入居可能となります！！";
  const dl = buildSecondSceneNote({ ...base, scene: "compare", vacating: true, vacatingLine: LINE });
  t("★ 退去予定の一文をそのまま渡す・同じ行に締めを続けない指示", dl.includes(`このまま書く「${LINE}」`) && dl.includes("同じ行に締めの文を続けない") && !/最短での入居可能時期/.test(dl));
  const df = buildSecondSceneNote({ ...base, scene: "compare", vacating: true, vacatingLine: LINE, firstMentionsVacating: true });
  t("★ 1通目が退去予定を伝えている → 2通目では書かない指示・退去予定の実物を見せない", df.includes("退去予定の事は1通目で伝えてある") && !df.includes(LINE) && !df.includes("アドバンス大阪セレーネ"));
  t("空室の場面に退去予定の実物を見せない", !a.includes("退去予定") && !c.includes("退去予定"));
  // 指示の語は本文に出る → AI の言い回しを指示に入れない
  for (const n of [a, b, c, d]) {
    const body = n; // 実物の本文も含めて検査（実物は実送信なので当たらないはず）
    if (/見立て|特別感|強み|魅力|お値打ち|ならでは|演出/.test(body)) { t("指示と実物に AI の言い回しの語が無い", false, body.match(/見立て|特別感|強み|魅力|お値打ち|ならでは|演出/)?.[0] ?? ""); }
  }
  t("指示と実物に「見立て・特別感・強み・魅力・お値打ち・ならでは・演出」が無い（4場面）", [a, b, c, d].every((n) => !/見立て|特別感|強み|魅力|お値打ち|ならでは|演出/.test(n)));
  t("伏せ字（〇〇・○○・◯◯・{{NAME}}）が無い", [a, b, c, d].every((n) => !/[〇○◯]{2}|\{\{/.test(n)));
  const noName = buildSecondSceneNote({ scene: "compare", vacating: false, name: "", propertyLabel: null });
  t("名前が分からない時は呼びかけを落とす（伏せ字・「さん」単独を残さない）", !/\{\{|(?:^|[^ぁ-んァ-ヶ一-龥A-Za-z])さんに/.test(noName) && noName.includes("名前は書かない"), noName.slice(0, 400));
  t("手本は実送信そのまま（名前だけ置き換え）", renderExample(SECOND_MESSAGE_EXAMPLES.compare[0].text, "A") === REAL[0]);
  t("secondSceneOf: compare/new_listing はそのまま・ほかは single", secondSceneOf("compare") === "compare" && secondSceneOf("new_listing") === "new_listing" && secondSceneOf("first") === "single" && secondSceneOf("followup_single") === "single" && secondSceneOf("alternative") === "single" && secondSceneOf(null) === "single");
}

console.log("\n■ leakedExampleFacts（手本の物件名・駅・金額の持ち込み）");
{
  t("手本の駅が今回の文に入った → 当たる", leakedExampleFacts("S-RESIDENCE福島玉川Deux 208号室が芦原橋駅徒歩3分で、かなりオススメ出来るお部屋となります！！", "🌟S-RESIDENCE福島玉川Deux 208号室\n玉川駅徒歩4分").includes("芦原橋"));
  t("今回の物件の事実（1通目にある）は当てない", leakedExampleFacts("日本橋駅徒歩8分で、かなりオススメ出来るお部屋となります！！", "🌟エグゼ難波東 906号室\n堺筋線「日本橋」駅徒歩8分").length === 0);
  t("普通の文は当てない", leakedExampleFacts("お送りさせて頂きましたお部屋の中でも特にプレミアム新福島 505号室が新福島駅徒歩3分・バストイレ別で、YUMAさんにかなりオススメ出来るお部屋となります😊！！", "").length === 0);
}

console.log("\n■ buildAixChainNote（物件オススメの直後は、全 AIX の平均から作った指示を渡さない）");
{
  const first = "🌟S-RESIDENCE福島玉川Deux 208号室\n\n2023年10月築で築年数浅く、玉川駅徒歩4分・家賃管理費込81,000円の1K（22.56㎡）で、YUMAさんにかなりオススメ出来るお部屋となります！！\n\nお気に召しましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！";
  const slim = buildAixChainNote(first, { recommendScene: true });
  const full = buildAixChainNote(first);
  t("今まで通りの呼び方は変わらない（見立て・35% が入る）", /見立てを伝えて終わってよい/.test(full) && /35%/.test(full));
  t("★ 物件オススメの直後: 「見立て」「続きの一言」「35%」「36%」「120字前後」を渡さない", !/見立て|続きの一言|35%|36%|120字前後|約7通に1通/.test(slim), slim.match(/見立て|続きの一言|35%|36%|120字前後|約7通に1通/)?.[0] ?? "");
  t("1通目の本文と「これ以外の物件名・号室を出さない」は渡す", slim.includes("🌟S-RESIDENCE福島玉川Deux 208号室") && slim.includes("これ以外の物件名・号室を出さない"));
  t("1通目用の骨格（5段落構成）を使わない指示は渡す", slim.includes("1通目用なので今回は使わない"));
  t("1通目が空なら空", buildAixChainNote("", { recommendScene: true }) === "");
}

console.log("\n■ setRecommendClosing（最後の段落の最後の行が締めの時に、同じ締めを重ねない）");
{
  // YUMA 9/30 ローカル生成: 最後の段落が2行（退去予定の一文＋申込の誘導）で、同じ締めがもう1回足された
  const src = "こちらのお部屋如何でしょうか😊！！\nバス・トイレ別、大阪天満宮駅徒歩7分と北区のご希望にも合ったお部屋で、YUMAさんにかなりオススメ出来るお部屋となります！！\n\n退去予定のお部屋となります！！\nお気に召されましたらお申込しお部屋抑えさせて頂きます😊！！";
  const r = setRecommendClosing(src, "apply");
  t("★ 同じ締めを足さない", r.text === src && r.applied.length === 0, r.text);
  const r2 = setRecommendClosing(src.replace(APPLY_CLOSING_LINE, "お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！"), "apply");
  t("最後の行が別の締め → その行だけ差し替え（退去予定の一文は残す）", r2.text === src && r2.applied[0] === "closing:viewing->apply", r2.text);
  const r3 = setRecommendClosing("かなりオススメ出来るお部屋となります！！\n\n退去予定のお部屋となります！！\n11月1日以降ご内覧可能となります！！", "apply");
  t("最後の行が締めでない → 今まで通り足す", r3.text.endsWith(APPLY_CLOSING_LINE) && r3.applied[0] === "closing:added(apply)", r3.text);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
