// 電話の後・内覧の後のお礼の1通から事実を取る（app/lib/offline-result.ts）のテスト
// 2026-11-11 作業員1（弱い所 573・574）。文はすべて実物のスタッフの送信（お客様の名前は〇〇に伏せた・物件名はそのまま）。
// 実行: npx tsx app/lib/__tests__/offline-result.test.ts
import { offlineThanksKind, extractOfflineFacts, hasOfflineFacts, offlineResultMaterialLine, offlineResultMaterialOn } from "../offline-result";

let passed = 0, failed = 0; const failures: string[] = [];
const it = (name: string, fn: () => void) => { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; failures.push(name); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } };
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };
const ok = (v: unknown, msg = "expected truthy") => { if (!v) throw new Error(msg); };

it("既定 off", () => { eq(offlineResultMaterialOn({}), false); eq(offlineResultMaterialOn({ OFFLINE_RESULT_MATERIAL: "on" }), true); });

it("お礼の1通の種類", () => {
  eq(offlineThanksKind("〇〇さん 先ほどはお電話ありがとうございました！！"), "phone");
  eq(offlineThanksKind("〇〇さん先程お電話ありがとうございました！！"), "phone");
  eq(offlineThanksKind("〇〇さん 本日お時間頂きありがとうございました！！"), "viewing");
  eq(offlineThanksKind("〇〇さん 本日はご内覧お越しいただきありがとうございました！！"), "viewing");
  eq(offlineThanksKind("お電話大丈夫です😊！！ こちらの電話をかけるボタンよりお電話お願い致します！！"), null);
  eq(offlineThanksKind("本日17時お部屋ご案内させて頂きます！ 本日は何卒よろしくお願い致します！！"), null);
});

it("電話: 決まった日程と申込する部屋（583171e6）", () => {
  const f = extractOfflineFacts("〇〇さん 先ほどはお電話ありがとうございました！！ 11/1日にライオンズマンション千代田柳風台 103号室お申込みさせていただきます！！ 引き続きよろしくお願いいたします！！");
  ok(f); eq(f!.kind, "phone"); eq(f!.applyRoom, "ライオンズマンション千代田柳風台 103号室"); eq(f!.dates, ["11/1日お申込"]);
});

it("電話: 確認の約束（f4ecb148・室内の色味）", () => {
  const f = extractOfflineFacts("〇〇さん 先ほどはお電話ありがとうございました😊！！ 401号室の室内の色味に関して管理会社担当者に確認しております！！ 担当者よりご返答あり次第すぐにご連絡させていただきます！！");
  eq(f!.confirms, ["401号室の室内の色味"]);
});

it("電話: ピックアップの約束だけ（fff5b6a3）", () => {
  const f = extractOfflineFacts("〇〇さん先程お電話ありがとうございました！！ 物件ピックアップ出来ましたらお送りさせて頂きます！！ 何卒よろしくお願い致します！！");
  ok(hasOfflineFacts(f)); eq(f!.pickupPromise, true);
  ok(/物件をピックアップして送る約束/.test(offlineResultMaterialLine(f)));
});

it("電話: 提携会社への引き継ぎは事実だけ（審査の事情は取らない・25ccb676／288d474a）", () => {
  const f = extractOfflineFacts("お電話でご説明させていただきました弊社提携先の不動産業者 大福不動産の山之内となります！！ 割引内容、審査面に関するご相談なども共有させていただいております！！ 先ほどはお電話ありがとうございました");
  eq(f!.handoff, true);
  const line = offlineResultMaterialLine(f);
  ok(!/審査/.test(line), line);
});

it("内覧: 新しい条件で探す約束（2d7548d5）", () => {
  const f = extractOfflineFacts("〇〇さん 本日はお時間頂きありがとうございました！！ 本町駅まで乗り換え含め3駅以内のエリア全域から家賃14万円以内の1SLDK 2LDK、大きめ(45平米以上)の1LDKのお部屋ピックアップしお送りさせて頂きます😊！！");
  eq(f!.kind, "viewing");
  ok(f!.conditions.includes("家賃14万円以内"), JSON.stringify(f!.conditions));
  ok(f!.conditions.some((c) => /45平米以上/.test(c)), JSON.stringify(f!.conditions));
  ok(f!.conditions.includes("2LDK"), JSON.stringify(f!.conditions));
});

it("内覧: 築年数・広さ（615499ba）", () => {
  const f = extractOfflineFacts("〇〇さん 本日お時間頂きありがとうございました！！ 築年数10年以内もしくはリノベーション物件で60㎡以上の2LDK以上のおすすめできるお部屋ピックアップでき次第お送りさせていただきます！！");
  ok(f!.conditions.includes("築年数10年以内") && f!.conditions.some((c) => /^60(?:㎡|m2)以上$/.test(c)) && f!.conditions.includes("2LDK以上"), JSON.stringify(f!.conditions));
});

it("内覧: 家賃とリビング（601b5a0c）", () => {
  const f = extractOfflineFacts("〇〇さん本日お時間頂きありがとうございました！！ 家賃25万円以内でおすすめできるリビングが大きめの物件が出次第お送りさせて頂きます！");
  ok(f!.conditions.includes("家賃25万円以内") && f!.conditions.includes("リビングが大きめ"), JSON.stringify(f!.conditions));
});

it("内覧: その場で聞かれた事の確認の約束（箇条書き・583171e6）", () => {
  const f = extractOfflineFacts("〇〇さん 本日お時間頂きありがとうございました！！ ライオンズマンション千代田柳風台 103号室お申込しお部屋抑えさせて頂きます！！ ご内覧時にお伺いさせていただきました。\n・ペット飼育可能か\n・1/1日ご入居可能か\n管理会社担当者に確認交渉させていただきます！！");
  eq(f!.applyRoom, "ライオンズマンション千代田柳風台 103号室");
  eq(f!.confirms, ["ペット飼育可能か", "1/1日ご入居可能か"]);
});

it("内覧: 予定と別の部屋に申込（13f37ce2・予定 103 → 303）", () => {
  const f = extractOfflineFacts("〇〇さん 本日お時間頂きありがとうございました！！ フォーマットのご入力と免許証の表裏のお写真お送りいただけましたらサンシエ南巽303号室お申込しお部屋抑えさせて頂きます！");
  eq(f!.applyRoom, "サンシエ南巽 303号室");
  ok(/その場で別の部屋に決めた/.test(offlineResultMaterialLine(f, null, { viewedRoom: "サンシエ南泉 103号室" })));
});

// 2026-11-11 監査（60日の実送信 77通を目で読んだ）で直した物
it("1つの文に2部屋の申込（11/11 タツヤさんの形）", () => {
  const f = extractOfflineFacts("〇〇さん 本日お時間頂きありがとうございました！！ グルーブ日本橋502号室ラシーヌ日本橋501号室お申込しお部屋抑えさせて頂きます！");
  eq(f!.applyRoom, "グルーブ日本橋 502号室・ラシーヌ日本橋 501号室");
});
it("もう確認できた結果の箇条書きは約束にしない（09/24 ペットの費用）", () => {
  const f = extractOfflineFacts("〇〇さん 本日お時間頂きありがとうございました！！ それぞれのペット飼育する際に発生する費用確認できましたのでご連絡せていただきます！！\n◎アーバネックス堺筋本町\n・月額共益費¥3,000円加算");
  eq(f!.confirms, []); eq(f!.results, ["月額共益費¥3,000円加算"]);
});
it("家賃の「程・ほど」・敷金礼金無し・帖・独立洗面台", () => {
  const f = extractOfflineFacts("〇〇さん 本日お時間頂きありがとうございました！！ 本町駅から徒歩1時間圏内のエリア全域から家賃管理6万円以内の洋室7帖以上、独立洗面台の備わったお部屋ピックアップさせていただきます！！");
  ok(f!.conditions.includes("家賃管理6万円以内") && f!.conditions.includes("洋室7帖以上") && f!.conditions.includes("独立洗面台"), JSON.stringify(f!.conditions));
  const g = extractOfflineFacts("〇〇さん本日お時間頂きありがとうございました！！ 引き続き野田駅徒歩7分以内で敷金礼金無しの家賃8万円以内の築年数浅めのおすすめできる物件ピックアップさせていただきます");
  ok(g!.conditions.includes("敷金礼金無し") && g!.conditions.includes("築年数浅め"), JSON.stringify(g!.conditions));
});
it("エリアの一節に家賃の語を混ぜない（10/08 の形）", () => {
  const f = extractOfflineFacts("〇〇さん 本日お時間頂きありがとうございました！！ 引き続き家賃管理費込み15万円以内で堺筋本町周辺のペット飼育可能なお部屋ピックアップさせていただきます！！");
  ok(f!.conditions.includes("堺筋本町周辺") && !f!.conditions.some((c) => /^み/.test(c)), JSON.stringify(f!.conditions));
});

it("お礼だけの1通は材料にしない（22b2511e）", () => {
  const f = extractOfflineFacts("〇〇さん 本日お時間頂きありがとうございました！！ お気に召されましたらお部屋のお申込みさせて頂きますのでお気軽にお知らせください😊！！");
  eq(hasOfflineFacts(f), false); eq(offlineResultMaterialLine(f), "");
});

it("審査の事情の文は取らない", () => {
  const f = extractOfflineFacts("〇〇さん先程はお電話ありがとうございました！！ 夜職でも審査通過出来るよう勤務先の情報を共有させて頂きます！！");
  eq(hasOfflineFacts(f), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
