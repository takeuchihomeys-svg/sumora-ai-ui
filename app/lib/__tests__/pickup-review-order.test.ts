// 売上サポのピックアップ: 並び順（🌟 → 点）・一般名の送付済み照合・理由の札・保存する画像のテスト
// 実行: npx tsx app/lib/__tests__/pickup-review-order.test.ts
// 形は 2026-09-24 の実物（property_pickups id 34〜45 リアプロ／50〜67 itandi）。お客様の名前・電話番号は無い
import { isGenericBuildingName } from "../generic-building-name";
import { isGenericBuildingName as dedupeGeneric } from "../pickup-dedupe";
import {
  buildCustomerProfile, judgeProperty, parsePropertyFacts, applyImageFacts, reasonPoints, BASE_SCORE, REASON_POINTS,
  type CustomerLike, type Judgment,
} from "../property-brain";
import { sortForReview, compareForReview, buildReasonView, formatScoreBreakdown } from "../pickup-review-order";
import { pickSaveImageUrl, saveImageFileName } from "../pickup-image-url";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ""}`); }
}

console.log("■ 一般名（建物が決められない名前）");
{
  for (const n of ["物件", "【3】物件", "【9🌟★】物件", "物件3", "物件 ２", "物件①", "物件No.4", "マンション", "アパート", "", null, "不明"]) t(`一般名: ${JSON.stringify(n)}`, isGenericBuildingName(n));
  for (const n of ["エスリード難波AGREA", "エグゼ難波南VI", "コーポ北", "物件館テスト", "メゾン・ド・難波", "レジデンス新大阪2"]) t(`一般名ではない: ${n}`, !isGenericBuildingName(n));
  t("pickup-dedupe と同じ決まり（再輸出）", dedupeGeneric === isGenericBuildingName);
}

console.log("■ 送付済みの照合は一般名に当てない（id 50〜67 の穴）");
// HONOKA さんの回と同じ形: 家賃上限 7万・徒歩10分・築20年。過去の itandi の送付が「物件」で18件残っている
const honoka: CustomerLike = { rent_max: 70_000, walk_minutes: 10, building_age: 20, pet: false };
const sentHonoka = [...Array.from({ length: 18 }, () => ({ property_name: "物件", rent: null })),
  { property_name: "エスリード北大阪レジデンス", rent: 68_000 }, { property_name: "リーガル新大阪", rent: 66_000 }];
{
  const p = buildCustomerProfile(honoka, sentHonoka);
  t("送付済みに「物件」を入れない", !p.history.sentBuildings.has("物件"), [...p.history.sentBuildings]);
  t("名前のある送付は入る", p.history.sentBuildings.has("エスリード北大阪レジデンス".toLowerCase()) || [...p.history.sentBuildings].some((x) => x.includes("エスリード北大阪")));
  // 実物: id 50〜67 の「物件」18行は全部 delivery='shared'・source='line_group'（同じ回をグループに共有しただけ）
  const withShared = buildCustomerProfile(honoka, [
    { property_name: "エスリード難波AGREA", delivery: "shared", source: "line_group" },
    { property_name: "リーガル新大阪", delivery: null, source: "line_group" },
    { property_name: "プレサンス新大阪ストリーム", delivery: "customer", source: "vision" },
    { property_name: "アドバンス新大阪Ⅳ", delivery: null, source: "aix:property_send" },
  ]);
  const sb = [...withShared.history.sentBuildings];
  t("グループ共有だけの行（shared / line_group）は送付済みにしない", !sb.some((x) => x.includes("agrea") || x.includes("リーガル")), sb);
  t("お客様に届いた行（customer / aix）は送付済み", sb.some((x) => x.includes("プレサンス")) && sb.some((x) => x.includes("アドバンス")), sb);
  const selfShare = judgeProperty(parsePropertyFacts("【3】エスリード難波AGREA\n76,400円 8,000円\n1K 21.09㎡\nAD 2ヶ月"), withShared, 2);
  t("同じ回の共有で自分自身が「送付済み」にならない", !selfShare.reasonCodes.includes("ALREADY_SENT"), selfShare.reasonCodes);
  const itandi = ["【1】物件\nAD 1ヶ月", "【3】物件\nAD 1ヶ月", "【8】物件", "【10】物件\nAD 2ヶ月"];
  const js = itandi.map((s, i) => judgeProperty(parsePropertyFacts(s), p, i));
  t("itandi の「物件」は1件も ALREADY_SENT にならない", js.every((j) => !j.reasonCodes.includes("ALREADY_SENT")), js.map((j) => j.reasonCodes));
  t("外す候補（drop）が0件", js.every((j) => j.verdict !== "drop"), js.map((j) => [j.verdict, j.score]));
  // 名前のある送付済みは今まで通り外す候補
  const dup = judgeProperty(parsePropertyFacts("【2】エスリード北大阪レジデンス\n68,000円\n1K 25㎡\nAD 2ヶ月"), p, 1);
  t("名前のある送付済みは ALREADY_SENT −30 で外す候補", dup.verdict === "drop" && dup.reasonCodes.includes("ALREADY_SENT"));
  // 拡張 v2.5.16 以後の itandi（説明文に名前・賃料・間取り・㎡・交通が入る）は点が分かれる
  const v2516 = [
    "【1】エステムコート新大阪Ⅵエキスプレイス 405号室\n67,000円 管理費なし\n1K 20.8㎡\nJR京都線「新大阪」徒歩8分\nAD 1ヶ月",
    "【2】プレサンス新大阪ストリーム 302号室\n72,000円 管理費5,000円\n1K 22.1㎡\n地下鉄御堂筋線「東三国」徒歩12分\nAD 2ヶ月",
    "【3】アドバンス新大阪ラシュレ 1101号室\n95,000円 管理費10,000円\n1LDK 35.2㎡\n地下鉄御堂筋線「新大阪」徒歩5分\nAD 2ヶ月",
  ].map((s, i) => judgeProperty(parsePropertyFacts(s), p, i));
  const scores = v2516.map((j) => j.score);
  t("名前・賃料・徒歩が入れば点が分かれる（3件とも違う点）", new Set(scores).size === 3, scores);
  t("家賃上限の3割超（95,000＋10,000 / 70,000）は外す候補", v2516[2].verdict === "drop" && v2516[2].reasonCodes.includes("RENT_OVER_130"), v2516[2].reasonCodes);
}

console.log("■ リアプロの説明文の管理費（言葉なしで家賃の後ろに並ぶ）");
{
  const f = parsePropertyFacts("【1】エグゼ難波南VI\n75,000円 10,000円\n1K 25.62㎡\nAD 150,000円");
  t("管理費 10,000 を読む", f.adminFeeYen === 10_000, f);
  t("家賃は 75,000 のまま", f.rentYen === 75_000);
  t("AD の行（1つの金額）は管理費にしない", parsePropertyFacts("【1】X\n75,000円\n1K\nAD 150,000円").adminFeeYen == null);
  t("「管理費なし」は 0", parsePropertyFacts("【1】X\n67,000円 管理費なし\n1K 20.8㎡").adminFeeYen === 0);
  t("「管理費5,000円」は 5,000", parsePropertyFacts("【1】X\n72,000円 管理費5,000円\n1K").adminFeeYen === 5_000);
  t("敷金・礼金の行（同じ金額）は管理費にしない", parsePropertyFacts("【1】X\n75,000円\n敷金 75,000円 礼金 75,000円").adminFeeYen == null);
}

console.log("■ リアプロ（id 34〜45 の説明文）で点が分かれるか");
// 34〜45 のお客様と同じ形: 家賃上限 8万（下限 6万）・徒歩7分・築7年・間取りの希望なし
const realproCust: CustomerLike = { rent_max: 80_000, rent_min: 60_000, walk_minutes: 7, building_age: 7 };
const REALPRO = [
  "【1】エグゼ難波南VI\n75,000円 10,000円\n1K 25.62㎡\nAD 150,000円",
  "【1🌟★】エステムコート難波Ⅶビヨンド\n78,000円 7,000円\n1K 21.81㎡\nAD 171,600円",
  "【2🌟】スプランディッド難波WEST\n77,000円 7,000円\n1K 22.4㎡\nAD 2ヶ月",
  "【5🌟】エスリード難波AGREA\n73,100円 8,000円\n1K 21.09㎡\nAD 2ヶ月",
  "【6】エスリード難波AGREA\n77,000円 8,000円\n1K 21.09㎡\nAD 1.5ヶ月",
  "【1】ガーディアンズパレス難波\n75,200円 6,800円\n1K 23.76㎡\nAD 1.5ヶ月",
];
{
  const p = buildCustomerProfile(realproCust, []);
  const js = REALPRO.map((s, i) => judgeProperty(parsePropertyFacts(s), p, i));
  // 家賃＋管理費はどれも 8万を少し超える（81,100〜85,000）＝「家賃は上限内 +15」ではなく「少し超過 0」
  t("家賃＋管理費で上限と比べる（全件 RENT_SLIGHTLY_OVER）", js.every((j) => j.reasonCodes.includes("RENT_SLIGHTLY_OVER")), js.map((j) => j.reasonCodes));
  t("AD 2ヶ月（80点）と 1.5ヶ月（65点）で分かれる", js[2].score === 80 && js[4].score === 65, js.map((j) => j.score));
  t("材料（徒歩・築年・敷礼）が無い所は減点しない（材料なし）", js.every((j) => j.missing.includes("walk") && j.missing.includes("deposit_key_money")), js.map((j) => j.missing));
}

console.log("■ 点の表（REASON_POINTS）と judgeProperty・applyImageFacts の点が一致する");
{
  const custs: CustomerLike[] = [honoka, realproCust,
    { rent_max: 70_000, floor_plan: "1LDK以上", walk_minutes: 10, building_age: 15, initial_cost_limit: 100_000, other_requests: "初期費用を抑えたい", pet: true },
    { rent_max: 20_000, rent_min: 50_000, floor_plan: "1K" }];
  const sums = [
    "【1】A\n65,000円 管理費5,000円\n1LDK 35㎡\n敷なし 礼なし\n徒歩5分\n築3年\nAD 3ヶ月",
    "【2】B\n80,000円\n2DK\n敷1ヶ月 礼1ヶ月\n徒歩14分\n築25年\nAD 0.5ヶ月\nペット不可",
    "【3】C\n95,000円\n1K\n敷なし 礼1ヶ月\n徒歩20分\n築12年",
    "【4】エスリード北大阪レジデンス\n68,000円\n1DK\n徒歩11分\nAD 2ヶ月",
    "【5】物件\nAD 1ヶ月",
    "【6】D\n72,000円 3,000円\n1LDK\n敷0 礼0\n徒歩10分\nAD 1ヶ月",
  ];
  let bad: unknown[] = [];
  for (const c of custs) {
    const p = buildCustomerProfile(c, sentHonoka, [], 30_000);
    for (const [i, s] of sums.entries()) {
      const j = judgeProperty(parsePropertyFacts(s), p, i);
      const raw = BASE_SCORE + j.reasonCodes.reduce((a, code) => a + reasonPoints(code), 0);
      if (Math.max(0, Math.min(130, raw)) !== j.score) bad.push({ s: s.split("\n")[0], codes: j.reasonCodes, raw, score: j.score });
      const withImg = applyImageFacts({ ...j, imageChecks: ["bath_toilet_separate", "floor_2_plus"] }, { bath_toilet_separate: true, floor_2_plus: false });
      // applyImageFacts は judgeProperty の（上限・下限で切った）点に足してもう一度切る
      const raw2 = j.score + withImg.reasonCodes.filter((c) => c.startsWith("IMAGE_")).reduce((a, code) => a + reasonPoints(code), 0);
      if (Math.max(0, Math.min(130, raw2)) !== withImg.score) bad.push({ img: true, codes: withImg.reasonCodes, raw2, score: withImg.score });
    }
  }
  t("全コードで 50＋合計＝score（上限・下限の内側）", bad.length === 0, bad.slice(0, 3));
  t("ALREADY_SENT は −30", REASON_POINTS.ALREADY_SENT === -30);
}

console.log("■ 並び順（🌟★ → 🌟 → 点の高い順・同点は順位）");
{
  // id 50〜67 の形（付け直し後の点の例）
  const rows = [
    { id: 50, rank: 1, recommended: 0, score: 50 }, { id: 51, rank: 2, recommended: 1, score: 45 },
    { id: 52, rank: 3, recommended: 0, score: 55 }, { id: 55, rank: 6, recommended: 1, score: 60 },
    { id: 58, rank: 9, recommended: 2, score: 65 }, { id: 60, rank: 11, recommended: 0, score: null },
    { id: 61, rank: 12, recommended: 0, score: 55 },
  ];
  const s = sortForReview(rows).map((r) => r.id);
  t("🌟★ → 🌟（点の高い順）→ 印なし（点の高い順・同点は順位）→ 点なし", JSON.stringify(s) === JSON.stringify([58, 55, 51, 52, 61, 50, 60]), s);
  t("元の配列は変えない", rows[0].id === 50);
  t("比べ方: 🌟 は点が低くても上", compareForReview({ id: 1, rank: 5, recommended: 1, score: 10 }, { id: 2, rank: 1, recommended: 0, score: 120 }) < 0);
}

console.log("■ 理由の札（なぜ外す候補か・点の内訳）");
{
  const j: Judgment = judgeProperty(parsePropertyFacts("【2】エスリード北大阪レジデンス\n68,000円\n1K 25㎡\nAD 2ヶ月"), buildCustomerProfile(honoka, sentHonoka), 1);
  const v = buildReasonView({ reason_codes: j.reasonCodes, reasons_ja: ["同じ建物の近い広さの部屋を 2件省略", ...j.reasonsJa] });
  t("外す理由（送付済みの建物 −30）が先頭", v.minus[0]?.code === "ALREADY_SENT" && v.minus[0].tone === "drop" && v.minus[0].points === -30 && v.minus[0].label === "送付済みの建物", v.minus);
  t("加点も持つ（家賃は上限内 +15）", v.plus.some((c) => c.code === "RENT_OK" && c.points === 15), v.plus);
  t("読めなかった材料（敷礼）", v.missing.includes("敷礼"), v.missing);
  t("コードに無い一文（同じ建物の省略）は notes に残る", v.notes.length === 1 && v.notes[0].startsWith("同じ建物"), v.notes);
  t("内訳の合計は score と同じ", v.rawTotal === j.score, [v.rawTotal, j.score]);
  const line = formatScoreBreakdown(v, j.score);
  t("内訳の1行", line.startsWith("基準50") && line.includes("−30 送付済みの建物") && line.endsWith(`＝ ${j.score}`), line);
  // 付け直し前の id 50 の形（材料なし＋送付済み）
  const old = buildReasonView({ reason_codes: ["RENT_UNKNOWN", "INITIAL_COST_UNKNOWN", "ALREADY_SENT", "AD_UNKNOWN"], reasons_ja: ["この建物は送付済み"] });
  t("id 50 の形: 送付済み −30 と 材料なし 家賃・敷礼・AD", old.minus.length === 1 && old.minus[0].code === "ALREADY_SENT" && old.missing.join("・") === "家賃・敷礼・AD" && old.rawTotal === 20, old);
  // コードが無い古い行は reasons_ja をそのまま
  const legacy = buildReasonView({ reason_codes: null, reasons_ja: ["家賃は上限内"] });
  t("コードが無い古い行は reasons_ja を知らせに", legacy.notes[0] === "家賃は上限内" && legacy.rawTotal == null && formatScoreBreakdown(legacy, 60) === "");
  // 上限で切れた時
  const clamped = formatScoreBreakdown({ minus: [], plus: [{ code: "X", label: "x", points: 100, tone: "plus" }], missing: [], notes: [], rawTotal: 150 }, 130);
  t("上限で切れた時は（上限・下限で 130）", clamped.includes("（上限・下限で 130）"), clamped);
}

console.log("■ 画像保存はお客様に送る1ページ目だけ（元付の資料は選ばない）");
{
  const agent = "https://x.public.blob.vercel-storage.com/pickups/a_p2.png";
  t("トリミングがあればそれ", pickSaveImageUrl({ trim_image_url: "T.jpg", page_image_url: "P.png", pdf_has_text: true }) === "T.jpg");
  t("無ければ文字のある1ページ目", pickSaveImageUrl({ trim_image_url: null, page_image_url: "P.png", pdf_has_text: true }) === "P.png");
  t("文字の無い1ページ目は選ばない（先にトリミング）", pickSaveImageUrl({ trim_image_url: null, page_image_url: "P.png", pdf_has_text: false }) == null);
  const withAgent = { trim_image_url: null, page_image_url: null, pdf_has_text: true, agent_image_url: agent };
  t("元付の資料（agent_image_url）しか無い時も null", pickSaveImageUrl(withAgent) == null);
  t("ファイル名（順位_名前_号室・使えない文字は _）", saveImageFileName({ rank: 3, property_name: "エスリード 難波/AGREA", room_no: "405" }, "https://x/a.jpg") === "3_エスリード_難波_AGREA_405.jpg");
  t("png は .png", saveImageFileName({ rank: 1, property_name: "A" }, "https://x/a_p1.png").endsWith(".png"));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
