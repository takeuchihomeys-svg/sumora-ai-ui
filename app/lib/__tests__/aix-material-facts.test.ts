// AIX の文と資料の事実（aix-material-facts.ts）— 実物の文でのテスト
// 実行: npx tsx app/lib/__tests__/aix-material-facts.test.ts
// 2026-09-27 竹内さん「重い順から治す」（YUMA の徹底テスト）
import {
  addressOfPdfText, wardOfPickupRow, wardsInPickupLine, findPickupAreaConflict, buildPickupWardNote,
  moveInFactOfPickup, buildMoveInFactNote, findMoveInClaimConflict, findCheckResultMoveInClaim, hasStaffMoveInClaim,
  sanitizeSentPropertyCount, findCheckStatusContradiction, starHeadBuilding, alignStarHeadToMaterial,
} from "../aix-material-facts";
import { splitPropertyName } from "../customer-state";
import { matchKnownProperty, buildingNumeral } from "../property-name-match";

let pass = 0, fail = 0;
function t(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ""}`); }
}

// YUMA #702 の資料（pdf_text の該当部分そのまま）
const PDF_702 = `物件名 プレサンス難波WEST
号室名 0205（2階部分）
所在地
大阪府大阪市浪速区桜川２丁目3-13
〒556-0022
現況/入居時期 空室 / 相談
賃料
61,940 円
備 考
※入居可能日未定
保証会社加入必須(法人契約は相談)`;

console.log("■ ① 送る物件の区（ピックアップの地域）");
{
  t("資料の所在地", addressOfPdfText(PDF_702) === "大阪府大阪市浪速区桜川２丁目3-13");
  t("保存した区が先", wardOfPickupRow({ location: { ward: "大阪市西区" }, pdf_text: PDF_702 }) === "大阪市西区");
  t("無ければ資料の所在地から", wardOfPickupRow({ location: null, pdf_text: PDF_702 }) === "大阪市浪速区");
  const yuma = "YUMAさん\n\n大阪市北区・福島区から家賃9万円以内・1K、1LDK・駅徒歩10分以内・バストイレ別でYUMAさんにオススメできるお部屋ピックアップさせて頂きました！！\n\nお手隙の際にご査収ください😌！！";
  t("文の区（北区・福島区）", JSON.stringify(wardsInPickupLine(yuma)) === JSON.stringify(["大阪市北区", "大阪市福島区"]), wardsInPickupLine(yuma));
  const n = findPickupAreaConflict(yuma, ["大阪市西区", "大阪市西区", "大阪市大正区"]);
  t("YUMA 03:41: 送った物件（西区・大正区）が1件も入っていない → 注意", !!n && n.includes("西区・大正区"), n);
  t("1件でも入っていれば注意しない", findPickupAreaConflict(yuma, ["大阪市西区", "大阪市北区"]) === null);
  t("物件の区が分からなければ何も言わない", findPickupAreaConflict(yuma, [null, null]) === null);
  const st = "YUMAさん\n\n難波・桜川周辺から1Kでオススメできるお部屋ピックアップさせて頂きました！！";
  t("文に区が無い（駅名だけ）なら何も言わない", findPickupAreaConflict(st, ["大阪市西区"]) === null);
  const note = buildPickupWardNote(["大阪市西区", "大阪市西区", null, "大阪市大正区"], 4);
  t("生成に渡す一文（区ごとの件数・分かった件数）", note.includes("西区2件・大正区") && note.includes("3/4件"), note);
  t("区が1つも分からなければ空", buildPickupWardNote([null], 1) === "");
}

console.log("■ ② 入居時期（即入居）");
{
  const f = moveInFactOfPickup({ pdf_text: PDF_702 });
  t("#702: 資料の文字のまま（空室 / 相談・※入居可能日未定）", !!f && f.lines.includes("現況/入居時期 空室 / 相談") && f.lines.some((l) => l.includes("入居可能日未定")) && f.immediate === false, f);
  const sent = "🌟プレサンス難波WEST 0205\n\n家賃6万円台の1Kで、YUMAさんにかなりオススメ出来るお部屋となります！！\n\n家賃61,940円・管理費10,060円の家賃管理費込72,000円と毎月の費用をしっかり抑えられ、空室のため即入居可能なお部屋となります！！";
  t("YUMA 03:47 の送った文 → 注意", !!findMoveInClaimConflict(sent, f));
  const imm = moveInFactOfPickup({ image_lines: ["現況: 空室", "入居可能日: 即入"] });
  t("資料が即入なら注意しない（d25e07d1 9/8）", imm?.immediate === true && findMoveInClaimConflict("・空室のため即入居可能", imm) === null);
  const consult = moveInFactOfPickup({ image_lines: ["現況: 空室 / 相談", "入居可能日: 相談"] });
  t("資料が相談（ab7ea742 9/25 の実送信）→ 注意", !!findMoveInClaimConflict("敷金礼金なしのため初期費用をかなり抑えてご入居頂けます！！空室のため即入居可能です！！", consult));
  t("即入 と 未定 が並ぶ時は即入居にしない", moveInFactOfPickup({ image_lines: ["現況: 空室 / 即入", "入居可能日: 未定"] })?.immediate === false);
  t("資料の入居時期が分からなければ何も言わない", moveInFactOfPickup({}) === null && findMoveInClaimConflict(sent, null) === null);
  t("terms だけの時は種類で決める", moveInFactOfPickup({ terms: { moveIn: { kind: "immediate", current: "vacant" } } })?.immediate === true);
  t("生成に渡す一文（即入居の記載なし）", buildMoveInFactNote(f).includes("即入居の記載は無い"));
  const chk = "YUMAさん\n\nプレサンス難波WEST 0205号室の募集状況確認させて頂きましたところ、現在も募集中のお部屋となります！！\n\n空室のため即入居可能ですので、お気に召されましたらいつでもお気軽にご連絡ください😊！！";
  t("YUMA 04:18 物件確認した: 入力に根拠が無い即入居 → 注意", !!findCheckResultMoveInClaim(chk, ["", ""]));
  t("入居可能日の入力に即入居があれば注意しない", findCheckResultMoveInClaim(chk, ["即入居可"]) === null);
  t("即入居の無い文は何も言わない", findCheckResultMoveInClaim("プレサンス難波WEST 0205号室現在募集中となります！！", []) === null);
  t("履歴のこちらの文の即入居を見つける", hasStaffMoveInClaim([{ sender: "staff", text: sent }]) && !hasStaffMoveInClaim([{ sender: "customer", text: "即入居できますか？" }]));
  t("「即入力」は即入居ではない", findCheckResultMoveInClaim("お手数ですが即入力お願いします", []) === null);
}

console.log("■ ③ 物件確認した（募集中）の件数と状態");
{
  t("送られた物件数は 1〜5 だけ", sanitizeSentPropertyCount(3) === 3 && sanitizeSentPropertyCount(53) === null && sanitizeSentPropertyCount(0) === null && sanitizeSentPropertyCount("2") === null && sanitizeSentPropertyCount(2.5) === null);
  const yuma = "YUMAさん\nRainbow Court 立売堀の募集状況を確認しましたが、現在募集に出ていないお部屋となります。\nお送りいただいた他の52件につきましても、いずれも募集終了（申込済み・募集に出ていない）のお部屋でございます。\nYUMAさんにご満足頂けるお部屋が見つかるまで、引き続き新着でピックアップしてお送りさせて頂きます！！";
  const base = { pattern: "available", statuses: ["available"], propertyCount: 1 };
  t("YUMA 04:40（名前も別の物件）→ 止める", !!findCheckStatusContradiction(yuma, { ...base, endedCount: 0, propertyNames: ["エステムコート大阪WEST"] }));
  t("YUMA 04:40（名前が合う時）→ 止める", !!findCheckStatusContradiction(yuma, { ...base, endedCount: null, propertyNames: ["Rainbow Court 立売堀 307"] })?.includes("Rainbow"));
  t("他52件（入力は残り0）→ 止める", !!findCheckStatusContradiction("こちら募集中となります！！\nお送りいただいた他の52件は募集終了となります。", { ...base, endedCount: 0 }));
  // 実送信 8a77820b 9/26（固定の型・2行に割れる）
  const ok1 = "みことさんお送りいただきました物件の中で\nレジュールアッシュ北大阪 GRAND STAGE 別号室が206号室現在募集中となります！！\n最大限割引しました御見積書同封させて頂きました！！\n\nみことさんお送りいただきました他1件は\n募集終了しているお部屋となります。";
  t("他1件は（2行）・入力の残り1件 → 止めない", findCheckStatusContradiction(ok1, { ...base, endedCount: 1, propertyNames: ["レジュールアッシュ北大阪 GRAND STAGE"] }) === null);
  // 実送信 b50fd451 9/20・5752c0d1 9/10: 確認した物件でない部屋の募集終了は正しい報告
  const ok2 = "まりあさんお世話になっております！！\nお送り頂きました3件の物件確認させて頂きましたところ、こちらの2部屋現在募集中となっております！！\n\n松屋町1LDK2階のお部屋は募集終了しております！！";
  t("確認した物件でない部屋の募集終了 → 止めない", findCheckStatusContradiction(ok2, { pattern: "available", statuses: ["available", "available"], propertyCount: 2, endedCount: null, propertyNames: ["アーバネックス松屋町", "リーガル谷町"] }) === null);
  const ok3 = "友哉さん\nお送りいただきました物件の中で\nジーメゾン泉佐野ルシエール303号室現在募集中となります！！\n1階のお部屋は募集に出ておりませんでした。";
  t("1階のお部屋は募集に出ておりませんでした → 止めない", findCheckStatusContradiction(ok3, { ...base, endedCount: null, propertyNames: ["ジーメゾン泉佐野ルシエール 303"] }) === null);
  const applied = "SHANNON 303号室現在募集中となります！！\n・SHANNON は既に1件お申込みが入っており2番手以降でのお申込みが可能です！！";
  t("申込ありにしていない物件の番手 → 止める", !!findCheckStatusContradiction(applied, { ...base, endedCount: null, propertyNames: ["SHANNON 303号室"] }));
  t("物件ごとの申込あり（unavailable）なら止めない", findCheckStatusContradiction(applied, { ...base, statuses: ["unavailable"], endedCount: null, propertyNames: ["SHANNON 303号室"] }) === null);
  t("旧画面の全体の申込状況（available_application=yes）なら止めない", findCheckStatusContradiction(applied, { ...base, endedCount: null, propertyNames: ["SHANNON 303号室"], anyAppliedFlag: true }) === null);
  t("物件確認した・募集中 以外のピッカーは見ない", findCheckStatusContradiction(yuma, { ...base, pattern: "unavailable", endedCount: 0 }) === null);
  t("状態の入力が無ければ何も言わない", findCheckStatusContradiction(yuma, { pattern: "available", statuses: [], propertyCount: 1, endedCount: 0 }) === null);
}

console.log("■ ⑤ 照合の辞書: 「🌟建物 0205」");
{
  t("号室の字の無い題名から建物名", starHeadBuilding("🌟プレサンス難波WEST 0205\n\n家賃6万円台") === "プレサンス難波WEST");
  t("英字付きの号室", starHeadBuilding("🌟ミカーサ 005B\n\n…") === "ミカーサ");
  t("号室の無い題名（建物名が数字で終わる）は取らない", starHeadBuilding("🌟リーダースパーク21\n\n…") === null);
}

console.log("■ ⑤' 照合: 建物の末尾の番号が違えば寄せない（監査で見つけた誤照合）");
{
  t("ドミール桜川III ↔ II は寄せない（旧は 1.00）", matchKnownProperty("ドミール桜川III", ["ドミール桜川II"]) === null);
  t("H-maison平野III ↔ Ⅲ は寄せる", matchKnownProperty("H-maison平野III", ["H-maison平野Ⅲ"])?.name === "H-maison平野Ⅲ");
  t("エステート松松Ⅲ ↔ エステート松尾 は寄せない", matchKnownProperty("エステート松松Ⅲ", ["エステート松尾"]) === null);
  t("グロウス ↔ グロウスⅡ は別", matchKnownProperty("アドバンス大阪グロウス", ["アドバンス大阪グロウスⅡ"]) === null);
  t("誤読の寄せは続ける（エグゼ大阪CITYアイシズ → アインツ）", matchKnownProperty("エグゼ大阪CITYアイシズ", ["エグゼ大阪CITYアインツ"])?.name === "エグゼ大阪CITYアインツ");
  t("英字に続く I は番号にしない（willDo難波wⅠ）", buildingNumeral("willDo難波wⅠ") === "" && buildingNumeral("ハーモニーテラス瑞光Ⅱ") === "2");
}

console.log("■ ⑥ 状況の表示は資料の文字のまま（照合の鍵は揃える）");
{
  const a = splitPropertyName("プレサンス難波WEST", "0205");
  t("0205 → 表示は 0205号室・鍵は 205", a?.display === "プレサンス難波WEST 0205号室" && a.room === "205", a);
  const b = splitPropertyName("エステムコート大阪WESTⅡ 801号室");
  t("Ⅱ はそのまま（鍵は II と同じ）", b?.display === "エステムコート大阪WESTⅡ 801号室" && b.buildingKey === splitPropertyName("エステムコート大阪WESTII 801号室")?.buildingKey, b);
  const c = splitPropertyName("🌟ミカーサ 005B");
  t("英字付き 005B", c?.display === "ミカーサ 005B号室" && c.room === "5B", c);
  const d = splitPropertyName("【1】ジュネスニッコー 1003号室");
  t("先頭の番号は外す", d?.display === "ジュネスニッコー 1003号室", d);
}


// ⑥ 物件オススメの見出しを資料の物件名に（2026-09-30 YUMA の実物: 資料「プレサンス天神橋筋六丁目ヴォワール」→ 本文「筋」落ち）
{
  const gen = "🌟プレサンス天神橋六丁目ヴォワール 603号室\n\n敷金礼金なし・家賃管理費込77,000円の1Kで、YUMAさんにかなりオススメ出来るお部屋となります！！";
  const r = alignStarHeadToMaterial(gen, { propertyName: "プレサンス天神橋筋六丁目ヴォワール" });
  t("⑥ 筋が落ちた見出しを資料の字に", r.changed && r.text.split("\n")[0] === "🌟プレサンス天神橋筋六丁目ヴォワール 603号室", r);
  t("⑥ 本文は変えない", r.text.split("\n").slice(1).join("\n") === gen.split("\n").slice(1).join("\n"));
  const r2 = alignStarHeadToMaterial("🌟S-RESIDENCE天満Gracis 304\n\n本文", { propertyName: "S-RESIDENCE天満Gracis" });
  t("⑥ 同じなら何もしない", !r2.changed && r2.text === "🌟S-RESIDENCE天満Gracis 304\n\n本文");
  const r3 = alignStarHeadToMaterial("🌟エステムコート難波サウスプレイスVIラグジー 0805\n本文", { propertyName: "エステムコート難波サウスプレイスⅥラグジー" });
  t("⑥ VI→Ⅵ（資料の字）", r3.changed && r3.text.startsWith("🌟エステムコート難波サウスプレイスⅥラグジー 0805"), r3);
  const r4 = alignStarHeadToMaterial("🌟エステムコート難波サウスプレイスⅣラグジー 0805\n本文", { propertyName: "エステムコート難波サウスプレイスⅥラグジー" });
  t("⑥ 行 ID＝その資料なので Ⅳ の読み違いも資料の Ⅵ に", r4.changed && r4.text.startsWith("🌟エステムコート難波サウスプレイスⅥラグジー 0805"), r4);
  const r5 = alignStarHeadToMaterial("🌟スプランディッド本町グラン 1002\n本文", { propertyName: "アーバネックス堺筋本町" });
  t("⑥ 似ていない名前は直さず注意", !r5.changed && !!r5.mismatch, r5);
  const r6 = alignStarHeadToMaterial("🌟ORSUS大阪福島 0506号室\n本文", { propertyName: "ORSUS大阪福島(旧リヴェント福島)" });
  t("⑥ 括弧の旧名が落ちた見出しは資料の字に", r6.changed && r6.text.startsWith("🌟ORSUS大阪福島(旧リヴェント福島) 0506号室"), r6);
  const r7 = alignStarHeadToMaterial("🌟L-IDEA MINAMIHORIE 405号室\n\n敷金礼金なし",{ propertyName: "L-IDEA　MINAMIHORIE（リデア南堀江）" });
  t("⑥ ITANDI の実物: 括弧の読みがなが落ちた見出しを資料の字に（全角空白も資料のまま）", r7.changed && r7.text.startsWith("🌟L-IDEA　MINAMIHORIE（リデア南堀江） 405号室"), r7);
  t("⑥ 🌟の見出しが無ければ何もしない", !alignStarHeadToMaterial("本文だけ", { propertyName: "X" }).changed);
  t("⑥ 号室の無い見出しは触らない", !alignStarHeadToMaterial("🌟プレサンス天神橋六丁目ヴォワール\n本文", { propertyName: "プレサンス天神橋筋六丁目ヴォワール" }).changed);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
