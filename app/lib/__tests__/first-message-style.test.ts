// 実行: npx tsx app/lib/__tests__/first-message-style.test.ts
// 2026-10-01 竹内「1通目（AIX 物件オススメ）の言い回しも2通目と同じやり方で直す」
//   YUMA の LINE に実際に届いた1通目（AI・9/30）と、スタッフが実際に書いた1通目（実送信）の本文をそのまま使う。
import { findFirstAiPhrases, isCleanFirstExample, isFirstRecommendation, unifyBangEnding, fixAdjectiveNakaguro, FIRST_PHRASE_RULES } from "../first-message-style";
import { orderByRequestedIds, imageUrlsInRankOrder, firstSentPickupId } from "../sent-image-order";
import { buildFirstSceneNote, newArrivalOpening, leakedFirstExampleFacts, renderFirstExample, FIRST_MESSAGE_EXAMPLES } from "../first-message-scene";
import { pickPickupSecondTarget, type PickupPushRow } from "../second-message-scene";
import { removeRecommendClosing } from "../recommend-cta";
import { buildScenarioNote } from "../recommendation-frame";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, note = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${note}`); } }

// ── YUMA に届いた1通目（AI・9/30 深夜・本文そのまま）──
const AI_107 = "🌟レオパレス天満 107号室\n\n大阪天満宮駅徒歩7分・家賃管理費込85,500円で、YUMAさんにかなりオススメ出来るお部屋となります！！\n\n洋室8.3帖の1Kのお部屋で、家具付き・角部屋・宅配BOX完備と使いやすい設備が揃っております！！浴室乾燥機や室内洗濯機置場も備わっており、暮らしやすい作りとなっております！！\n\n退去予定のお部屋となり、11月中旬ごろご入居可能となります！！\n\nお気に召されましたらお申込しお部屋抑えさせて頂きます😊！！";
const AI_305 = "🌟プレサンス梅田北ザ・ライブ 305号室\n\n家賃管理費込75,000円・駅徒歩4分とかなり条件の良いお部屋で、YUMAさんにかなりオススメ出来るお部屋となります！！\n\n御堂筋線・阪急神戸本線「中津駅」徒歩4分で梅田へもすぐの立地です！！洋室6.1帖の1Kで、オートロックや洗濯機置場も備わっております。空室のため即入居可能です！！\n\nお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！";
const AI_703 = "🌟レオンコンフォート梅田北 703号室\n\n家賃管理費込75,000円・1K・21.37㎡で、YUMAさんにかなりオススメ出来るお部屋となります！！\n\n2020年1月築（築6年）の室内も綺麗な1Kで、独立洗面台や室内洗濯機置場、システムキッチンも備わっております！！収納スペース・シューズボックスもあり収納面もしっかり確保されております！！中崎町駅徒歩9分・中津駅徒歩10分と梅田へも出やすい立地です！！\n\n退去予定のお部屋となり、11月中旬ごろご入居可能となります！！\n\nお気に召されましたらお申込しお部屋抑えさせて頂きます😊！！";
const AI_208 = "🌟S-RESIDENCE福島玉川Deux 208\n\n家賃管理費込81,000円・玉川駅徒歩4分の1Kで、YUMAさんにかなりオススメ出来るお部屋となります！！\n\n2023年10月築で築年数浅く、室内も綺麗な22.56㎡のお部屋です。独立洗面台や浴室乾燥機、収納スペース、システムキッチンを備えており、インターネット無料のため毎月の通信費も抑えてご入居頂けます！！\n\nお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！";

// ── スタッフが実際に書いた1通目（名前だけ置き換え・scripts/audit-first-message-phrasing.ts の human）──
const REAL = [
  "🌟リアライズ玉出712、ペット飼育可能・独立洗面台付きでAさんにかなりオススメ出来るお部屋となります！！\n\n家賃管理費込77,500円の2DKで、Aさんご希望のペット飼育可能お部屋となります！！敷金礼金なしのため初期費用もかなり抑えてご入居頂けます！！\n\nAさんお気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！",
  "🌟1件新着でAさんにかなりオススメ出来るお部屋が募集に出ました！！\n洋室6.82帖でフリーレント1ヶ月付き、家賃管理費込74,000円とAさんご希望のご条件にぴったりなお部屋となります！！\n8月末退去予定のお部屋となります！！\nAさんお気に召されましたらお申込しお部屋抑えさせて頂きます😊！！\nお手隙の際にご査収ください！！",
  "Aさんにかなりオススメ出来るお部屋が募集に出ました！！\n🌟WIC付.敷金礼金0の為初期費用かなり抑えられます！！\n\nアーデン西天満704号室\n1DK（ダイニングキッチン6.6帖、洋室10.2帖）で開放感抜群のお部屋です！！\n家賃管理費込144,000円、敷金礼金なしで初期費用も抑えられます！！南向きで採光も良好、WICのお部屋となります😊！！\n\n9月末退去予定のお部屋となります！\nAさんお気に召されましたらお申込しお部屋抑えさせて頂きます😊！！\nお手隙の際にご査収ください！！",
  "🌟1件新着でAさんにかなりオススメ出来るお部屋が募集に出ました！！\nリノベーション済の鉄筋コンクリート造2LDKとなります！！\n8月末退去予定のお部屋となります！！\nお手隙の際にご査収ください😌！！",
  "Aさんお世話になっております！！\n\nAさんにかなりオススメ出来るお部屋が募集に出ました！！\n🌟ハピネス岸里 104\n家賃管理費込50,000円のワンルーム、2023年12月築の築浅物件となります！！\n保証人不要、エアコンも設置済み、敷金礼金0円の為初期費用かなり抑える事ができます😊！！\n\n空室のため即入居可能です！！\n\nお気に召されましたらお申込しお部屋抑えさせて頂きます！！",
];

console.log("■ 出口の語（findFirstAiPhrases）");
t("107: 使いやすい設備・暮らしやすい作り・作りとなって", ["使いやすい設備", "暮らしやすい作り", "作りとなって"].every((k) => findFirstAiPhrases(AI_107).some((h) => h.key === k)), JSON.stringify(findFirstAiPhrases(AI_107)));
t("305: 梅田へもすぐの立地", findFirstAiPhrases(AI_305).some((h) => h.key === "へもすぐ"));
t("703: 梅田へも出やすい立地", findFirstAiPhrases(AI_703).some((h) => h.key === "へもすぐ"));
t("208: 出口の語は無い（室内も綺麗はスタッフも書く＝数えるだけ）→ 「。」の揃えと入口で直す", findFirstAiPhrases(AI_208).length === 0);
t("スタッフが書いた1通目は1通も当たらない（誤って作り直しにならない）", REAL.every((r) => findFirstAiPhrases(r).length === 0), REAL.map((r) => JSON.stringify(findFirstAiPhrases(r))).join(" "));
t("出口の語は9つ・全部 example（手本から外す）も true", FIRST_PHRASE_RULES.filter((r) => r.exit).length === 9 && FIRST_PHRASE_RULES.filter((r) => r.exit).every((r) => r.example));

console.log("■ 入口: 手本の選別（isCleanFirstExample・isFirstRecommendation）");
t("YUMA の AI の1通目 4通は全部手本に見せない", [AI_107, AI_305, AI_703].every((x) => !isCleanFirstExample(x)) && isCleanFirstExample(AI_208) === true, "208 は室内も綺麗だけ（見せてよい語）");
t("スタッフが書いた1通目は全部見せてよい", REAL.every(isCleanFirstExample));
const SERENITE = "🌟SERENiTE本町reflet 0807\n\n敷金礼金なし・家賃83,500円と無料インターネットが備わった好条件で、松浦さんにかなりオススメ出来るお部屋となります！！\n\nDK5.3帖・洋室2.8帖の1DKで、2019年1月築と室内も綺麗な状態のお部屋です！！\n\n独立洗面台や浴室乾燥機、室内洗濯機置場が備わっており、オートロックや宅配BOXも完備で暮らしやすい作りとなっております！！\n\nインターネット無料のため毎月の通信費も抑えてご入居頂けます！！\n\n千日前線・中央線「阿波座」駅徒歩1分、御堂筋線「本町」駅も徒歩11分となんば・梅田へも出やすい立地です！！";
t("★ 9/30 の【実例】に入っていた AI の文（SERENiTE）は見せない", !isCleanFirstExample(SERENITE));
t("物件オススメの1通目の形か: 🌟の物件は true・審査の返信は false", isFirstRecommendation(AI_107) && !isFirstRecommendation("かしこまりました！！\n\n本人確認書類としてマイナンバーカードお申込みを進めることができます😊！！"));

console.log("■ 文末の揃え（unifyBangEnding）");
{
  const r = unifyBangEnding(AI_208);
  t("208: 「お部屋です。」→「！！」・語は消えない", r.changed === 1 && r.text.includes("22.56㎡のお部屋です！！独立洗面台") && r.text.replace(/！！/g, "").length === AI_208.replace(/。/g, "").replace(/！！/g, "").length);
  const r2 = unifyBangEnding(AI_305);
  t("305: 「備わっております。」→「！！」", r2.changed === 1 && r2.text.includes("洗濯機置場も備わっております！！空室"));
  t("スタッフが書いた1通目は1通も変わらない", REAL.every((x) => unifyBangEnding(x).changed === 0));
  const allMaru = "🌟X 101\n\n家賃管理費込70,000円の1Kとなります。\n\n駅徒歩5分です。";
  t("全部「。」の通は触らない", unifyBangEnding(allMaru).changed === 0);
  const paren = "🌟X 101\n\n2020年築（築6年。リノベ済）の1Kです！！駅徒歩5分です。\n・家賃70,000円。\nhttps://example.com/a。b";
  const r3 = unifyBangEnding(paren);
  t("括弧の中・箇条書きの行・URL の行は触らない", r3.changed === 1 && r3.text.includes("（築6年。リノベ済）") && r3.text.includes("・家賃70,000円。") && r3.text.includes("https://example.com/a。b"));
}

console.log("■ 1通目の書き方（buildFirstSceneNote）");
{
  const cases = [
    buildFirstSceneNote({ isNew: false, vacating: false, name: "YUMA", compare: true }),
    buildFirstSceneNote({ isNew: false, vacating: true, name: "YUMA" }),
    buildFirstSceneNote({ isNew: true, vacating: false, name: "YUMA" }),
    buildFirstSceneNote({ isNew: true, vacating: true, name: "" }),
  ];
  t("指示と実物に AI の言い回しの語が無い（4場面）", cases.every((n) => !/見立て|特別感|強み|魅力|お値打ち|ならでは|演出|暮らしやすい|使いやすい設備|すぐの立地|出やすい立地/.test(n)), cases.map((n) => n.match(/見立て|特別感|強み|魅力|お値打ち|ならでは|演出|暮らしやすい|使いやすい設備|すぐの立地|出やすい立地/)?.[0] ?? "").join(","));
  t("実物は締めの文を除いて渡す（1通目は締めを書かない）", cases.every((n) => !/お気に召され|ご査収/.test(n.split("■ スタッフが実際に送った1通目")[1] ?? "")));
  t("「締めの誘導は書かない」の指示がある", cases.every((n) => n.includes("締めの誘導") && n.includes("書かない")));
  t("新着は実送信の冒頭「1件新着でYUMAさんにかなりオススメ出来るお部屋が募集に出ました！！」", cases[2].includes("1件新着でYUMAさんにかなりオススメ出来るお部屋が募集に出ました！！"));
  t("新着でない場面に新着の実物（1件新着で）は出さない（比較の場面と食い違う）", !/1件新着で/.test(cases[0]) && !/1件新着で/.test(cases[1]));
  t("退去予定の場面は退去予定の実物を先に・空室の場面は退去予定の実物を出さない", /退去予定/.test(cases[3]) && !/退去予定のお部屋となります！！/.test(cases[2]));
  t("名前が無い時は伏せ字を残さない", !/\{\{NAME\}\}|〇〇さん/.test(cases[3]));
  t("実物はスタッフが書いた本文そのまま（締めを除く）", FIRST_MESSAGE_EXAMPLES.every((e) => cases.some((n) => n.includes(removeRecommendClosing(renderFirstExample(e.text, "YUMA")).text) || n.includes(removeRecommendClosing(renderFirstExample(e.text, "")).text)) || e.isNew));
  t("新着の冒頭（名前なし）", newArrivalOpening("") === "1件新着でかなりオススメ出来るお部屋が募集に出ました！！" && newArrivalOpening("YUMAさん") === "1件新着でYUMAさんにかなりオススメ出来るお部屋が募集に出ました！！");
}

console.log("■ 手本の物件名の持ち込み（leakedFirstExampleFacts）");
t("手本の建物名が入れば当たる", leakedFirstExampleFacts("🌟リアライズ玉出 712\n…", "").includes("リアライズ玉出"));
t("資料に同じ名前があれば当たらない", leakedFirstExampleFacts("🌟リアライズ玉出 712", "リアライズ玉出 712").length === 0);
t("YUMA の AI の1通目は当たらない", [AI_107, AI_305, AI_703, AI_208].every((x) => leakedFirstExampleFacts(x, "").length === 0));

console.log("■ シナリオの指示に演出・多様の語が無い");
t("compare / new_listing / first に「特別感」「演出」「多様」が無い", (["compare", "new_listing", "alternative", "followup_single", "first"] as const).every((s) => !/特別感|演出|多様/.test(buildScenarioNote(s))));

console.log("■ ピックアップの後に推す物件（pickPickupSecondTarget）");
{
  const base = { rank: 1, recommended: 0, score: 50, verdict: "pass", reason_codes: ["FIT_ALL"], created_at: "2026-10-01T01:00:00Z" };
  const rows: PickupPushRow[] = [
    { ...base, id: 1, rank: 2, score: 60, property_name: "A館", room_no: "101", sent_at: "2026-10-01T02:00:00Z" },
    { ...base, id: 2, rank: 1, score: 90, property_name: "B館", room_no: "202", sent_at: "2026-10-01T02:00:05Z" },
    { ...base, id: 3, rank: 3, score: 99, property_name: "C館", room_no: "303", sent_at: "2026-09-30T02:00:00Z" }, // 前の回
  ];
  const r = pickPickupSecondTarget(rows);
  t("一番新しい送った回（10分以内）の中で、売上サポの並びの先頭（点の高い B館）", r?.property_name === "B館", r?.property_name ?? "null");
  t("送った行が1件だけなら null（今まで通り）", pickPickupSecondTarget([rows[0]]) === null);
  t("送った印が無い行は数えない", pickPickupSecondTarget(rows.map((x) => ({ ...x, sent_at: null }))) === null);
  // 2026-10-01 竹内「送った資料の1枚目が一番オススメの物件にする形 1枚目の👑」: 送った画像の1枚目の記録があればそれ
  t("★ 送った画像の1枚目（記録 first_pickup_id）がこの回にあればそれを推す（点の順より先）", pickPickupSecondTarget(rows, { firstSentId: 1 })?.property_name === "A館");
  t("記録の行がこの回に無い（前の回）→ 画面の並びの先頭（今まで通り）", pickPickupSecondTarget(rows, { firstSentId: 3 })?.property_name === "B館");
  t("記録が無い → 画面の並びの先頭", pickPickupSecondTarget(rows, { firstSentId: null })?.property_name === "B館");
}

console.log("■ 送る画像の並び（sent-image-order）");
{
  const rows = [{ id: 10, rank: 1 }, { id: 11, rank: 2 }, { id: 12, rank: 3 }];
  t("★ GET は頼まれた ids の順（👑=12 が先頭）で返す", orderByRequestedIds(rows, [12, 10, 11]).map((r) => r.id).join(",") === "12,10,11");
  t("頼まれていない行は後ろに rank の順", orderByRequestedIds([...rows, { id: 13, rank: 0 }], [11]).map((r) => r.id).join(",") === "11,13,10,12");
  // 画面の並び（👑 12 → 10 → 11）で送った URL を、記録（rank 順）の並びに直す
  t("★ 届いた URL を rank 順に並べ直す（記録は rank 順の行と位置で結ぶ）", imageUrlsInRankOrder([{ id: 12, rank: 3 }, { id: 10, rank: 1 }, { id: 11, rank: 2 }], ["u12", "u10", "u11"]).join(",") === "u10,u11,u12");
  t("数が合わない・rank が無い時は渡さない（結ばない）", imageUrlsInRankOrder([{ id: 1, rank: 1 }], ["a", "b"]).length === 0 && imageUrlsInRankOrder([{ id: 1, rank: undefined }], ["a"]).length === 0);
  const f1 = { n: 1 }, f2 = { n: 2 }, f3 = { n: 3 };
  t("★ 送った1枚目の行（セットしたまま）", firstSentPickupId({ handoffIds: [12, 10], handoffFiles: [f1, f2], sentFiles: [f1, f2] }) === 12);
  t("スタッフが並べ替えた → 送った1枚目の画像の行", firstSentPickupId({ handoffIds: [12, 10], handoffFiles: [f1, f2], sentFiles: [f2, f1] }) === 10);
  t("1枚目を差し替えた・分からない → null", firstSentPickupId({ handoffIds: [12, 10], handoffFiles: [f1, f2], sentFiles: [f3, f1] }) === null && firstSentPickupId({ handoffIds: undefined, handoffFiles: undefined, sentFiles: [f1] }) === null);
}

console.log("■ 「浅く・」→「浅く、」（fixAdjectiveNakaguro）");
{
  // 2026-10-01 YUMA に届いた2通目そのまま
  const YUMA2 = "お送りさせて頂きましたお部屋の中でも特にレオンコンフォート梅田北 703号室が2020年1月築で築年数浅く・バス・トイレ別・独立洗面台付きで、YUMAさんにかなりオススメ出来るお部屋となります😊！！";
  const r = fixAdjectiveNakaguro(YUMA2);
  t("★ 実物: 「築年数浅く・バス・トイレ別」→「築年数浅く、バス・トイレ別」（バス・トイレの「・」は触らない）", r.changed === 1 && r.text === YUMA2.replace("浅く・", "浅く、"), r.text);
  // 実送信（AIX の下書きのまま送った1通目）
  const AIX1 = "🌟BRAVE新町 802号室\n\n2022年築で築年数浅く・ペット可・長堀鶴見線「西長堀」徒歩2分、mさんにかなりオススメ出来るお部屋となります！！";
  t("実送信の1通目（AIX のまま）も直る", fixAdjectiveNakaguro(AIX1).text.includes("築年数浅く、ペット可"));
  // スタッフの文（名詞の「近く」）は触らない
  const HUMAN = "家賃7.5万円・築7年以内・駅徒歩7分以内・スーパー近く・ペット可のご条件で和音さんにオススメできるお部屋ピックアップさせて頂きます！！";
  t("★ スタッフの文「スーパー近く・ペット可」（近く＝名詞）は触らない", fixAdjectiveNakaguro(HUMAN).changed === 0 && fixAdjectiveNakaguro(HUMAN).text === HUMAN);
  t("「浅く、」「バス・トイレ別」は触らない", fixAdjectiveNakaguro("築年数浅く、バス・トイレ別").changed === 0);
  t("語は消さない（長さは同じ）", r.text.length === YUMA2.length);
}

console.log("■ 2通目を送らない時だけ1通目に締め（buildFirstSceneNote closingInFirst）");
{
  const off = buildFirstSceneNote({ isNew: false, vacating: false, name: "YUMA" });
  const on = buildFirstSceneNote({ isNew: false, vacating: false, name: "YUMA", closingInFirst: true });
  t("既定（OFF）: 締めを書かない", off.includes("締めの誘導（ご案内・お申込でお部屋を抑える・ご査収ください）は書かない"));
  t("★ ON: 最後の段落に締めの1文を置く・「書かない」の指示は無い", on.includes("最後の段落に締めの1文") && !on.includes("締めの誘導（ご案内・お申込でお部屋を抑える・ご査収ください）は書かない"));
  t("「浅く・」と書かない指示が1通目に入る", off.includes("「築年数浅く・」とは書かない"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
