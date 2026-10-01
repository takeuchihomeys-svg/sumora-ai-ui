// app/lib/__tests__/hearing-form.test.ts
// 2026-10-02 竹内さん「ヒアリングのフォーマットはそのまま・お客さんからもらっている条件は項目のところにいれる」
//   「物件ピックアップは条件がそろってから」の回帰テスト。値は本番の顧客の行・発言の形（名前は伏せた）。
// 実行: npx tsx app/lib/__tests__/hearing-form.test.ts
import { buildHearingForm, hearingValues, parseConditionText, pickupConditionsReady, prefilledCount, HEARING_FORM_ITEMS, hearingKnownFromCustomerTexts, mergeHearingKnown } from "../hearing-form";
import { analyzeSumoraForm } from "../condition-format";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

console.log("── 8項目は必ず全部・順番も実送信のまま＋⑨ご入居人数（10/02）");
{
  const empty = buildHearingForm("うらら", null);
  const lines = empty.split("\n");
  t("見出し＋9行（①〜⑧＋⑨ご入居人数）", lines.length === 10, String(lines.length));
  t("見出しは「（〇〇さんご希望のお部屋探しご条件）」", lines[0] === "（うららさんご希望のお部屋探しご条件）", lines[0]);
  t("空の時は実送信の41通（①〜⑧）と一字一句同じ＋⑨ご入居人数",
    empty === "（うららさんご希望のお部屋探しご条件）\n①ご入居時期\n②ご希望家賃（管理費込み）\n③ご希望間取り\n④ご希望築年数\n⑤ご希望エリア・最寄り駅\n⑥駅からの徒歩分数\n⑦初期費用ご予算\n⑧その他こだわり条件（ペット・保証人・駐車場等）\n⑨ご入居人数", empty);
  t("さん付きの名前に重ねない", buildHearingForm("あさみさん", null).startsWith("（あさみさんご希望"));
}

console.log("── 人の実物（c167c5f1 7/23）: 間取りとエリアだけ分かっている");
{
  const f = buildHearingForm("恵人", { floor_plan: "1LDK", desired_area: "難波付近" });
  t("③に全角の空白で 1LDK", f.includes("\n③ご希望間取り　1LDK\n"), f);
  t("⑤に全角の空白で 難波付近", f.includes("\n⑤ご希望エリア・最寄り駅　難波付近\n"), f);
  t("分からない①②④⑥⑦⑧は空欄のまま（消さない）", f.includes("\n①ご入居時期\n") && f.includes("\n②ご希望家賃（管理費込み）\n") && f.includes("\n⑧その他こだわり条件（ペット・保証人・駐車場等）"), f);
  t("9項目そろっている", f.split("\n").length === 10);
}

console.log("── 旧ロジックで項目が落ちていた形（YUMA 8/24 の4項目）も8項目");
{
  // 旧: 条件の文字に「家賃:」「間取り:」「エリア:」「駅徒歩:」があると項目を消して番号を詰めていた
  const condText = "エリア: 難波\n間取り: ワンルーム\n家賃: 〜7万円以内\n駅徒歩: 10分以内";
  const f = buildHearingForm("YUMA", parseConditionText(condText));
  t("9項目そろっている", f.split("\n").length === 10, f);
  t("家賃が〜7万円で入る", f.includes("②ご希望家賃（管理費込み）　〜7万円"), f);
  t("駅徒歩が10分以内で入る", f.includes("⑥駅からの徒歩分数　10分以内"), f);
  t("書き入れた数は4", prefilledCount(parseConditionText(condText)) === 4);
}

console.log("── 本番の顧客の行の形（9/30 作成・名前なし）");
{
  const row = { desired_area: "弁天町駅", floor_plan: "1K", rent_min: null, rent_max: 78000, walk_minutes: 15, move_in_time: "10月中", building_age: 5, initial_cost_limit: null,
    preferences: "保証人なし希望・家具付", ng_points: null, other_requests: "築浅・家具付・初期費用はできるだけ安く" };
  const v = hearingValues(row);
  t("入居 10月中", v.move_in === "10月中");
  t("家賃 〜7.8万円", v.rent === "〜7.8万円", v.rent);
  t("築年数 5年以内", v.building_age === "5年以内");
  t("徒歩 15分以内", v.walk === "15分以内");
  t("初期費用は無いので空欄", v.initial_cost === "");
  t("その他は重複（家具付）を1つに", v.other === "保証人なし希望・家具付・築浅・初期費用はできるだけ安く", v.other);
  const row2 = { desired_area: "都島駅・桜ノ宮駅", floor_plan: "2LDK", rent_min: 70000, rent_max: 100000, move_in_time: "まだ未定", preferences: "RC造(鉄筋コンクリート)希望", ng_points: "木造NG" };
  const v2 = hearingValues(row2);
  t("家賃の幅 7万円〜10万円", v2.rent === "7万円〜10万円", v2.rent);
  t("NG はそのまま（木造NG）", v2.other.includes("木造NG"), v2.other);
  const v3 = hearingValues({ ng_points: "木造", pet: true });
  t("NG の語が無ければ NG を付ける・ペット（列）を足す", v3.other === "木造NG・ペット可", v3.other);
  const v4 = hearingValues({ commute_station: "谷町四丁目駅", commute_minutes: 30 });
  t("エリアが無く通勤先だけ → 「〇〇まで30分」", v4.area === "谷町四丁目駅まで30分", v4.area);
  const v5 = hearingValues({ initial_cost_limit: 300000, building_age: 0 });
  t("初期費用 30万円以内・築年数0は空欄", v5.initial_cost === "30万円以内" && v5.building_age === "", JSON.stringify(v5));
}

console.log("── 条件の文字（ブレインの「顧客条件:」の形）も読める");
{
  const k = parseConditionText("顧客条件: エリア: 堺筋本町駅 / 間取り: 1LDK / 家賃下限: 7万 / 家賃上限: 12万 / 入居: 1年以内 / 初期費用上限: 30万 / NG条件: 1階");
  t("エリア", k.desired_area === "堺筋本町駅");
  t("家賃の上下", k.rent_min === 70000 && k.rent_max === 120000, JSON.stringify(k));
  t("初期費用", k.initial_cost_limit === 300000);
  t("NG", k.ng_points === "1階");
  t("追加条件（未確定の控え）は書き入れない", !hearingValues(parseConditionText("追加条件: [10/01 12:00|add] 2階以上")).other);
}

console.log("── 書き入れたフォームが返ってきたら埋まったフォームとして読める（condition-format と往復）");
{
  const sent = buildHearingForm("恵人", { floor_plan: "1LDK", desired_area: "難波付近" });
  const v = analyzeSumoraForm(sent);
  t("9項目を項目として数える", v.labelCount === 9, JSON.stringify(v));
  t("書き入れた2項目は値ありと読む", v.filled.sort().join(",") === "area,floor_plan", v.filled.join(","));
  // お客様が空欄に書き足して返す（実物 b6e6f492 の書き方: 項目名の後ろに空白で値）
  const back = sent.replace("①ご入居時期", "①ご入居時期 10月頃").replace("②ご希望家賃（管理費込み）", "②ご希望家賃（管理費込み）　20万以下");
  const v2 = analyzeSumoraForm(back);
  t("書き足した入居・家賃も読む", v2.filled.includes("move_in") && v2.filled.includes("rent") && v2.isFilledForm, v2.filled.join(","));
}

console.log("── 物件ピックアップに必要な条件（エリア＋家賃）");
{
  t("行にエリアと家賃 → そろった", pickupConditionsReady({ desired_area: "難波", rent_max: 70000 }).ready);
  t("通勤先＋家賃でもそろった", pickupConditionsReady({ commute_station: "梅田", rent_max: 90000 }).ready);
  const r = pickupConditionsReady({ desired_area: "難波", rent_max: null });
  t("家賃が無い → 足りない（rent）", !r.ready && r.missing.join() === "rent", JSON.stringify(r));
  t("行が無く発言も無い → 足りない（両方）", pickupConditionsReady(null, []).missing.join() === "area,rent");
  // 実物（9/26 みこと）: 行の作成前に記入済みのフォーム（空白で値）
  t("行が無くても記入済みのフォームでそろった",
    pickupConditionsReady(null, ["（みことさんご希望のお部屋探しご条件）\n①ご入居時期 2ヶ月後\n②ご希望家賃（管理費込み） 6～7\n③ご希望間取り 1K\n④ご希望築年数 30年\n⑤ご希望エリア・最寄り駅 淡路駅\n⑥駅からの徒歩分数 10分\n⑦初期費用ご予算 10万\n⑧その他こだわり条件（ペット・保証人・駐車場等） 保証人なし"]).ready);
  // 実物（7/27 cb1a46e3）「環状沿いならどこでもいいんで。…場所より安さで」→ 家賃が分からない
  const r2 = pickupConditionsReady(null, ["環状沿いならどこでもいいんで。", "安いんがいいので、お願いします", "場所より安さで、お願いします"]);
  t("「環状沿い・安さで」は家賃が足りない", !r2.ready && r2.missing.join() === "rent", JSON.stringify(r2));
  // 実物（YUMA 8/24 の場面の文）「難波周辺でワンルーム探してます」→ 家賃が無い
  t("「難波周辺でワンルーム」だけは家賃が足りない", pickupConditionsReady(null, ["難波周辺でワンルーム探してます"]).missing.join() === "rent");
  t("「上本町周辺で…家賃は15万前後まで」はそろった", pickupConditionsReady(null, ["上本町周辺で8月前半入居で", "家賃は15万前後まで"]).ready);
  t("フォームの家賃欄の単位なし「6〜8」も家賃", pickupConditionsReady({ desired_area: "東花園" }, ["②【ご希望の家賃（◯万円〜◯万円）】⇒6〜8"]).ready);
  t("時刻（14:30〜15:00）は家賃と読まない", !pickupConditionsReady({ desired_area: "難波" }, ["14:30〜15:00くらいに掛けても大丈夫でしょうか？"]).ready);
  t("行が空でも発言でそろえば ready（source=customer_text）", pickupConditionsReady({}, ["梅田周辺で家賃8万まで"]).source === "customer_text");
}

console.log("── 顧客の行が無い時はお客様の発言から（お客様の言葉のまま・scripts/audit-hearing-prefill.ts の実物）");
{
  const k1 = hearingKnownFromCustomerTexts(["難波付近エリアで\n1LDKのお部屋のご相談がしたいです！"]);
  t("c167c5f1「難波付近エリアで1LDK」→ エリア・間取り", k1.desired_area === "難波付近エリア" && k1.floor_plan === "1LDK", JSON.stringify(k1));
  const k2 = hearingKnownFromCustomerTexts(["お世話になってます！  南森町あたりで一人暮らし用の家ありませんか？"]);
  t("e00e01ee「南森町あたり」→ 南森町周辺", k2.desired_area === "南森町周辺", JSON.stringify(k2));
  const k3 = hearingKnownFromCustomerTexts(["10月末入居希望だといつ頃申し込めばいいでしょうか？"]);
  t("d25e07d1「10月末入居希望」→ 入居 10月末", k3.move_in_time === "10月末", JSON.stringify(k3));
  const k4 = hearingKnownFromCustomerTexts(["また、大国町駅付近にある、ララプレイス難波シエールというマンションの空きはありますか？"]);
  t("特定のマンションの空きの質問の場所は条件にしない", !k4.desired_area, JSON.stringify(k4));
  const k5 = hearingKnownFromCustomerTexts(["内見行きたいのと、9月か10月に入居することは可能ですか？"]);
  t("特定のお部屋の入居の可否の質問は入居時期にしない", !k5.move_in_time, JSON.stringify(k5));
  const k6 = hearingKnownFromCustomerTexts(["10月頃に引っ越し予定です。家賃7万円以内で梅田あたり"]);
  t("家賃・入居・エリア（「万円以内で梅田」を場所に混ぜない）", k6.rent_max === 70000 && k6.move_in_time === "10月頃" && k6.desired_area === "梅田周辺", JSON.stringify(k6));
  t("物件の画像の読み取り・URL の通は読まない", Object.keys(hearingKnownFromCustomerTexts(["[画像] 物件情報 難波周辺 1K 6.5万円", "https://suumo.jp/x 梅田周辺 1LDK"])).length === 0);
  const m = mergeHearingKnown({ desired_area: "梅田", rent_max: null }, { desired_area: "難波周辺", rent_max: 70000 });
  t("行が先（エリアは行の梅田）・空欄だけ発言で埋める（家賃 7万）", m.desired_area === "梅田" && m.rent_max === 70000, JSON.stringify(m));
}

console.log("── 項目の定義は8つ");
t("HEARING_FORM_ITEMS は9（⑨ご入居人数）", HEARING_FORM_ITEMS.length === 9 && HEARING_FORM_ITEMS[8].label === "ご入居人数");

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
