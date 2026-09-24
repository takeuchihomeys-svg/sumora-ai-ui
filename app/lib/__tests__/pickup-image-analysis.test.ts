// 2026-09-24 竹内「画像で分析ボタン」— 純関数のテスト
// 2026-09-24 作り直し（型の前置き・間取り図の切り出し・物件ごとの保存・要確認）に合わせて、事実から点を出す所を見る
// 実行: npx tsx app/lib/__tests__/pickup-image-analysis.test.ts
import { buildPickupAnalysis, pickBest, buildWantsText, type PickupImageAnalysis } from "../pickup-image-analysis";
import { cropRectForSheet } from "../pdf-trim";
import { pickAnalysisImageUrl, needsTrimBeforeAnalysis } from "../pickup-image-url";
import { parseSheetText } from "../sheet-facts";
import type { SheetImageFacts } from "../sheet-prompt";
import type { ImageWant } from "../image-wants";
let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ""}`); }
}
// 実物（id 45 ガーディアンズパレス難波・1ページ目の文字層の抜粋。物件の情報だけ）
const TEXT = `Powered by RealNetPro co.,ltd.
物件種目 [住居用] マンション
物件名 ガーディアンズパレス難波
号室名 703（7階部分）
所在地
大阪府大阪市浪速区敷津西１丁目5-17
間取タイプ 1K[洋室7帖]
専有面積 23.76㎡ 開口部方位 西
賃料
75,200 円
備 考
★ペット飼育可:小型犬・猫合計2匹まで
★インターネット(Wi-Fi)無料:ファイバーゲート
設 備
【位置】 角部屋 【キッチン】 給湯器（ガス）・IHクッキングヒーター（2
口）・システムキッチン 【水廻り】 風呂（ユニットバス）・トイレ（水洗）・洗面台（独立）・浴室乾燥機・シャワートイレ・バス・トイレ別・洗濯機置場（室内）
【収納】 シューズボックス
条 件
【条件】 ペット相談・保証会社利用必須
取引態様：媒介`;
const SUMMARY = "【1】ガーディアンズパレス難波\n75,200円 6,800円\n1K 23.76㎡\nAD 1.5ヶ月";
const IMG: SheetImageFacts = {
  see: "中央の間取り図", fp_ok: true, other_unit: false, madori: "1K", rooms: [{ name: "洋室", jo: 7 }, { name: "K", jo: null }], area_sqm: null, type_label: "",
  kitchen: { placement: "壁付け", stove: "IH", burners: 2 }, water: { bath_toilet: "別", washbasin: "独立", laundry: "室内" },
  living_bedroom: "単室", storage: { wic: "なし", closets: 1, shoes: "あり" }, balcony: "あり", note: "",
};
const W = (id: string, text: string, ng = false, must = false): ImageWant => ({ id, source: "条件", text, topics: [], ng, must });
const text = parseSheetText(TEXT);
{
  const wants = [W("W1", "バストイレ別"), W("W2", "独立洗面台"), W("W3", "WIC 付き"), W("W4", "ペット可NG", true, true)];
  const a = buildPickupAnalysis({ wants, text, image: IMG, summary: SUMMARY });
  t("★ 点: 決定論（バストイレ別・独立洗面 ok／WIC ng／ペット可NG[必須] ng → 必須 NG で 20 点が上限・上限前は 2/5＝40）", !!a && a.match === 20 && a.must_fail === true && a.match_raw === 40, a);
  t("★ 合うの数（ok_count）", a?.ok_count === 2);
  t("★ 要確認でない（説明文・文字層・図が一致）", a?.review?.status === "ok", a?.review);
  t("★ 画面の文: 水回り・キッチン（壁付け・IH・2口）", !!a && a.water.includes("独立洗面台") && a.kitchen.startsWith("壁付け") && a.kitchen.includes("2口"), a);
  t("★ good / concern は希望の文", !!a && a.good.includes("バストイレ別") && a.concern.includes("WIC 付き"), a);
}
{
  // まとめ PDF のずれ（説明文は別の物件）→ 点を出さない
  const a = buildPickupAnalysis({ wants: [W("W1", "バストイレ別")], text, image: IMG, summary: "【2】エスリード難波AGREA\n76,300円 8,000円\n1K 21.83㎡" });
  t("★ 要確認: 説明文と資料が違えば点は null・理由つき", !!a && a.match === null && a.review?.status === "要確認" && (a.review?.reasons.length ?? 0) >= 2 && a.concern[0].startsWith("要確認"), a);
  // 図が別の部屋（帖数が違う）→ 図の事実は照合に使わない（文字層だけ）
  const b = buildPickupAnalysis({ wants: [W("W1", "WIC 付き")], text, image: { ...IMG, rooms: [{ name: "洋室", jo: 9 }] }, summary: SUMMARY });
  t("★ 要確認: 図の帖数が文字層と違う → 点なし・図の「WIC なし」は使わない（unknown）", !!b && b.match === null && b.checks[0].result === "unknown", b);
}
{
  // 決まった手順で決まらない希望は文字で聞いた答えを使う
  const wants = [W("W1", "バストイレ別"), W("W2", "洋室が小さいのは嫌", true)];
  const a = buildPickupAnalysis({ wants, text, image: IMG, summary: SUMMARY, llmChecks: [{ id: "W2", result: "ok", why: "rooms: 洋室7帖" }, { id: "W9", result: "ng", why: "x" }] });
  t("★ 文字で聞いた答え: 決まらなかった希望だけ使う（知らない番号は捨てる）", !!a && a.checks.length === 2 && a.checks[1].id === "W2" && a.checks[1].result === "ok" && a.match === 100, a?.checks);
  const b = buildPickupAnalysis({ wants, text, image: IMG, summary: SUMMARY });
  t("★ 文字で聞いていなければ unknown（推測しない）", b?.checks[1].result === "unknown");
  t("★ 文字層も図も無ければ null（読めない）", buildPickupAnalysis({ wants, text: parseSheetText(""), image: null }) === null);
  t("★ 希望が無ければ点は null（事実だけ出す）", buildPickupAnalysis({ wants: [], text, image: IMG, summary: SUMMARY })?.match === null);
}
{
  const A = (match: number | null, extra: Partial<PickupImageAnalysis> = {}): PickupImageAnalysis => ({ water: "a", kitchen: "", layout: "", storage: "", match, good: [], concern: [], checks: [], ...extra });
  const rows = [
    { id: 1, rank: 1, analysis: A(60) },
    { id: 2, rank: 2, analysis: A(80) },
    { id: 3, rank: 3, analysis: A(80) },
    { id: 4, rank: 4, analysis: null },
  ];
  t("★ 一番合う＝点が最大・同点は順位が上", pickBest(rows)?.id === 2);
  t("★ 点が1件も無ければ null", pickBest([{ id: 1, rank: 1, analysis: null }]) === null);
  const tie = [
    { id: 1, rank: 1, analysis: A(20, { match_raw: 30 }) },
    { id: 3, rank: 3, analysis: A(20, { match_raw: 70 }) },
  ];
  t("★ 同点（必須 NG で 20 点）は上限前の点で選ぶ", pickBest(tie)?.id === 3);
  // 2026-09-24 竹内「前回の反証で出た点も直す」: 同点は「合う」の数が多い方
  const okTie = [
    { id: 1, rank: 1, analysis: A(100, { match_raw: 100, ok_count: 1 }) },
    { id: 2, rank: 2, analysis: A(100, { match_raw: 100, checks: [1, 2, 3, 4, 5].map((i) => ({ id: `W${i}`, result: "ok" as const, why: "" })) }) },
  ];
  t("★ 同点は「合う」の数が多い方（ok_count が無い古い結果は checks から数える）", pickBest(okTie)?.id === 2);
  t("★ 要確認（点 null）は一番に選ばない", pickBest([{ id: 1, rank: 1, analysis: A(null, { review: { status: "要確認", reasons: ["x"] } }) }, { id: 2, rank: 2, analysis: A(10) }])?.id === 2);
}
{
  const w = buildWantsText({ customer_name: "山田太郎", phone: "090", floor_plan: "1LDK", preferences: "独立洗面台", ng_points: "1階NG" }, "WIC が欲しい");
  t("★ 希望の文は条件の欄だけ（名前・電話は入れない）", !w.includes("山田") && !w.includes("090") && w.includes("独立洗面台") && w.includes("1階NG") && w.includes("WIC が欲しい"), w);
}
{
  t("★ トリミングは既定で100%（1ページ目は帯替え済み）", JSON.stringify(cropRectForSheet(1548, 1093)) === JSON.stringify({ x: 0, y: 0, width: 1548, height: 1093 }));
  t("★ 86% を渡せば従来の形", cropRectForSheet(1548, 1093, 0.86).height === 940);
}
{
  // 2026-09-24 竹内「文字が反映されていないバグ」: PDF が無い時の予備の画像は文字のある物だけ
  t("★ 画像: トリミングがあればそれ", pickAnalysisImageUrl({ trim_image_url: "T", page_image_url: "P", pdf_has_text: false }) === "T");
  t("★ 画像: 文字層が取れた回の page_image_url は使う（直した後の記録）", pickAnalysisImageUrl({ trim_image_url: null, page_image_url: "P", pdf_has_text: true }) === "P");
  t("★ 画像: 文字層が無い回の page_image_url は使わない（直す前の文字抜け）→ 先にトリミング", pickAnalysisImageUrl({ trim_image_url: null, page_image_url: "P", pdf_has_text: false }) === null && needsTrimBeforeAnalysis({ page_image_url: "P", pdf_has_text: false }));
  // 2026-09-24 竹内「必要な所だけを切り出して読ませる」: 物件ごとの PDF があればサーバーが切り出すのでトリミング不要
  t("★ PDF があればトリミング不要（サーバーが PDF から切り出す）", needsTrimBeforeAnalysis({ page_image_url: "P", pdf_has_text: false, pdf_blob_url: "B" }) === false);
}
console.log(`\n合計: ${passed}/${passed + failed}`);
if (failed > 0) process.exit(1);
