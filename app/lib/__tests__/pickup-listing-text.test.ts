// 2026-09-27 竹内（YUMA テストの AIXツールのスクショ）「画像で分析の部分も上の部分にまとめる。まとめたうえで結果をだす」
//   「割引が AD より大きいとあるが AD はこっち側で自由にかえれるものやから、そこは影響しない」「物件名に号室もいれる」
//   「AD の項目は重要なので物件名の横にもスタンプでいれる」
// 実行: npx tsx app/lib/__tests__/pickup-listing-text.test.ts
// 値は YUMA のテスト顧客（竹内さん本人のテスト用）の回 cg_509cd061_706（property_pickups #706〜715）と 9/20〜 の資料の実物（お客様の個人情報は無い）
import { listingAdText, listingRoomText, nameWithRoom, cardRoom, splitAdStamp, imageChipOf, roundImageLine, pointsLabel } from "../pickup-listing-text";
import { rejudgeWithoutDiscount, applyEquipmentMatch, dropDiscountFromRow } from "../property-brain";
import { compareOverall, pickCustomerBest, roundBestId, bestRuleTag, BEST_RULE_TAG, type BestCandidateRow } from "../pickup-best";
import { sortForReview } from "../pickup-review-order";
import { rankCompleteGroup } from "../pickup-complete";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ""}`); }
}

// ── 資料の文字（リアプロ: 1ページ目＝蓮産業の帯・2ページ目＝元付業者。最後の行が AD の欄） ──
const RP_708 = [
  "5476969", "蓮産業株式会社 本店", "物件名 ラ・フォーレ東天満", "号室名 703（7階部分）", "現況/入居時期 退去予定(10/31) / 相談",
  "5476969", "株式会社Bell", "物件名 ラ・フォーレ東天満", "号室名 703（7階部分）",
  "・webサービス広告掲載 [許可]・転載事前連絡 [不要]・画像の転載 [可能]・間取図転載 [可能]・チラシ、雑誌等掲載広告 [許可]・保証会社：保証会社利用必須",
  "【解約予告】", "2ヶ月前", "A D 2ヶ月（税込）（-1万）",
].join("\n");
const RP_707_TAIL = "■ お問合せ先に指定があります：店舗定休日は中鹿携帯(000-0000-0000)迄 広告料 2ヶ月（税込）";
const RP_713 = "物件名 イーストヴィラ梅田\n号室名 0808（8階部分）\nwebサービス広告掲載 [許可]\nA D 100％";
const RP_706 = "物件名 エストドミール野田\n号室名 00105（1階部分）\nA D 1ヶ月（税込）";
const RP_EMPTY_AD = "物件名 Luxe難波南\n号室名 204（2階部分）\nwebサービス広告掲載 [要確認]・チラシ、雑誌等掲載広告 [要確認]\nA D";
const RP_BK = "物件名 アリビオ夕陽丘\n号室名 202（2階部分）\n25.01平米以上50.00平米以下38,000円 (税別)、\nBK 2ヶ月（税込）";
const RP_ITAKU = "■ カギ所在：ITANDI BBにて内見予約して下さい。\n業務委託料 2ヶ月（税込）";
const RP_TAIOU = "■ カギ所在：退去後\n対応補助業務手数料 3ヶ月（ー11,000円(税込)）";
const RP_369 = "★9月入居限定キャンペーン★礼金0円+広告料2ヶ月\nA D 2ヶ月（事務手数料-10,000円 基本的には相殺で、後BKの場合は振込になります。）";
const RP_005B = "物件名 The　Peak　Shinsaibashi\n号室名 005B（地下部分）\nA D 98000円";
const IT_1 = "賃料 72,000円\n広告費 100 ％\n広告掲載 可\n仲介手数料 1ヶ月";
const IT_NONE = "広告費 なし\n広告掲載 可";
const IT_KANGXI = "広告費 2 ヶ⽉\n備考";

console.log("■ AD の札は資料の文字のまま（最後の行＝元付業者の AD の欄）");
{
  t("A D 2ヶ月（税込）（-1万）（空白・括弧の付け足しもそのまま）", listingAdText(RP_708) === "A D 2ヶ月（税込）（-1万）", listingAdText(RP_708));
  t("前の欄の続きに付いた「広告料 2ヶ月（税込）」", listingAdText(`物件名 ブランメゾン堀川\n${RP_707_TAIL}`) === "広告料 2ヶ月（税込）", listingAdText(RP_707_TAIL));
  t("A D 100％（説明文の「AD 1ヶ月」に直さない）", listingAdText(RP_713) === "A D 100％");
  t("値の無い欄（「A D」だけ）は出さない・「広告掲載 [要確認]」は AD でない", listingAdText(RP_EMPTY_AD) === null, listingAdText(RP_EMPTY_AD));
  t("元付の見出しのまま: BK", listingAdText(RP_BK) === "BK 2ヶ月（税込）");
  t("元付の見出しのまま: 業務委託料", listingAdText(RP_ITAKU) === "業務委託料 2ヶ月（税込）");
  t("元付の見出しのまま: 対応補助業務手数料（付け足しの括弧も）", listingAdText(RP_TAIOU) === "対応補助業務手数料 3ヶ月（ー11,000円(税込)）", listingAdText(RP_TAIOU));
  t("行の終わりまで（括弧の中の空白でも切らない）・弊社帯の「広告料2ヶ月」のキャンペーン文は採らない", listingAdText(RP_369) === "A D 2ヶ月（事務手数料-10,000円 基本的には相殺で、後BKの場合は振込になります。）", listingAdText(RP_369));
  t("itandi: 最後の行でなくても「広告費 100 ％」（仲介手数料は AD でない）", listingAdText(IT_1) === "広告費 100 ％", listingAdText(IT_1));
  t("itandi: 広告費 なし", listingAdText(IT_NONE) === "広告費 なし");
  t("itandi: 康熙部首の「⽉」もそのまま", listingAdText(IT_KANGXI) === "広告費 2 ヶ⽉", listingAdText(IT_KANGXI));
  t("資料の文字が無ければ null", listingAdText(null) === null && listingAdText("") === null);
  const s1 = splitAdStamp("A D 2ヶ月（税込）（-1万）");
  t("札の芯と付け足し: 「A D 2ヶ月（税込）」＋「（-1万）」（つなぐと元の文字）", s1.core === "A D 2ヶ月（税込）" && s1.rest === "（-1万）", s1);
  const s2 = splitAdStamp("A D 200％（契約事務手数料10,000円(税込)）");
  t("札の芯と付け足し: 「A D 200％」＋「（契約事務手数料…）」", s2.core === "A D 200％" && s2.core + s2.rest === "A D 200％（契約事務手数料10,000円(税込)）", s2);
  for (const x of [RP_708, RP_713, RP_TAIOU, RP_369, IT_1, IT_NONE, IT_KANGXI]) {
    const a = listingAdText(x) as string; const sp = splitAdStamp(a);
    if (sp.core + sp.rest !== a) t(`芯＋付け足し＝元の文字（${a}）`, false, sp);
  }
  t("芯＋付け足しは全部 元の文字と同じ（1文字も落とさない）", true);
}

console.log("■ 物件名に号室（資料の文字のまま・0 を落とさない）");
{
  t("号室名 703（7階部分）→ 703", listingRoomText(RP_708) === "703");
  t("号室名 0808 → 0808（先頭の 0 を残す）", listingRoomText(RP_713) === "0808");
  t("号室名 00105 → 00105", listingRoomText(RP_706) === "00105");
  t("号室名 005B → 005B（英字付き）", listingRoomText(RP_005B) === "005B");
  t("号室名が無い資料（itandi）は null", listingRoomText(IT_1) === null);
  t("ラ・フォーレ東天満 703", nameWithRoom("ラ・フォーレ東天満", "703") === "ラ・フォーレ東天満 703");
  t("号室が無ければ名前だけ", nameWithRoom("エステムコート難波センチュリオ", null) === "エステムコート難波センチュリオ");
  t("名前の末尾に同じ号室があれば二重にしない", nameWithRoom("ブランメゾン堀川 705", "705") === "ブランメゾン堀川 705" && nameWithRoom("ブランメゾン堀川 705号室", "705") === "ブランメゾン堀川 705号室");
  t("資料の号室を先に（旧の行 room_no「403」↔ 資料「0403」）", cardRoom("403", "0403") === "0403");
  t("資料に号室名が無ければ room_no", cardRoom("0808", null) === "0808" && cardRoom(null, null) === null);
}

console.log("■ 画像で分析をカードの札に");
{
  const a86 = { match: 86, match_raw: 86, ok_count: 5, checks: [{ id: "W1", result: "ok" }, { id: "W2", result: "ok" }, { id: "W3", result: "ok" }, { id: "W4", result: "ng" }, { id: "W5", result: "ok" }, { id: "W6", result: "ok" }, { id: "W7", result: "unknown" }], review: { status: "ok", reasons: [] } };
  t("「🔍 画像 86点（◎5・×1）」", imageChipOf(a86, false)?.text === "🔍 画像 86点（◎5・×1）", imageChipOf(a86, false));
  t("要確認は点を出さない", imageChipOf({ match: null, review: { status: "要確認", reasons: ["号室が違う"] } }, false)?.text === "🔍 画像 要確認");
  t("まだ分析していない: 出す時だけ「🔍 画像の分析待ち」", imageChipOf(null, true)?.text === "🔍 画像の分析待ち" && imageChipOf(null, false) === null);
  t("分析したが点なし", imageChipOf({ match: null, checks: [] }, false)?.kind === "unscored");
  const items = [{ image_analysis: a86 }, { image_analysis: a86 }, { image_analysis: null }, { image_analysis: { review: { status: "要確認" } } }];
  t("回の1行: 「🔍 画像で分析 3/4件（分析待ち 1件・要確認 1件）」", roundImageLine(items) === "🔍 画像で分析 3/4件（分析待ち 1件・要確認 1件）", roundImageLine(items));
  const items2 = [{ image_analysis: a86, status: "pending" }, { image_analysis: null, status: "sent" }, { image_analysis: null, status: "skipped" }, { image_analysis: null, status: "pending" }];
  t("分析待ちは未送信だけを数える（送信済み・見送りは数えない）", roundImageLine(items2) === "🔍 画像で分析 1/4件（分析待ち 1件）", roundImageLine(items2));
  t("1件も分析していなければ回の1行は出さない", roundImageLine([{ image_analysis: null }]) === null);
  t("👑 の行の点: 「判定 162点・画像 86点」", pointsLabel(162, a86) === "判定 162点・画像 86点" && pointsLabel(107, null) === "判定 107点");
}

// ── YUMA の回 cg_509cd061_706 の実物（reason_codes・点・画像の点） ──
const BASE = ["RENT_OK", "RENT_ABOVE_USUAL", "FLOOR_PLAN_MATCH", "SQM_OK", "WALK_OK", "BUILDING_AGE_OK"];
const PASS_2M = [...BASE, "AD_COVERS_DISCOUNT", "AD_HIGH", "EQUIP_BATH_TOILET_MUST_OK", "EQUIP_FLOOR2_OK", "AREA_WARD_MATCH", "COMMUTE_OK", "SEARCH_PINPOINT", "FIT_ALL"];
const R710 = [...BASE, "PROFIT_NEGATIVE", "AD_1M_HELD", "AD_1_5M_HELD", "EQUIP_BATH_TOILET_MUST_OK", "EQUIP_FLOOR2_OK", "AREA_WARD_MATCH", "COMMUTE_OK", "SEARCH_PINPOINT_HELD"];
const R712 = ["RENT_OK", "RENT_ABOVE_USUAL", "ZERO_ZERO", "FLOOR_PLAN_MATCH", "SQM_OK", "WALK_OK", "BUILDING_AGE_OK", "PROFIT_NEGATIVE", "AD_1M_HELD", "EQUIP_BATH_TOILET_UNLISTED", "EQUIP_FLOOR2_OK", "AREA_WARD_MATCH", "COMMUTE_OK", "SEARCH_PINPOINT_HELD", "IMAGE_BATH_TOILET_SEPARATE_OK"];
const R713 = [...BASE, "PROFIT_NEGATIVE", "AD_1M_HELD", "EQUIP_BATH_TOILET_UNLISTED", "EQUIP_FLOOR2_OK", "AREA_WARD_MATCH", "COMMUTE_OK", "SEARCH_PINPOINT_HELD", "IMAGE_BATH_TOILET_SEPARATE_OK"];
const R706 = [...BASE, "PROFIT_NEGATIVE", "AD_1M_HELD", "EQUIP_BATH_TOILET_MUST_OK", "EQUIP_FLOOR2_NG", "AREA_WARD_MATCH", "COMMUTE_OK", "AGE_COL_W10", "SEARCH_PINPOINT_HELD"];

console.log("■ 割引と AD の比べを外して付け直す（rejudgeWithoutDiscount・保存済みの行）");
{
  const p = rejudgeWithoutDiscount(PASS_2M);
  t("#708（通す・162点）: AD_COVERS_DISCOUNT（0点）を外すだけ・点と判定は同じ", p.changed && p.score === 162 && p.verdict === "pass" && !p.reasonCodes.includes("AD_COVERS_DISCOUNT"), [p.score, p.verdict]);
  const r710 = rejudgeWithoutDiscount(R710);
  t("#710 インザグレイス天神橋 603: 保留 107 → 通す 159（AD 1.5ヶ月の段・ピンポイント・全部合う が戻る）", r710.verdict === "pass" && r710.score === 159
    && ["AD_1M", "AD_1_5M", "SEARCH_PINPOINT", "FIT_ALL"].every((c) => r710.reasonCodes.includes(c)) && !r710.reasonCodes.some((c) => c.endsWith("_HELD")) && !r710.flagCodes.length, [r710.score, r710.reasonCodes]);
  const r712 = rejudgeWithoutDiscount(R712);
  t("#712 リブリー野田 501: 保留 115 → 通す 165", r712.verdict === "pass" && r712.score === 165, [r712.score, r712.reasonCodes]);
  const r713 = rejudgeWithoutDiscount(R713);
  t("#713 イーストヴィラ梅田 0808: 保留 107 → 通す 157", r713.verdict === "pass" && r713.score === 157, [r713.score]);
  const r706 = rejudgeWithoutDiscount(R706);
  t("#706 エストドミール野田 00105: 2階以上の × が残るので保留のまま（97 → 107・AD の段は 0点のまま）", r706.verdict === "hold" && r706.score === 107 && r706.reasonCodes.includes("AD_1M_HELD") && r706.flagCodes.includes("EQUIP_FLOOR2_NG"), [r706.score, r706.reasonCodes]);
  t("理由の日本語に「ADより割引が大きい」が残らない", ![r710, r712, r713, r706].some((x) => x.reasonsJa.some((s) => /割引/.test(s))));
  // 付け直す前の画面（詳細 API）と付け直し（backfill）で同じ1行の直し（dropDiscountFromRow）
  const d712 = dropDiscountFromRow({ reason_codes: R712, reasons_ja: ["ADより割引が大きい（利益が出ない）"], score: 115, verdict: "hold", summary_text: "" });
  t("1行の直し #712: 保存 115・保留 → 165・通す（札の差を保存の点に足す）", !!d712 && d712.score === 165 && d712.verdict === "pass" && d712.negative && !d712.reason_codes.includes("PROFIT_NEGATIVE"), d712);
  const d708 = dropDiscountFromRow({ reason_codes: PASS_2M, reasons_ja: ["AD で割引をまかなえる", "間取りが合う"], score: 162, verdict: "pass", summary_text: "" });
  t("1行の直し #708: まかなえるの知らせだけ → 点・判定そのまま・割引の一文だけ外す", !!d708 && d708.score === 162 && d708.verdict === "pass" && !d708.negative && d708.reasons_ja.join() === "間取りが合う", d708);
  t("1行の直し: 札の無い行は null（そのまま使う）", dropDiscountFromRow({ reason_codes: ["RENT_OK"], score: 100, verdict: "pass" }) === null && dropDiscountFromRow({ reason_codes: null }) === null);
  const dOld = dropDiscountFromRow({ reason_codes: R712, score: 90, verdict: "hold", summary_text: "" });
  t("1行の直し: 前の配点の古い行は保存の点＋差（90＋50＝140）", !!dOld && dOld.score === 140, dOld);
  t("割引の比べが無い行は changed=false", rejudgeWithoutDiscount(["RENT_OK", "AD_HIGH"]).changed === false);
  t("冪等（付け直した札をもう一度通しても同じ）", JSON.stringify(rejudgeWithoutDiscount(r710.reasonCodes).reasonCodes) === JSON.stringify(r710.reasonCodes) && rejudgeWithoutDiscount(r710.reasonCodes).score === r710.score);
  t("AD 1ヶ月未満だった行（旧は AD_UNDER_1M を付けなかった）は adMonths が分かれば AD_UNDER_1M −8", rejudgeWithoutDiscount(["RENT_OK", "PROFIT_NEGATIVE"], { adMonths: 0.5 }).reasonCodes.includes("AD_UNDER_1M"));
  const eq = applyEquipmentMatch({ reasonCodes: R710 }, null);
  // 照合なし（null）で付け直すと設備の札（EQUIP_*）も外れるので点は違う。割引の比べが外れて保留が解けることだけ見る
  t("設備の付け直し（applyEquipmentMatch）も割引の比べを外す（保留が解ける）", !eq.reasonCodes.includes("PROFIT_NEGATIVE") && eq.verdict === "pass" && !eq.reasonCodes.some((c) => c.endsWith("_HELD")), [eq.score, eq.verdict]);
}

console.log("■ 👑 と並びは1本（判定の点 → 判定 → 画像の点 → 上限前 → 合う数 → 🌟 → 新しい回 → 順位）");
{
  const AT0 = "2026-09-27T05:41:00.414628+00:00", AT1 = "2026-09-27T05:41:14.006979+00:00";
  const ia = (m: number, ok: number) => ({ match: m, match_raw: m, ok_count: ok, review: { status: "ok" } });
  const mk = (id: number, rank: number, score: number, verdict: string, m: number, ok: number, rec = 0, status = "pending", at = AT1, name = `物件${id}`): BestCandidateRow =>
    ({ id, batch_id: at === AT0 ? "B0" : "B1", created_at: at, rank, status, recommended: rec, property_name: name, room_no: null, verdict, score, image_analysis: ia(m, ok) });
  // 今の保存の点（割引の比べで7件が保留）
  const before = [
    mk(707, 2, 162, "pass", 86, 5, 0, "sent"), mk(708, 3, 162, "pass", 86, 5, 1), mk(709, 4, 159, "pass", 86, 5),
    mk(710, 5, 107, "hold", 83, 4, 2), mk(711, 6, 107, "hold", 86, 5, 1), mk(712, 7, 115, "hold", 83, 4),
    mk(713, 8, 107, "hold", 86, 5), mk(714, 9, 107, "hold", 86, 5), mk(715, 10, 107, "hold", 86, 5), mk(706, 11, 97, "hold", 20, 3, 0, "pending", AT0),
  ];
  t("今の点: 👑 は 🌟 の #708 ラ・フォーレ東天満 703（送った #707 は候補にしない）", pickCustomerBest(before, { basis: "score", windowHours: 49 })?.id === 708);
  t("画面の回の 👑（roundBestId）も同じ #708", roundBestId(before, "score") === 708);
  // 旧の「画像で分析」の吹き出しは #707（送信済み・順位が上）を一番にしていた → 吹き出しは無くなり 👑 は1つ
  const sorted = sortForReview(before.map((r) => ({ ...r, score: r.score ?? null })), 708).map((r) => r.id);
  t("並び: 👑 → 同じ点（162）→ 159 → 保留（115 → 107 は画像の点 86 → 83 の順）", JSON.stringify(sorted) === JSON.stringify([708, 707, 709, 712, 711, 713, 714, 715, 710, 706]), sorted);
  // 割引の比べを外した後（backfill の後）の点
  const after = before.map((r) => ({ ...r, ...(({ 710: [159, "pass"], 711: [159, "pass"], 712: [165, "pass"], 713: [157, "pass"], 714: [157, "pass"], 715: [157, "pass"], 706: [107, "hold"] } as Record<number, [number, string]>)[r.id] ? { score: ({ 710: 159, 711: 159, 712: 165, 713: 157, 714: 157, 715: 157, 706: 107 } as Record<number, number>)[r.id], verdict: r.id === 706 ? "hold" : "pass" } : {}) }));
  const bestAfter = pickCustomerBest(after, { basis: "score", windowHours: 49 });
  t("外した後: 👑 は #712 リブリー野田 501（165）", bestAfter?.id === 712, bestAfter);
  const cg = rankCompleteGroup(after, { basis: "score" });
  t("まとめの順位も同じ1本: 712 → 708 → 707 → 711 → 709 → 710 …（159 どうしは画像の点 86 の #711 が 83 の #710 より上）", JSON.stringify(cg.order.map((o) => o.id).slice(0, 6)) === JSON.stringify([712, 708, 707, 711, 709, 710]), cg.order.map((o) => o.id));
  t("まとめの 👑 と画面の 👑 が同じ", cg.bestId === bestAfter?.id);
  // 同じ判定の点なら画像の点が高い方
  t("同じ判定の点・同じ判定なら画像の点が高い方が上", compareOverall(mk(1, 9, 150, "pass", 90, 3), mk(2, 1, 150, "pass", 80, 6)) < 0);
  t("判定の点が違えば画像の点は見ない（画像の点を判定の点に足さない）", compareOverall(mk(1, 1, 149, "pass", 100, 7), mk(2, 2, 150, "pass", 20, 1)) > 0);
  t("同じ点でも通す＞保留（画像の点より先）", compareOverall(mk(1, 1, 150, "hold", 100, 7), mk(2, 2, 150, "pass", 20, 1)) > 0);
  t("画像の分析待ち（点なし）は同じ判定の点の中で後ろ", compareOverall(mk(1, 1, 150, "pass", 50, 1), { ...mk(2, 2, 150, "pass", 0, 0), image_analysis: null }) < 0);
  t("要確認の画像は点として使わない", compareOverall({ ...mk(1, 1, 150, "pass", 99, 5), image_analysis: { match: 99, review: { status: "要確認" } } }, mk(2, 2, 150, "pass", 10, 1)) > 0);
  t("まとめの決まりの名前に版（前の版のまとめの best_id は使わない）", bestRuleTag("score") === BEST_RULE_TAG && (BEST_RULE_TAG as string) !== "score" && bestRuleTag("image") === "image");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
