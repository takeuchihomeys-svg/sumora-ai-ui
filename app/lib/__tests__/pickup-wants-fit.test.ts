// app/lib/__tests__/pickup-wants-fit.test.ts
// 2026-10-07 竹内（会話「し」・角田さん 白基調）: 物件ピックアップの束とお客様の要望の合う／合わない（入口の注記・出口の注意）と、内装の色の読み取り
// 実行: npx tsx app/lib/__tests__/pickup-wants-fit.test.ts
import { customerWantsForFit, bundleWantsFit, buildBundleFitNote, findUnmetWantClaims, pickupFitInputFromRow, hasUsableFit } from "../pickup-wants-fit";
import { parseInteriorTone, toneOf, wantsWhiteInterior } from "../interior-tone";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") { if (cond) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); } }

// 会話「し」の生成の時の希望条件（aix_generate_log 2e4bab4a の conditions_snapshot.customer_conditions そのまま）
const SHI_CONDITIONS = "エリア: 瓦屋町\n家賃: 12万円以内\n築年数: 15年以内\nその他: 内装白・築浅・初期費用抑制[必須]\n追加条件: [10/4 19:06|auto] その他: 内装白・築浅・初期費用抑制[必須]、[10/4 21:47|auto] エリア: 瓦屋町";
// AI の下書き（同じ場面）
const SHI_DRAFT = "角田さん夜分遅くに失礼致します！！\n\n瓦屋町周辺全域から内装白・築浅で初期費用を抑えられるお部屋ピックアップさせて頂きました！！\n\nお手隙の際にご査収ください😌！！";
// スタッフが送った文
const SHI_SENT = "角田さんお世話になっております！！\n瓦屋町周辺全域から築浅で初期費用を抑えられるお部屋ピックアップさせて頂きました！！\n瓦屋町周辺で角田さんご希望のご条件に近いお部屋こちら2部屋となります！！\nこちらの2部屋白基調のお部屋では御座いませんが、敷金礼金0円の為初期費用面を抑える事が出来ます！！\nお気に召されたお部屋ご都合よろしいお日にちに全てご案内させて頂きます！！\nお手隙の際にご査収ください😌！！";

console.log("■ 希望条件の読み取り");
{
  const w = customerWantsForFit(SHI_CONDITIONS);
  t("家賃12万円以内", w.rentMax === 120000, String(w.rentMax));
  t("築年数の欄15年（築浅の語より欄が先）", w.ageMax === 15 && w.saidNewish, JSON.stringify(w));
  t("初期費用を抑える", w.initialCost);
  t("白基調（内装白）", w.white);
  const w2 = customerWantsForFit("エリア: 北区\n希望: 築浅");
  t("築年数の欄が無く築浅だけ → 10年", w2.ageMax === 10);
  const w3 = customerWantsForFit("エリア: 北区\n家賃: 6万円〜8万円以内");
  t("家賃の幅は上限を読む", w3.rentMax === 80000, String(w3.rentMax));
  t("白基調の語が無ければ white=false", !w3.white && !w3.initialCost);
}

console.log("■ 白基調の語");
t("白基調", wantsWhiteInterior("【その他こだわりご要望】⇒白基調、お風呂トイレ別"));
t("内装白", wantsWhiteInterior("内装白・築浅"));
t("白い内装", wantsWhiteInterior("白い内装がいい"));
t("白内装", wantsWhiteInterior("こっちの左側で白内装ピックアップ"));
t("白の語だけ（白浜）は当てない", !wantsWhiteInterior("白浜駅の近く"));

console.log("■ 内装の色の答えの読み取り（決定論）");
{
  const opus = parseInteriorTone('{"photos":true,"floor":3,"accent_wall":false}');
  t("床3（明るい木目）→ 白基調ではない（OPUS）", opus?.whiteBased === false);
  const mfpr = parseInteriorTone('前置き {"photos":true,"floor":2,"accent_wall":false} 後ろ');
  t("床2（白に近い）→ 言い切らない null（MFPR）", mfpr !== null && mfpr.whiteBased === null);
  t("床1・アクセントなし → 白基調", toneOf(true, 1, false).whiteBased === true);
  t("床1でも色のある壁 → null", toneOf(true, 1, true).whiteBased === null);
  t("居室の写真なし → null", parseInteriorTone('{"photos":false,"floor":0,"accent_wall":false}')?.whiteBased === null);
  t("読めない → null", parseInteriorTone("わかりません") === null);
  t("床の数が範囲外 → floor null", parseInteriorTone('{"photos":true,"floor":9}')?.floor === null);
}

console.log("■ 束と要望の照合（会話「し」の2部屋の形）");
const opusTone = toneOf(true, 3, false);
const mfprToneNotWhite = toneOf(true, 4, false);
const shiRows = [
  // MFPR コート日本橋イースト 1401（2025年1月築・敷金/礼金なし・105,000円・1DK）
  pickupFitInputFromRow({ property_name: "MFPRコート日本橋イースト", terms: { deposit: 0, keyMoney: 0, buildingAge: 1, newBuild: false } }, { layout: "1DK", rentYen: 105000 }, mfprToneNotWhite),
  // OPUS RESIDENCE SHINSAIBASHI SOUTH 0206（2019年8月築・敷金/礼金なし・124,000円・1DK）
  pickupFitInputFromRow({ property_name: "OPUS RESIDENCE SHINSAIBASHI SOUTH", terms: { deposit: 0, keyMoney: 0, buildingAge: 7, newBuild: false } }, { layout: "1DK", rentYen: 124000 }, opusTone),
];
{
  const fit = bundleWantsFit(shiRows, customerWantsForFit(SHI_CONDITIONS));
  const by = Object.fromEntries(fit.wants.map((x) => [x.key, x]));
  t("2部屋", fit.count === 2);
  t("築浅（15年以内）は合う・根拠は築7年以内", by.age?.verdict === "合う" && by.age?.evidence === "築7年以内", JSON.stringify(by.age));
  t("初期費用（敷金礼金0円）は合う", by.initial_cost?.verdict === "合う" && by.initial_cost?.evidence === "敷金礼金0円");
  t("白基調は合わない（2部屋とも）", by.white?.verdict === "合わない");
  t("家賃12万円以内は一部（OPUS 12.4万）", by.rent?.verdict === "一部", JSON.stringify(by.rent));
  t("共通の良さ: 敷金礼金0円", fit.common.includes("敷金礼金0円"));
  const note = buildBundleFitNote(fit);
  t("注記: 合わない＝白基調", /合わない（2部屋とも）: 白基調の内装/.test(note), note);
  t("注記: スタッフの型「こちらの2部屋白基調のお部屋では御座いませんが、敷金礼金0円の為初期費用面を抑える事が出来ます！！」",
    note.includes("「こちらの2部屋白基調のお部屋では御座いませんが、敷金礼金0円の為初期費用面を抑える事が出来ます！！」"), note);
  t("注記: 件数「こちら2部屋となります」", note.includes("こちら2部屋となります"));
  t("注記: 家賃は書かない側（部屋で違う）", /部屋で違う・資料で分からない（文に書かない）: 家賃12万円以内/.test(note));
  // 出口
  t("出口: 下書き「内装白・築浅で」は注意（合わない要望を合う物として書いた）", findUnmetWantClaims(SHI_DRAFT, fit) !== null);
  t("出口: スタッフの文（白基調では御座いませんが）は注意しない", findUnmetWantClaims(SHI_SENT, fit) === null, String(findUnmetWantClaims(SHI_SENT, fit)));
}

console.log("■ 1部屋が分からない時は言い切らない（MFPR の色が読めない＝2）");
{
  const rows = [pickupFitInputFromRow({ terms: { deposit: 0, keyMoney: 0, buildingAge: 1 } }, null, toneOf(true, 2, false)), shiRows[1]];
  const fit = bundleWantsFit(rows, customerWantsForFit(SHI_CONDITIONS));
  const white = fit.wants.find((x) => x.key === "white");
  t("白基調は一部（合わないと言い切らない）", white?.verdict === "一部", JSON.stringify(white));
  const note = buildBundleFitNote(fit);
  t("注記: 白基調は書かない側", /文に書かない）: [^\n]*白基調/.test(note) && !/では御座いませんが/.test(note), note);
  t("出口: 「内装白」を書いても合わないと決まっていないので注意しない", findUnmetWantClaims(SHI_DRAFT, fit) === null);
}

console.log("■ 設備の照合（行の equipment.match）・照らす物が無い時");
{
  const rows = [
    pickupFitInputFromRow({ terms: { deposit: 1, keyMoney: 0 }, equipment: { match: [{ label: "バス・トイレ別", result: "ok" }, { label: "独立洗面台", result: "ng" }] } }, null),
    pickupFitInputFromRow({ terms: { deposit: 0, keyMoney: 0 }, equipment: { match: [{ label: "バス・トイレ別", result: "ok" }, { label: "独立洗面台", result: "ng" }] } }, null),
  ];
  const fit = bundleWantsFit(rows, customerWantsForFit("エリア: 北区\nその他: 初期費用を抑えたい"));
  const by = Object.fromEntries(fit.wants.map((x) => [x.key, x]));
  t("バス・トイレ別は合う", by["equip:バス・トイレ別"]?.verdict === "合う");
  t("独立洗面台は合わない", by["equip:独立洗面台"]?.verdict === "合わない");
  t("初期費用は一部（敷金1ヶ月の部屋）", by.initial_cost?.verdict === "一部");
  const note = buildBundleFitNote(fit);
  t("合う要望が設備だけ → 型は「〜のお部屋となります」", note.includes("「こちらの2部屋独立洗面台のお部屋では御座いませんが、バス・トイレ別のお部屋となります！！」"), note);
  t("束が空 → 注記なし", buildBundleFitNote(bundleWantsFit([], customerWantsForFit(SHI_CONDITIONS))) === "");
  const none = bundleWantsFit([pickupFitInputFromRow({}, null)], customerWantsForFit("エリア: 北区"));
  t("照らす要望が無い → 注記なし", !hasUsableFit(none) && buildBundleFitNote(none) === "");
}

console.log("■ 礼金ありの束（初期費用は文で「合わない」と言わない）");
{
  const rows = [
    pickupFitInputFromRow({ terms: { deposit: 0, keyMoney: 1, buildingAge: 2 } }, null, toneOf(true, 3, false)),
    pickupFitInputFromRow({ terms: { deposit: 0, keyMoney: 1.5, buildingAge: 13 } }, null, toneOf(true, 3, true)),
  ];
  const fit = bundleWantsFit(rows, customerWantsForFit(SHI_CONDITIONS));
  const note = buildBundleFitNote(fit);
  t("初期費用の外れは注記に載せない（Claude が「敷金礼金0円のお部屋ではなく」と書いた）", !/初期費用/.test(note), note);
  t("型は白基調×築浅「こちらの2部屋白基調のお部屋では御座いませんが、築浅のお部屋となります！！」", note.includes("「こちらの2部屋白基調のお部屋では御座いませんが、築浅のお部屋となります！！」"), note);
  t("出口: 「初期費用を抑えられる」は注意しない", findUnmetWantClaims("北区から築浅で初期費用を抑えられるお部屋ピックアップさせて頂きました！！", fit) === null);
}

console.log("■ 1部屋の時の言い方");
{
  const fit = bundleWantsFit([shiRows[1]], customerWantsForFit(SHI_CONDITIONS));
  const note = buildBundleFitNote(fit);
  t("「こちらのお部屋白基調のお部屋では御座いませんが」・件数の行なし", note.includes("「こちらのお部屋白基調のお部屋では御座いませんが、敷金礼金0円の為初期費用面を抑える事が出来ます！！」") && !note.includes("部屋となります」（実送信"), note);
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
