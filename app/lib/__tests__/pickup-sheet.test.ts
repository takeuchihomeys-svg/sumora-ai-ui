// 2026-09-24 竹内「2つの型でプロンプトキャッシュ」「必要な所だけ切り出す・表の文字は文字層」「物件と一致しているか・食い違いは要確認」
//   「物件ごとに保存し、2回目以降は画像を読み直さない（希望との照合は文字だけ）」— 型・切り出し・固定の前置き・突き合わせ・照合の純関数のテスト
// 実行: npx tsx app/lib/__tests__/pickup-sheet.test.ts
// 文字層・画像の位置は 2026-09-24 の実物（property_pickups id 3・35・38・45 のリアプロ資料・物件の情報だけ。お客様の情報は無い）
import { createHash } from "node:crypto";
import { detectSheetType, planSheetCrop, padBox, toPixelRect, findItandiFrameBox, REALPRO_SLOTS, ITANDI_SLOTS, ITANDI_PDF_FRAME, type NormBox } from "../sheet-layout";
import { sheetPromptPrefix, SHEET_COMMON_HEAD, SHEET_TYPE_SECTIONS, buildSheetReadContent, parseSheetImageFacts, settleByEquipText, settleItandiPdfFacts, SHEET_PROMPT_VERSION, SHEET_READ_MAX_TOKENS, buildWantsJudgePrompt, WANTS_JUDGE_HEAD, type SheetImageFacts } from "../sheet-prompt";
import { parseSheetText, unitKeyOf, checkSheetConsistency, matchWantsWithFacts, describeFacts, roomKindOf, wantJudgeKey, applySavedJudgments, mergeJudgments, sameImageName, textFactsFromImageSheet } from "../sheet-facts";
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
  // 2026-09-25: 画像だけの itandi は 画像1＝左上の枠（画素で見つけた範囲）・画像2＝上の帯と右の表を縦に並べた物。枠が見つからなければ写真の範囲全体
  t("★ itandi 画像だけ・枠が見つからない（ページ形 0.707）: 写真の範囲＋（帯・表）", fixed.mode === "image_area" && fixed.basis === "fixed" && fixed.frame === "page" && JSON.stringify(fixed.rect) === JSON.stringify(ITANDI_SLOTS.photoArea) && JSON.stringify(fixed.extraStack) === JSON.stringify([ITANDI_SLOTS.band, ITANDI_SLOTS.table]), fixed);
  const FR = { x: 0.018, y: 0.122, w: 0.237, h: 0.418 };
  const px2 = planSheetCrop("itandi", null, 0.596, { itandiFrame: FR });
  t("★ itandi 画像だけ・枠が見つかった: 画像1＝枠だけ（余白 .004）・帯は枠の上端まで・basis=pixels", px2.mode === "image_area" && px2.basis === "pixels" && px2.frame === "cut"
    && Math.abs(px2.rect.x - 0.014) < 1e-9 && Math.abs(px2.rect.w - 0.245) < 1e-9 && px2.extraStack?.length === 2 && Math.abs(px2.extraStack[0].h - 0.12) < 1e-9 && px2.extraStack[1].x > 0.49, px2);
  t("★ itandi PDF（描画命令あり）は画素の枠を使わない", planSheetCrop("itandi", [BG], 0.707, { itandiFrame: FR }).mode === "itandi_pdf");
  const cut = planSheetCrop("itandi", null, 0.594);
  t("★ itandi 画像だけ（切り抜き 0.594）: 型を外さず cut の座標に換算（旧は1ページ全体に落ちていた）", cut.mode === "image_area" && cut.frame === "cut" && !!cut.extra && cut.rect.h > ITANDI_SLOTS.left.h && cut.rect.x + cut.rect.w <= 1 && cut.rect.y + cut.rect.h <= 1, cut);
  t("★ itandi 画像だけ: 縦向きの資料には当てない（1ページ全体）", planSheetCrop("itandi", null, 1.41).mode === "page" && planSheetCrop("itandi", null, 2.1).mode === "page");
  const drawn = planSheetCrop("itandi", [BG, { x: 0.015, y: 0.093, w: 0.241, h: 0.355 }, { x: 0.26, y: 0.093, w: 0.24, h: 0.355 }, { x: 0.52, y: 0.1, w: 0.4, h: 0.3 }], 0.707);
  t("★ itandi PDF: 画像1＝左上の枠・画像2＝ほかのマス（右の表の画像は入れない）", drawn.mode === "itandi_pdf" && drawn.basis === "drawn" && drawn.rect.x + drawn.rect.w < 0.27 && !!drawn.extra && drawn.extra.x > 0.25 && drawn.extra.x + drawn.extra.w < 0.51, drawn);
  // 2026-09-24 夜 実物 PDF 18件: 左上の枠は罫線の固定位置（ITANDI_PDF_FRAME）。枠の中の画像が小さくても枠全体を切る（線で描いた図も入る）
  const logo = planSheetCrop("itandi", [BG, { x: 0.03, y: 0.11, w: 0.05, h: 0.04 }], 0.707);
  t("★ itandi PDF・枠の中の画像が小さい → 枠全体を切る（小さな絵だけにしない）", logo.mode === "itandi_pdf" && logo.rect.w >= ITANDI_PDF_FRAME.w && logo.rect.h >= ITANDI_PDF_FRAME.h, logo);
  const none = planSheetCrop("itandi", [BG, { x: 0.6, y: 0.1, w: 0.3, h: 0.3 }], 0.707);
  t("★ itandi PDF・左に画像が無い（画像情報なし）→ 枠を fixed で切り、理由を残す", none.mode === "itandi_pdf" && none.basis === "fixed" && !none.extra && !!none.reason, none);
  t("★ 型不明 → 1ページ全体", planSheetCrop("unknown", [BG, FLOOR, MAP], 0.707).mode === "page");
  t("★ 余白はページの外に出ない", JSON.stringify(padBox({ x: 0, y: 0, w: 1, h: 1 })) === JSON.stringify({ x: 0, y: 0, w: 1, h: 1 }));
  const px = toPixelRect({ x: 0.34, y: 0.293, w: 0.261, h: 0.368 }, 2580, 1822);
  t("★ 画素に直す（整数・画像の中）", px.x === 877 && px.y === 533 && px.x + px.width <= 2580 && px.y + px.height <= 1822, px);
}

// ── 2b. itandi の資料画像の左上の枠を画素で探す（2026-09-25・正解表 25枚中24枚で ±0.005・ほかの資料112枚で誤検出0） ──
{
  const W = 1100, H = 650;
  const img = () => new Uint8ClampedArray(W * H * 4).fill(255);
  const rect = (px: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number, th = 2) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (y - y0 < th || y1 - y < th || x - x0 < th || x1 - x < th) { const i = (y * W + x) * 4; px[i] = px[i + 1] = px[i + 2] = 20; }
    }
  };
  const a = img();
  rect(a, 20, 79, 280, 350);            // 枠（x .018〜.255・y .122〜.538）
  rect(a, 100, 180, 230, 260, 5);       // 枠の中の間取り図の壁（太い線・枠と端が揃わない）
  rect(a, 300, 79, 540, 250);           // 隣の写真のマス
  const f = findItandiFrameBox(a, W, H);
  t("★ 枠: 罫線の四角を ±2px で取る（中の壁・隣のマスと取り違えない）", !!f && Math.abs(f.x - 20 / W) < 0.002 && Math.abs(f.y - 79 / H) < 0.004 && Math.abs(f.x + f.w - 281 / W) < 0.002 && Math.abs(f.y + f.h - 351 / H) < 0.004, f);
  const b = img();
  rect(b, 20, 79, 280, 350);
  for (let x = 60; x < 240; x++) for (let y = 79; y < 82; y++) { const i = (y * W + x) * 4; b[i] = b[i + 1] = b[i + 2] = 255; }   // 上辺が途中で切れている（002 の形）
  const fb = findItandiFrameBox(b, W, H);
  t("★ 枠: 上辺の罫線が途中で切れていても下辺で右端を取る", !!fb && Math.abs(fb.x + fb.w - 281 / W) < 0.002, fb);
  t("★ 枠: 何も無い画像は null", findItandiFrameBox(img(), W, H) === null);
  const c = img();
  rect(c, 5, 5, 540, 600);              // 表のような大きな罫線（リアプロ・見積書の形）＝itandi の位置の範囲の外
  t("★ 枠: itandi の位置の範囲の外（上端 .01・下端 .92）は枠と見なさない", findItandiFrameBox(c, W, H) === null);
}

// ── 3. 固定の前置き（キャッシュ） ──
{
  const modes = ["floor", "image_area", "itandi_pdf", "page"] as const;
  t("★ 前置き: 4つとも共通の頭（役割・返す形・間違えやすい所）で始まる＝型の間でキャッシュを共有", modes.every((m) => sheetPromptPrefix(m).startsWith(SHEET_COMMON_HEAD)));
  t("★ 前置き: 呼ぶたびに一字一句同じ", modes.every((m) => sheetPromptPrefix(m) === sheetPromptPrefix(m)));
  t("★ 前置き: 日時・時刻が入っていない", modes.every((m) => !/\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}:\d{2}/.test(sheetPromptPrefix(m))));
  t("★ 前置き: お客様の希望（W1…）を入れない（画像から読むのは物件の事実だけ）", modes.every((m) => !/W\d|お客様の希望/.test(sheetPromptPrefix(m))));
  const c = buildSheetReadContent("floor", "data:image/jpeg;base64,AAAA");
  t("★ 並び: 文（前置き）→ 画像。画像を先頭にしない", c.length === 2 && c[0].type === "text" && c[1].type === "image_url");
  // 固定の前置きを変えたら、このハッシュと SHEET_PROMPT_VERSION（保存した読み取りの版）を一緒に上げる
  const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
  const pinned = { common: "fdd7f85dd75ad073", floor: "c9891c8b854b0598", image_area: "12bb4c89907fdcf6", itandi_pdf: "4c3bf9d4c58404b5", page: "7568fa981277514a" };
  const now = { common: h(SHEET_COMMON_HEAD), floor: h(sheetPromptPrefix("floor")), image_area: h(sheetPromptPrefix("image_area")), itandi_pdf: h(sheetPromptPrefix("itandi_pdf")), page: h(sheetPromptPrefix("page")) };
  t(`★ 前置きの固定（変えたら SHEET_PROMPT_VERSION=${SHEET_PROMPT_VERSION} も上げる）`, JSON.stringify(now) === JSON.stringify(pinned), now);
  t("★ 型の説明は4つ（リアプロ・itandi 画像・itandi PDF・1ページ全体）", Object.keys(SHEET_TYPE_SECTIONS).length === 4);
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
  // 2026-09-25 収納は字（labels）から数える（下駄箱・MB・PS・棚・収納でない字は数えない・WIC は数える・納戸は部屋）
  const cl = (labels: unknown, closets: unknown = 9) => parseSheetImageFacts(JSON.stringify({ fp_ok: true, storage: { wic: "なし", labels, closets } }))?.storage.closets;
  t("★ 収納: 英語の図（Closet・Storage／Shoes Clo・MB・PS は除く）→ 2", cl(["MB", "Shoes Clo", "Storage", "W", "Closet", "PS"]) === 2);
  t("★ 収納: WIC も1つ・SCL（下駄箱）は除く（正解表 123）→ 2", cl(["SCL", "MB", "収", "WIC"]) === 2);
  t("★ 収納: リアプロの「Clo.」「クローク」も数える／シューズクロークは除く", cl(["Clo.", "MB"]) === 1 && cl(["クローク", "M.B", "シューズクローク"]) === 1);
  t("★ 収納: 納戸・収納でない字（Sniff・洗面所）は数えない", cl(["納戸", "Sniff", "洗面所"]) === 0);
  t("★ 収納: labels が無い・空ならモデルの数のまま", cl(undefined, 2) === 2 && cl([], 1) === 1);
  // 2026-09-25 設備欄の語がはっきりしている時だけ水回りを決める（正解表 43件で食い違い0）
  const base = parseSheetImageFacts('{"fp_ok":true,"water":{"bath_toilet":"別","washbasin":"不明","laundry":"不明"},"storage":{"wic":"不明"},"balcony":"不明"}')!;
  const u1 = settleByEquipText(base, "バス・トイレ一緒、IHクッキングヒーター、収納スペース");
  t("★ 設備欄: 「バス・トイレ一緒」だけ → 同室・浴室内（図を「別」と読んだ 007）", u1.water.bath_toilet === "同室" && u1.water.washbasin === "浴室内", u1.water);
  const u2 = settleByEquipText({ ...base, water: { ...base.water, bath_toilet: "同室" } }, "バス・トイレ別, バス・トイレ一緒, 独立洗面台");
  t("★ 設備欄: 「別」と「一緒」の両方（022）→ 図の読みのまま・独立洗面台は独立", u2.water.bath_toilet === "同室" && u2.water.washbasin === "独立", u2.water);
  const u3 = settleByEquipText({ ...base, water: { ...base.water, laundry: "屋外" } }, "室内洗濯機置場, バルコニー");
  t("★ 設備欄: 室内洗濯機置場 → 室内・バルコニー → あり・WIC の字なし＋図あり → なし", u3.water.laundry === "室内" && u3.balcony === "あり" && u3.storage.wic === "なし", u3);
  const u4 = settleByEquipText(base, "洗濯機置場, 専用トイレ");
  t("★ 設備欄: 「洗濯機置場」だけ（室内と書いていない 008）は変えない", u4.water.laundry === "不明" && u4.water.bath_toilet === "別", u4.water);
  t("★ PDF: 文字層の設備にウォークインクローゼット → WIC あり（シューズインクローゼットは除く）",
    settleItandiPdfFacts(base, "ウォークインクローゼット").storage.wic === "あり" && settleItandiPdfFacts(base, "シューズインクローゼット").storage.wic === "なし");
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

// ── 文字の照合の答えの保存（反証 2026-09-25） ──
{
  const want = (id: string, text: string, ng = false, must = false): ImageWant => ({ id, source: "条件", text, topics: [], ng, must });
  t("★ 照合の鍵: 同じ文でも NG の有無で別の鍵（欲しい／嫌の答えを使い回さない）", wantJudgeKey(want("W1", "ペット可")) !== wantJudgeKey(want("W1", "ペット可", true)));
  t("★ 照合の鍵: 必須の有無でも別の鍵", wantJudgeKey(want("W1", "WIC")) !== wantJudgeKey(want("W1", "WIC", false, true)));
  t("★ 照合の鍵: 番号・空白・記号の違いは同じ鍵", wantJudgeKey(want("W1", "洋室が 広め！")) === wantJudgeKey(want("W7", "洋室が広め")));
  const saved = mergeJudgments(null, [want("W1", "ペット可")], [{ id: "W1", result: "ok", why: "設備: ペット可" }]);
  const hit = applySavedJudgments([want("W2", "ペット可", true), want("W3", "ペット可")], saved);
  t("★ 保存した答え: NG の希望には欲しい向きの答えを当てない（聞き直す）", hit.missing.length === 1 && hit.missing[0].id === "W2" && hit.checks.length === 1 && hit.checks[0].id === "W3" && hit.checks[0].result === "ok", hit);
  const s2 = mergeJudgments(saved, [want("W4", "洋室が広め")], []);
  t("★ 保存: 答えが無かった希望は unknown で保存（次も聞かない）", Object.values(s2).some((v) => v.result === "unknown"), s2);
}

// ── 画像から読んだ物件名の突き合わせ（反証 2026-09-25: 2文字ずつの重なり 0.5 では実在の別の建物どうしが同じになった） ──
{
  const img = (name: string) => textFactsFromImageSheet({ name, room: "206", rent: 60000, madori: "1K", sqm: 19.09, equip: "" });
  const nameNg = (summaryName: string, imageName: string) =>
    checkSheetConsistency({ summary: `【1】${summaryName} 206号室\n60,000円\n1K 19.09㎡\nAD 1ヶ月`, text: img(imageName) }).reasons.some((r) => r.includes("物件名"));
  // 同じ建物（読み違い・表記ゆれ）は通す
  t("★ 画像の名前: イディオス／イデオス（カナの読み違い）は同じ", sameImageName("イディオス新大阪", "イデオス新大阪") && !nameNg("イディオス新大阪", "イデオス新大阪"));
  t("★ 画像の名前: リリアン／リアン（1字落ち）は同じ", sameImageName("リリアン東三国", "リアン東三国"));
  t("★ 画像の名前: Ⅱ／II・★ は同じ", !nameNg("★プレミアムステージ新大阪駅前Ⅱ★", "プレミアムステージ新大阪駅前II"));
  t("★ 画像の名前: Ⅵ と空白・中黒の違いは同じ", !nameNg("エステムコート新大阪Ⅵ エキスプレイス", "エステムコート新大阪VI・エキスプレイス"));
  // 実在の別の建物（property_pickups 50〜67 の itandi の回と近くの建物）は要確認
  t("★ 画像の名前: エスリード新大阪SOUTH／NORTH は別（英字の語が違う）", !sameImageName("エスリード新大阪SOUTH", "エスリード新大阪NORTH") && nameNg("エスリード新大阪SOUTH", "エスリード新大阪NORTH"));
  t("★ 画像の名前: プレサンス新大阪ザ・シティ／クレスタ は別", !sameImageName("プレサンス新大阪ザ・シティ", "プレサンス新大阪クレスタ"));
  t("★ 画像の名前: アドバンス新大阪IV／ウエストゲート は別", !sameImageName("アドバンス新大阪IV", "アドバンス新大阪ウエストゲート"));
  t("★ 画像の名前: エスティライフ新大阪第2／第3 は別（数字が違う）", !sameImageName("エスティライフ新大阪第2", "エスティライフ新大阪第3"));
  t("★ 画像の名前: エスリード北大阪レジデンス／エスリード新大阪グランファースト は別", !sameImageName("エスリード北大阪レジデンス", "エスリード新大阪グランファースト"));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
