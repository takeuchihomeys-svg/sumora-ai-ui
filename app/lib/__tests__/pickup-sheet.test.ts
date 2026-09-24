// 2026-09-24 竹内「2つの型でプロンプトキャッシュ」「必要な所だけ切り出す・表の文字は文字層」「物件と一致しているか・食い違いは要確認」
//   「物件ごとに保存し、2回目以降は画像を読み直さない（希望との照合は文字だけ）」— 型・切り出し・固定の前置き・突き合わせ・照合の純関数のテスト
// 実行: npx tsx app/lib/__tests__/pickup-sheet.test.ts
// 文字層・画像の位置は 2026-09-24 の実物（property_pickups id 3・35・38・45 のリアプロ資料・物件の情報だけ。お客様の情報は無い）
import { createHash } from "node:crypto";
import { detectSheetType, planSheetCrop, padBox, toPixelRect, REALPRO_SLOTS, ITANDI_SLOTS, type NormBox } from "../sheet-layout";
import { sheetPromptPrefix, SHEET_COMMON_HEAD, SHEET_TYPE_SECTIONS, buildSheetReadContent, parseSheetImageFacts, SHEET_PROMPT_VERSION, SHEET_READ_MAX_TOKENS, buildWantsJudgePrompt, WANTS_JUDGE_HEAD, type SheetImageFacts } from "../sheet-prompt";
import { parseSheetText, unitKeyOf, checkSheetConsistency, matchWantsWithFacts, describeFacts, roomKindOf } from "../sheet-facts";
import { extractImageWants, type ImageWant } from "../image-wants";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ""}`); }
}

// ── 実物の文字層（1ページ目・抜粋。会社の帯と特記事項の一部を含む） ──
const TEXT_ABELIA = `9672316
出力日:2026/09/24 10:51:08 / 次回更新予定日:2026/10/08 ※掲載情報は随時更新される場合がございます。 Powered by RealNetPro co.,ltd.
※ この資料は物件の概略紹介資料になります。写真、間取図面、設備、概要などが現況と異なる場合は現況優先となります。
物件種目 [住居用] マンション
物件名 Abelia(アベリア)
号室名 301号室（3階部分）
所在地
大阪府大阪市平野区加美東４丁目21-3
〒547-0002
建築構造 鉄骨造 地上5階 総戸数19戸
間取タイプ 1LDK[LDK11.9 x 洋4.4]
専有面積 39.13㎡ 開口部方位 北
賃料
83,000 円
共益費・管理費 8,000円
備 考
【備考】
クリーニング特約有 短期違約金有 ペット可(小型犬か猫どちらか1匹迄)
インターネット無料
設 備
【位置】 角部屋 【キッチン】 IHクッキングヒーター（3口以上）・システ
ムキッチン・カウンターキッチン 【水廻り】 洗面台（独立）・浴室乾燥機
・シャワートイレ・バス・トイレ別・洗濯機置場（室内） 【冷暖房】 エア
コン（冷暖房） 【収納】 シューズボックス 【セキュリティ】 オートロック
条 件
【条件】 ペット相談・保証人不要・保証会社利用必須
取引態様：媒介
特記事項：
保証会社：保証会社利用必須`;
const SUMMARY_ABELIA = "【3】Abelia(アベリア)\n83,000円 8,000円\n1LDK 39.13㎡";

const TEXT_AGREA = `8738195
Powered by RealNetPro co.,ltd.
※ この資料は物件の概略紹介資料になります。写真、間取図面、設備、概要などが現況と異なる場合は現況優先となります。
物件種目 [住居用] マンション
物件名 エスリード難波AGREA
号室名 1107（11階部分）
所在地
大阪府大阪市浪速区大国３丁目2-23
間取タイプ 1K
専有面積 21.83㎡ 開口部方位 北
賃料
76,300 円
備 考
眺望良好・前面棟無・角住戸(角地)・2F以上・ガスキッチン・脱衣所・洗面化粧台・洗面所・洗面所独立・洗面所にドア・クロゼット
設 備
【キッチン】 給湯器（ガス）・ガスコンロ 【水廻り】 風呂・トイレ・洗
面台・浴室乾燥機・シャワートイレ・バス・トイレ別・洗濯機置場（室内）
【収納】 シューズボックス 【放送・通信】 ネット使用料不要 【セキュリティ】 オ
ートロック・宅配BOX
条 件
【条件】 ペット相談・保証人不要・保証会社利用必須
取引態様：媒介
特記事項：
・1年未満は総賃料の2ヶ月分の短期解約違約金有り`;
const SUMMARY_AGREA = "【4】エスリード難波AGREA\n76,300円 8,000円\n1K 21.83㎡\nAD 2ヶ月";

// ── 1. 型の見分け ──
{
  t("★ 型: site=realpro はリアプロ", detectSheetType({ site: "realpro" }).type === "realpro");
  t("★ 型: site=itandi は itandi", detectSheetType({ site: "itandi" }).type === "itandi");
  t("★ 型: site=reins は型なし（1ページ全体）", detectSheetType({ site: "reins" }).type === "unknown");
  t("★ 型: site が無く PDF の URL が realnetpro → リアプロ", JSON.stringify(detectSheetType({ site: null, pdfUrl: "https://www.realnetpro.com/common/factsheet.php?id=1" })) === JSON.stringify({ type: "realpro", by: "url" }));
  t("★ 型: site も URL も無い → 文字層の目印でリアプロ", JSON.stringify(detectSheetType({ pageText: TEXT_ABELIA })) === JSON.stringify({ type: "realpro", by: "text" }));
  t("★ 型: itandi の目印（敷引/償却・主要採光面・入居可能時期）", detectSheetType({ pageText: "賃料 敷引/償却 主要採光面 南 入居可能時期 即" }).type === "itandi");
  t("★ 型: 何も無ければ unknown", detectSheetType({}).type === "unknown");
}

// ── 2. 切り出し（描画命令の実物の位置） ──
const BG: NormBox = { x: 0, y: 0, w: 1.003, h: 1.003 };
const EXT: NormBox = { x: 0.343, y: 0.023, w: 0.184, h: 0.261 };
const FLOOR: NormBox = { x: 0.343, y: 0.296, w: 0.255, h: 0.362 };
const MAP: NormBox = { x: 0.604, y: 0.296, w: 0.341, h: 0.362 };
const cell = (x: number, y: number): NormBox => ({ x, y, w: 0.089, h: 0.126 });
{
  // id 38（写真8枚）
  const boxes = [BG, EXT, cell(0.533, 0.023), cell(0.628, 0.023), cell(0.723, 0.023), cell(0.817, 0.023), cell(0.533, 0.158), cell(0.628, 0.158), cell(0.723, 0.158), cell(0.817, 0.158), FLOOR, MAP];
  const p = planSheetCrop("realpro", boxes, 0.706);
  t("★ リアプロ標準: 間取り図の枠を切る（描画命令で確かめた）", p.mode === "floor" && p.basis === "drawn" && p.reason === null, p);
  t("★ リアプロ標準: 余白は各辺 0.003（左の表・右の地図に入らない）", Math.abs(p.rect.x - 0.340) < 1e-9 && Math.abs(p.rect.x + p.rect.w - 0.601) < 1e-9 && p.rect.x + p.rect.w < MAP.x, p.rect);
  t("★ リアプロ標準: 室内写真のマス（記録用）は写真の範囲に収まる", !!p.photos && p.photos.x >= REALPRO_SLOTS.photos.x - 0.004 && p.photos.x + p.photos.w <= REALPRO_SLOTS.photos.x + REALPRO_SLOTS.photos.w + 0.004, p.photos);
  // id 36（写真1枚）も同じ枠
  t("★ リアプロ写真1枚（id 36）でも間取り図の枠", planSheetCrop("realpro", [BG, EXT, cell(0.533, 0.023), FLOOR, MAP], 0.706).mode === "floor");
  // 別の形（キャッチコピー付きで間取り図が大きい）→ 間取り図の位置に画像が無い → 1ページ全体
  const other = planSheetCrop("realpro", [BG, { x: 0.30, y: 0.25, w: 0.40, h: 0.50 }, MAP], 0.706);
  t("★ リアプロ別の形: 間取り図の位置に画像が無ければ1ページ全体（切り出さない）", other.mode === "page" && other.basis === "page" && !!other.reason, other);
  t("★ リアプロ: 地図が無い形も1ページ全体", planSheetCrop("realpro", [BG, EXT, FLOOR], 0.706).mode === "page");
  t("★ リアプロ: 描画命令が無い（画像から）時は1ページ全体", planSheetCrop("realpro", null, 0.706).mode === "page");
}
{
  const fixed = planSheetCrop("itandi", null, 0.707);
  t("★ itandi 画像だけ: 画像の範囲（x .010〜.505・y .085〜.82）を測った比率で", fixed.mode === "image_area" && fixed.basis === "fixed" && Math.abs(fixed.rect.x - (ITANDI_SLOTS.imageArea.x - 0.003)) < 1e-9 && fixed.rect.x + fixed.rect.w <= 0.51, fixed.rect);
  t("★ itandi 画像だけ: 縦向きの資料には当てない（1ページ全体）", planSheetCrop("itandi", null, 1.41).mode === "page");
  const drawn = planSheetCrop("itandi", [BG, { x: 0.015, y: 0.093, w: 0.241, h: 0.355 }, { x: 0.26, y: 0.093, w: 0.24, h: 0.355 }, { x: 0.52, y: 0.1, w: 0.4, h: 0.3 }], 0.707);
  t("★ itandi 描画命令あり: 左半分の画像をまとめて切る（右の表の画像は入れない）", drawn.mode === "image_area" && drawn.basis === "drawn" && drawn.rect.x + drawn.rect.w < 0.51, drawn.rect);
  t("★ itandi 描画命令あり・範囲の画像がロゴだけ（小さすぎる）→ 1ページ全体（反証 2026-09-24）", planSheetCrop("itandi", [BG, { x: 0.02, y: 0.09, w: 0.05, h: 0.04 }], 0.707).mode === "page");
  t("★ itandi 描画命令あり・左に画像が無い → 1ページ全体", planSheetCrop("itandi", [BG, { x: 0.6, y: 0.1, w: 0.3, h: 0.3 }], 0.707).mode === "page");
  t("★ 型不明 → 1ページ全体", planSheetCrop("unknown", [BG, FLOOR, MAP], 0.707).mode === "page");
  t("★ 余白はページの外に出ない", JSON.stringify(padBox({ x: 0, y: 0, w: 1, h: 1 })) === JSON.stringify({ x: 0, y: 0, w: 1, h: 1 }));
  const px = toPixelRect({ x: 0.34, y: 0.293, w: 0.261, h: 0.368 }, 2580, 1822);
  t("★ 画素に直す（整数・画像の中）", px.x === 877 && px.y === 533 && px.x + px.width <= 2580 && px.y + px.height <= 1822, px);
}

// ── 3. 固定の前置き（キャッシュ） ──
{
  const modes = ["floor", "image_area", "page"] as const;
  t("★ 前置き: 3つとも共通の頭（役割・返す形・間違えやすい所）で始まる＝型の間でキャッシュを共有", modes.every((m) => sheetPromptPrefix(m).startsWith(SHEET_COMMON_HEAD)));
  t("★ 前置き: 呼ぶたびに一字一句同じ", modes.every((m) => sheetPromptPrefix(m) === sheetPromptPrefix(m)));
  t("★ 前置き: 日時・時刻が入っていない", modes.every((m) => !/\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}:\d{2}/.test(sheetPromptPrefix(m))));
  t("★ 前置き: お客様の希望（W1…）を入れない（画像から読むのは物件の事実だけ）", modes.every((m) => !/W\d|お客様の希望/.test(sheetPromptPrefix(m))));
  const c = buildSheetReadContent("floor", "data:image/jpeg;base64,AAAA");
  t("★ 並び: 文（前置き）→ 画像。画像を先頭にしない", c.length === 2 && c[0].type === "text" && c[1].type === "image_url");
  // 固定の前置きを変えたら、このハッシュと SHEET_PROMPT_VERSION（保存した読み取りの版）を一緒に上げる
  const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
  const pinned = { common: "89fc081db80aea0c", floor: "ac969cc77efdcf38", image_area: "da5ce53b858e5cd6", page: "5907930b2c29915a" };
  const now = { common: h(SHEET_COMMON_HEAD), floor: h(sheetPromptPrefix("floor")), image_area: h(sheetPromptPrefix("image_area")), page: h(sheetPromptPrefix("page")) };
  t(`★ 前置きの固定（変えたら SHEET_PROMPT_VERSION=${SHEET_PROMPT_VERSION} も上げる）`, JSON.stringify(now) === JSON.stringify(pinned), now);
  t("★ 型の説明は3つ（リアプロ・itandi・1ページ全体）", Object.keys(SHEET_TYPE_SECTIONS).length === 3);
  t("★ 推論なしの上限は 600（実測の出力 120〜171）", SHEET_READ_MAX_TOKENS === 600);
  const jp = buildWantsJudgePrompt("{}", "W1【会話】洋室が広め");
  t("★ 文字だけの照合も固定の頭が先頭・希望は後ろ", jp.startsWith(WANTS_JUDGE_HEAD) && jp.indexOf("W1【会話】") > WANTS_JUDGE_HEAD.length);
}

// ── 4. 返事の読み方 ──
{
  const f = parseSheetImageFacts('```json\n{"see":"中央の間取り図","fp_ok":true,"other_unit":false,"madori":"１ＬＤＫ","rooms":[{"name":"LDK","jo":"11.9"},{"name":"洋室","jo":4.4}],"area_sqm":null,"type_label":"","kitchen":{"placement":"対面","stove":"IH","burners":3},"water":{"bath_toilet":"別","washbasin":"独立","laundry":"室内"},"living_bedroom":"隣接","storage":{"wic":"なし","closets":1,"shoes":"あり"},"balcony":"あり","note":""}\n```');
  t("★ 返事: コードブロックの JSON・全角の間取り・文字の帖数を読む", !!f && f.madori === "1LDK" && f.rooms[0].jo === 11.9 && f.kitchen.placement === "対面" && f.storage.closets === 1, f);
  const g = parseSheetImageFacts('{"fp_ok":true,"madori":"1SLDK","kitchen":{"placement":"キッチン"},"water":{"bath_toilet":"たぶん別"},"living_bedroom":"離れている"}');
  t("★ 返事: 選択肢に無い値は「不明」（2026-09-24 写真の帯を足すと placement=キッチン が返った）", !!g && g.kitchen.placement === "不明" && g.water.bath_toilet === "不明" && g.living_bedroom === "不明" && g.madori === "1LDK", g);
  t("★ 返事: 壊れた返事は null", parseSheetImageFacts("読めませんでした") === null && parseSheetImageFacts("{壊れ") === null);
  t("★ 返事: fp_ok は true の時だけ true", parseSheetImageFacts('{"fp_ok":"yes"}')?.fp_ok === false);
}

// ── 5. 文字層 ──
{
  const a = parseSheetText(TEXT_ABELIA);
  t("★ 文字層: 物件名・号室・階・所在地", a.name === "Abelia(アベリア)" && a.roomNo === "301" && a.floor === 3 && a.address === "大阪府大阪市平野区加美東4丁目21-3", a);
  t("★ 文字層: 間取タイプ 1LDK と帖数 LDK11.9・洋4.4", a.madori === "1LDK" && JSON.stringify(a.jo) === JSON.stringify([{ kind: "LDK", jo: 11.9 }, { kind: "洋", jo: 4.4 }]), a.jo);
  t("★ 文字層: 専有面積・賃料・方位", a.areaSqm === 39.13 && a.rentYen === 83000 && a.direction === "北");
  t("★ 文字層: 設備の文は改行で切れた語もつながる（「システ／ムキッチン」）", a.features.includes("システムキッチン") && a.features.includes("バス・トイレ別"), a.features.slice(0, 200));
  t("★ 文字層: 上の注意書き「写真、間取図面、設備、概要…」の「設備」を見出しにしない", !a.features.includes("概略紹介"));
  t("★ 文字層: 特記事項（保証会社）は設備の文に入れない", !a.features.includes("保証会社利用必須 ") || !a.features.includes("特記事項"));
  const g = parseSheetText(TEXT_AGREA);
  t("★ 文字層: 号室 1107・11階・帖数なし", g.roomNo === "1107" && g.floor === 11 && g.jo.length === 0 && g.madori === "1K");
  t("★ 文字層: 1K[洋室7帖]（id 45 の形）", JSON.stringify(parseSheetText(TEXT_AGREA.replace("間取タイプ 1K", "間取タイプ 1K[洋室7帖]")).jo) === JSON.stringify([{ kind: "洋", jo: 7 }]));
  t("★ 文字層: 空・短い文字は hasText=false", parseSheetText("").hasText === false && parseSheetText("abc").hasText === false);
  t("★ 物件の鍵: 物件名＋号室＋所在地（0404 と 404 は同じ）", unitKeyOf(g) === unitKeyOf({ name: "エスリード難波AGREA", roomNo: "01107", address: "大阪府大阪市浪速区大国3丁目2-23", madori: g.madori, areaSqm: g.areaSqm }) && !!unitKeyOf(g));
  t("★ 物件の鍵: 一般名（物件）は鍵にしない", unitKeyOf({ name: "物件", roomNo: "101", address: "大阪府" }) === null);
  t("★ 物件の鍵: 号室も所在地も無ければ鍵にしない", unitKeyOf({ name: "エスリード難波AGREA", roomNo: null, address: null }) === null);
  // 反証（2026-09-24）: 号室が無い資料で、同じ建物の別の型の部屋の読み取りを使い回さない
  t("★ 物件の鍵: 号室が無くても間取り・面積が違えば別の鍵", unitKeyOf({ name: "エスリード難波AGREA", roomNo: null, address: "大阪府大阪市", madori: "1K", areaSqm: 21.09 }) !== unitKeyOf({ name: "エスリード難波AGREA", roomNo: null, address: "大阪府大阪市", madori: "1LDK", areaSqm: 30.5 }));
  t("★ 物件の鍵: 同じ号室でも資料が差し替わり面積が変われば別の鍵", unitKeyOf({ ...g, areaSqm: 25.5 }) !== unitKeyOf(g));
  t("★ 部屋の種類", roomKindOf("LDK") === "LDK" && roomKindOf("洋室") === "洋" && roomKindOf("和室") === "和" && roomKindOf("K") === "K" && roomKindOf("寝室") === "洋");
}

// ── 6. 突き合わせ（要確認） ──
const IMG = (over: Partial<SheetImageFacts> = {}): SheetImageFacts => ({
  see: "", fp_ok: true, other_unit: false, madori: "1LDK", rooms: [{ name: "LDK", jo: 11.9 }, { name: "洋室", jo: 4.4 }], area_sqm: null, type_label: "",
  kitchen: { placement: "対面", stove: "IH", burners: null }, water: { bath_toilet: "別", washbasin: "独立", laundry: "室内" },
  living_bedroom: "隣接", storage: { wic: "なし", closets: 1, shoes: "あり" }, balcony: "あり", note: "", ...over,
});
{
  const a = parseSheetText(TEXT_ABELIA);
  t("★ 一致: 実物（Abelia・説明文・読んだ図）は ok", checkSheetConsistency({ summary: SUMMARY_ABELIA, text: a, image: IMG() }).status === "ok", checkSheetConsistency({ summary: SUMMARY_ABELIA, text: a, image: IMG() }));
  t("★ 一致: 実物（AGREA・図なし＝文字だけ）は ok", checkSheetConsistency({ summary: SUMMARY_AGREA, text: parseSheetText(TEXT_AGREA), image: null }).status === "ok");
  const wrongPdf = checkSheetConsistency({ summary: SUMMARY_AGREA, text: a, image: null });
  t("★ まとめ PDF のずれ: 説明文と資料の物件名・賃料・面積・間取りが違う → 要確認", wrongPdf.status === "要確認" && wrongPdf.reasons.some((r) => r.includes("物件名")) && wrongPdf.reasons.some((r) => r.includes("賃料")), wrongPdf);
  const sameBldg = checkSheetConsistency({ summary: "【5】エスリード難波AGREA\n73,100円 8,000円\n1K 21.09㎡", text: parseSheetText(TEXT_AGREA), image: null });
  t("★ 同じ建物の別の部屋の資料（賃料・面積が違う）→ 要確認", sameBldg.status === "要確認" && sameBldg.reasons.length >= 2 && !sameBldg.reasons.some((r) => r.includes("物件名")), sameBldg);
  const twoPages = parseSheetText(`${TEXT_ABELIA}\n${TEXT_AGREA}`);
  t("★ 1ページ目と2ページ目の物件名・号室が違う → 要確認", checkSheetConsistency({ text: twoPages }).reasons.filter((r) => r.includes("資料の中で")).length === 2);
  t("★ 間取り図が無い（fp_ok=false）→ 要確認", checkSheetConsistency({ summary: SUMMARY_ABELIA, text: a, image: IMG({ fp_ok: false, see: "外観写真だけ" }) }).status === "要確認");
  t("★ 別の部屋の図（other_unit）→ 要確認", checkSheetConsistency({ summary: SUMMARY_ABELIA, text: a, image: IMG({ other_unit: true }) }).status === "要確認");
  t("★ 読んだ間取り 2LDK ≠ 資料 1LDK → 要確認", checkSheetConsistency({ summary: SUMMARY_ABELIA, text: a, image: IMG({ madori: "2LDK" }) }).reasons.some((r) => r.includes("読んだ間取り")));
  t("★ 帖数 0.3 以内は ok（11.9 と 12.2）", checkSheetConsistency({ summary: SUMMARY_ABELIA, text: a, image: IMG({ rooms: [{ name: "LDK", jo: 12.2 }, { name: "洋室", jo: 4.4 }] }) }).status === "ok");
  t("★ 帖数 0.3 を超えて違う（11.9 と 12.3）→ 要確認", checkSheetConsistency({ summary: SUMMARY_ABELIA, text: a, image: IMG({ rooms: [{ name: "LDK", jo: 12.3 }, { name: "洋室", jo: 4.4 }] }) }).status === "要確認");
  const big = checkSheetConsistency({ summary: SUMMARY_AGREA, text: parseSheetText(TEXT_AGREA), image: IMG({ madori: "1K", rooms: [{ name: "洋室", jo: 14 }] }) });
  t("★ 帖数の合計×1.62 が専有面積を超える（別の広い部屋の図）→ 要確認", big.status === "要確認" && big.reasons.some((r) => r.includes("より広い")), big);
  t("★ 図の中の㎡ が専有面積と違う → 要確認", checkSheetConsistency({ summary: SUMMARY_ABELIA, text: a, image: IMG({ area_sqm: 68.84 }) }).status === "要確認");
  t("★ 1K の図で 6.1帖（21.83㎡）は ok", checkSheetConsistency({ summary: SUMMARY_AGREA, text: parseSheetText(TEXT_AGREA), image: IMG({ madori: "1K", rooms: [{ name: "洋室", jo: 6.0 }, { name: "K", jo: null }] }) }).status === "ok");
  // 反証（2026-09-24）: 表記ゆれ・図の読みの揺れで正しい物件を要確認にしない
  const agrea = parseSheetText(TEXT_AGREA);
  t("★ 1R と読んだ 1K の資料は要確認にしない（R/K の取り違え）", checkSheetConsistency({ summary: SUMMARY_AGREA, text: agrea, image: IMG({ madori: "1R", rooms: [{ name: "洋室", jo: 6.0 }] }) }).status === "ok");
  t("★ 1DK と読んだ 1LDK の資料は要確認にしない（DK/LDK の定義）", checkSheetConsistency({ summary: SUMMARY_ABELIA, text: a, image: IMG({ madori: "1DK", rooms: [{ name: "DK", jo: 11.9 }, { name: "洋室", jo: 4.4 }] }) }).status === "ok");
  t("★ 1K と読んだ 1LDK の資料は要確認（部屋の形が違う）", checkSheetConsistency({ summary: SUMMARY_ABELIA, text: a, image: IMG({ madori: "1K" }) }).status === "要確認");
  t("★ 全角の 1Ｋ・帖数「７帖」も同じに読む", parseSheetImageFacts(JSON.stringify({ fp_ok: true, madori: "１Ｋ", rooms: [{ name: "洋室", jo: "７帖" }] }))?.madori === "1K" && parseSheetImageFacts(JSON.stringify({ fp_ok: true, madori: "1K", rooms: [{ name: "洋室", jo: "７帖" }] }))?.rooms[0].jo === 7);
  t("★ 帖数の文字「洋室1 6.1帖」は 6.1（数字をつなげて 16.1 にしない）", parseSheetImageFacts(JSON.stringify({ fp_ok: true, rooms: [{ name: "洋室1", jo: "洋室1 6.1帖" }] }))?.rooms[0].jo === 6.1);
  t("★ 図の面積「68.84㎡」は 68.84（㎡ の 2 を拾わない）", parseSheetImageFacts(JSON.stringify({ fp_ok: true, area_sqm: "Cタイプ 68.84㎡" }))?.area_sqm === 68.84);
  t("★ 文字層の「洋室7畳」と図の 7帖 は同じ", checkSheetConsistency({ summary: SUMMARY_AGREA, text: parseSheetText(TEXT_AGREA.replace("間取タイプ 1K", "間取タイプ 1K[洋室7畳]")), image: IMG({ madori: "1K", rooms: [{ name: "洋室", jo: 7 }] }) }).status === "ok");
  t("★ 説明文の面積が整数（21㎡）でも資料 21.83㎡ と同じ部屋", !checkSheetConsistency({ summary: SUMMARY_AGREA.replace(/21.83/g, "21"), text: agrea, image: null }).reasons.some((r) => r.includes("専有面積")));
  t("★ K の帖数だけ読めた 1K は「小さすぎる」にしない", checkSheetConsistency({ summary: SUMMARY_AGREA, text: agrea, image: IMG({ madori: "1K", rooms: [{ name: "K", jo: 2 }] }) }).status === "ok");
  t("★ 居室が全部読めて小さすぎる図（60㎡ に 洋4.5）→ 要確認", checkSheetConsistency({ text: { ...agrea, areaSqm: 60 }, image: IMG({ madori: "1K", rooms: [{ name: "洋室", jo: 4.5 }] }) }).reasons.some((r) => r.includes("小さすぎる")));
}

// ── 7. 希望との照合（文字だけ・決まった手順） ──
const W = (id: string, text: string, ng = false, must = false, source: ImageWant["source"] = "条件"): ImageWant => ({ id, source, text, topics: [], ng, must });
{
  const a = parseSheetText(TEXT_ABELIA);
  const wants = [
    W("W1", "バストイレ別"), W("W2", "独立洗面台"), W("W3", "対面キッチン"), W("W4", "WIC 付き"),
    W("W5", "ペット可NG", true, true), W("W6", "1階NG", true), W("W7", "3点ユニットNG", true), W("W8", "リビングと寝室を分けたい", false, false, "会話"),
    W("W9", "洋室が小さいのは嫌", true, false, "会話"), W("W10", "南向き"),
  ];
  const m = matchWantsWithFacts(wants, a, IMG(), "1LDK");
  const r = Object.fromEntries(m.checks.map((c) => [c.id, c.result]));
  t("★ 照合: バストイレ別・独立洗面・対面（文字層のカウンターキッチン）は ok", r.W1 === "ok" && r.W2 === "ok" && r.W3 === "ok", m.checks);
  t("★ 照合: WIC は間取り図「なし」で ng", r.W4 === "ng");
  t("★ 照合: 「ペット可NG」はペット相談の物件で ng（嫌な物がある）", r.W5 === "ng");
  t("★ 照合: 「1階NG」は 3階で ok（向きを反対に読む）", r.W6 === "ok");
  t("★ 照合: 「1階以外」も 3階で ok（反証 2026-09-24）", matchWantsWithFacts([W("X1", "1階以外")], a, null).checks[0]?.result === "ok");
  t("★ 照合: 「1階以外」は 1階で ng", matchWantsWithFacts([W("X1", "1階以外")], { ...a, floor: 1 }, null).checks[0]?.result === "ng");
  t("★ 照合: 「3点ユニットNG」はバストイレ別で ok", r.W7 === "ok");
  t("★ 照合: 「リビングと寝室を分けたい」は 1LDK・隣接で ok", r.W8 === "ok");
  t("★ 照合: 決まった手順の無い希望（洋室が小さいのは嫌）は文字で聞く候補", m.undecided.includes("W9") && !m.checks.some((c) => c.id === "W9"));
  t("★ 照合: 南向き × 開口部方位 北 → ng", r.W10 === "ng");
  const k = matchWantsWithFacts([W("W1", "リビングと寝室を分けたい")], parseSheetText(TEXT_AGREA), null, "1K");
  t("★ 照合: 1K で「分けたい」→ ng（居室が1つ）", k.checks[0].result === "ng", k.checks);
  const u = matchWantsWithFacts([W("W1", "WIC 付き"), W("W2", "対面キッチン")], parseSheetText(TEXT_AGREA), null, "1K");
  t("★ 照合: 図を読んでいない（null）・文字層に無い物は unknown（推測しない）", u.checks.every((c) => c.result === "unknown"), u.checks);
  const d = matchWantsWithFacts([W("W1", "3点ユニットでもいい")], a, IMG(), null);
  t("★ 照合: 「でもいい」は照合しない（文字で聞く候補）", d.undecided.includes("W1"));
  // 画面・条件欄からの実際の希望の形（extractImageWants）でも通る
  const real = extractImageWants({ conditions: { preferences: "WIC（ウォークインクローゼット）付き、バストイレ別", ng_points: "ペット可NG[必須]" } });
  const rm = matchWantsWithFacts(real, parseSheetText(TEXT_AGREA), IMG({ madori: "1K", storage: { wic: "なし", closets: 1, shoes: "あり" } }), "1K");
  t("★ 照合: 条件欄の実際の形（WIC・バストイレ別・ペット可NG[必須]）", rm.checks.map((c) => c.result).join(",") === "ng,ok,ng", rm.checks);
  // 2026-09-24 YUMA: スタッフのメモの「ペット可NG」は ng の印が無くても文の言い方で「嫌」と読む
  const memo = matchWantsWithFacts([{ id: "W1", source: "メモ", text: "ペット可NG", topics: [], ng: false, must: false }], a, IMG(), null);
  t("★ 照合: メモの「ペット可NG」（ng の印なし）もペット相談で ng", memo.checks[0].result === "ng", memo.checks);
  const desc = describeFacts(a, IMG());
  t("★ 画面の短い文: 水回り・キッチン・間取り・収納", desc.water.includes("バス・トイレ別") && desc.kitchen.startsWith("カウンターキッチン（資料）") && desc.layout.startsWith("1LDK") && desc.storage.includes("シューズボックス"), desc);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
