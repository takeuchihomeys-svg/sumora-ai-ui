// app/lib/__tests__/room-jo.test.ts
// 洋室の帖数（room-jo.ts）と、判定・画像で分析への組み込みのテスト。
// 実行: npx tsx app/lib/__tests__/room-jo.test.ts
//
// 2026-09-27 竹内「7畳以上は、帖数が資料に書かれていなかったら間取り図から読み取る」（未桜さん「大国町エリアで1Kでできたら7畳以上の部屋で探してます」）
// 実物: お客様の書き方は property_customers の 15人の文そのまま・資料の文字は property_pickups の pdf_text／image_lines の行そのまま・
//   間取り図の読み取りは property_sheet_facts.image_facts.rooms そのまま（お客様の名前・電話は入れない）
import {
  parseRoomJoWants, parseRoomJoMin, roomJoWantOf, readRoomJoItems, roomJoFromText, madoriOfText, mainRoomJo,
  roomJoFromImageRooms, judgeRoomJo,
} from "../room-jo";
import {
  buildCustomerProfile, judgeProperty, parsePropertyFacts, applyRoomJoToRow, applyRoomJoToJudgment, roomJoWantOfCustomer, roomJoCodes,
  ngHitCodes, type CustomerLike,
} from "../property-brain";
import { matchWantsWithFacts, parseSheetText, roomJoOfSheet, type SheetTextFacts } from "../sheet-facts";
import { wantFeatures, imageAnalysisNeed, type ImageWant } from "../image-wants";
import { rowNeedsImage } from "../pickup-auto-targets";
import { judgedFeatures } from "../pickup-image-bonus";
import { cellOfCode } from "../pickup-card-view";
import type { SheetImageFacts } from "../sheet-prompt";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra !== undefined ? ` -- ${JSON.stringify(extra).slice(0, 300)}` : ""}`); }
}

console.log("── お客様の希望（実物の文）");
{
  t("未桜さんの原文 → 7", parseRoomJoMin("大国町エリアで1Kでできたら7畳以上の部屋で探してます") === 7);
  t("「7畳以上の部屋」→ 7", parseRoomJoMin("7畳以上の部屋") === 7);
  t("「7帖以上」→ 7", parseRoomJoMin("7帖以上") === 7);
  t("「1K(7畳)以上」→ 7", parseRoomJoMin("1K(7畳)以上") === 7);
  t("「洋室7帖以上」→ 7", parseRoomJoMin("洋室7帖以上") === 7);
  t("「7畳」だけ → 下限 7", parseRoomJoMin("7畳") === 7);
  t("全角「７畳以上」→ 7", parseRoomJoMin("７畳以上") === 7);
  t("「六畳以上」→ 6", parseRoomJoMin("六畳以上") === 6);
  t("「1k以上、6帖以上」→ 6", parseRoomJoMin("1k以上、6帖以上") === 6);
  t("「寝室8帖以上でダブルとシングルベッド置ける広さ希望」→ 8", parseRoomJoMin("駐車場2台（最悪1台でも可）、ペット可、カウンターキッチン、寝室8帖以上でダブルとシングルベッド置ける広さ希望") === 8);
  const soft = roomJoWantOf(["35平米以上、近ければ嬉しい、風呂トイレ別、収納スペースが広い、水回りが綺麗、できれば寝室4.5畳以上欲しい"]);
  t("「できれば寝室4.5畳以上欲しい」→ 4.5・できれば", soft?.jo === 4.5 && soft.soft === true && soft.approx === false, soft);
  t("「洋室が5~6帖以上」→ 5", parseRoomJoMin("1SLDK.1LDK.2LDK（1LDKの場合は、洋室が5~6帖以上）") === 5);
  t("「5畳以上必須、和室でも可」→ 5", parseRoomJoMin("1つの洋室はダブルベッド置きたいため5畳以上必須、和室でも可、ある程度綺麗であれば築年数は問わない") === 5);
  const approx = roomJoWantOf(["8畳程度"]);
  t("「8畳程度」→ 8・目安", approx?.jo === 8 && approx.approx === true, approx);
  const approx2 = roomJoWantOf(["共益費込み、できれば60000円程度が良い、部屋は広い方が良い（希望は7畳前後）、独立洗面所"]);
  t("「希望は7畳前後」→ 7・目安", approx2?.jo === 7 && approx2.approx === true, approx2);
  t("「1K(収納広ければ7畳～)～広ければ」→ 7", parseRoomJoMin("1K(収納広ければ7畳～)～広ければ") === 7);
  // LDK の帖数は洋室と分ける
  t("「LDK12帖以上」は洋室ではない", parseRoomJoMin("LDK12帖以上") === null);
  t("「LDK12帖以上」→ LDK 12", roomJoWantOf(["LDK12帖以上"], "LDK")?.jo === 12);
  t("「リビング10帖以上」→ LDK 10・洋室なし", roomJoWantOf(["リビング10帖以上"], "LDK")?.jo === 10 && parseRoomJoMin("リビング10帖以上") === null);
  t("「リビング22.1帖」→ LDK", parseRoomJoWants("リビング22.1帖")[0]?.kind === "LDK");
  t("「1LDK(LDK12帖)・洋室6帖以上」→ 洋 6", parseRoomJoMin("1LDK(LDK12帖)・洋室6帖以上") === 6);
  // 希望ではない文
  t("「5帖の部屋にエアコンがないのが気になる」は読まない", parseRoomJoMin("5帖の部屋にエアコンがないのが気になる") === null);
  t("「6畳以下」は上限なので読まない", parseRoomJoMin("6畳以下") === null);
  t("「30平米以上」は帖数ではない", parseRoomJoMin("30平米以上") === null);
  t("空は null", parseRoomJoMin(null, undefined, "") === null);
  // お客様の欄から（未桜さんの条件の欄そのまま）
  const mio: CustomerLike = {
    preferences: "7畳以上の部屋", other_requests: "共益費込みで8万未満希望", floor_plan: "1K", rent_max: 80000,
    additional_conditions: "[9/27 01:04|auto] エリア: 大国町エリア / 間取り: 1K / 希望: 7畳以上の部屋",
    raw_format_text: "何回も送ってきてもらってるのにすみません🥲\n大国町エリアで1Kでできたら7畳以上の部屋で探してます🙇🏻‍♀️🙇🏻‍♀️\nよろしくお願いします",
  };
  t("未桜さんの条件の欄 → 7", roomJoWantOfCustomer(mio)?.jo === 7);
  t("間取りの欄「1K(7畳)以上」→ 7", roomJoWantOfCustomer({ floor_plan: "1K(7畳)以上" })?.jo === 7);
  t("フォームの原文の広さの行「③【希望の広さ・間取り】⇒1k以上、6帖以上」→ 6", roomJoWantOfCustomer({ raw_format_text: "③【希望の広さ・間取り】⇒1k以上、6帖以上\n④【希望築年数】" })?.jo === 6);
  t("帖数の無いお客様は null", roomJoWantOfCustomer({ preferences: "バストイレ別・2階以上", floor_plan: "1LDK" }) === null);
}

console.log("── 資料の文字（実物の行）");
{
  const r = (s: string, plan?: string) => roomJoFromText(s, plan);
  t("「間取タイプ 1K[洋:9.98畳]」→ 9.98", r("間取タイプ 1K[洋:9.98畳]") === 9.98);
  t("「間取タイプ 1K[洋:6.5畳]」→ 6.5", r("間取タイプ 1K[洋:6.5畳]") === 6.5);
  t("「間取タイプ 1K[6.6帖K]」（種類なし）→ 6.6", r("間取タイプ 1K[6.6帖K]") === 6.6);
  t("「間取タイプ 1K[洋6.2帖]」→ 6.2", r("間取タイプ 1K[洋6.2帖]") === 6.2);
  t("「間取タイプ 1K[洋室6.5畳]」→ 6.5", r("間取タイプ 1K[洋室6.5畳]") === 6.5);
  t("「間取タイプ 1K[9.7帖]」→ 9.7", r("間取タイプ 1K[9.7帖]") === 9.7);
  t("「間取タイプ 1K[洋室約8.6帖×K]」→ 8.6", r("間取タイプ 1K[洋室約8.6帖×K]") === 8.6);
  t("「間取タイプ 1K[洋:6.2畳 K:2畳]」→ 洋 6.2（K 2 を混ぜない）", r("間取タイプ 1K[洋:6.2畳 K:2畳]") === 6.2);
  t("「間取タイプ 1K[洋室7.1]」（単位なし）→ 7.1", r("間取タイプ 1K[洋室7.1]") === 7.1);
  t("「間取タイプ 1DK[DK:7.2畳 洋:4.3畳]」→ 洋 4.3（DK 7.2 ではない）", r("間取タイプ 1DK[DK:7.2畳 洋:4.3畳]") === 4.3);
  t("「1LDK[LDK11.9 x 洋4.4]」→ 洋 4.4", r("間取タイプ 1LDK[LDK11.9 x 洋4.4]") === 4.4);
  t("「間取り: 1K【洋6帖】」→ 6", r("間取り: 1K【洋6帖】") === 6);
  t("「間取り: 1K（洋:7畳）」→ 7", r("間取り: 1K（洋:7畳）") === 7);
  t("「間取り: 洋室7帖」→ 7", r("間取り: 洋室7帖") === 7);
  t("「洋室 約7.4帖」→ 7.4", r("1K 洋室 約7.4帖") === 7.4);
  t("「LDK11.2帖・洋室6帖」→ 洋 6", r("1LDK LDK11.2帖・洋室6帖") === 6);
  t("「洋6.0J」→ 6", r("1K 洋6.0J") === 6);
  t("「1K 6帖」（型の直後）→ 6", r("1K 6帖") === 6);
  t("種類なしの帖数は 1DK では使わない（DK の帖数かもしれない）", r("間取タイプ 1DK[7.2帖]") === null);
  t("「バルコニー3帖・収納1帖」は居室ではない", r("1K バルコニー3帖 収納1帖") === null);
  t("「1K」の K に数を付けない（「1K 25.52m2」）", r("間取タイプ 1K\n専有面積 25.52m2") === null);
  t("帖数の無い資料は null", r("物件名 アドバンス上町台シュタット\n間取タイプ 1K\n専有面積 25.52m2") === null);
  t("間取りの型の読み取り（間取タイプの行）", madoriOfText("賃料 80,000円\n間取タイプ 1DK[DK:7.2畳 洋:4.3畳]") === "1DK");
  t("2LDK は居室の一番広い帖数", mainRoomJo(readRoomJoItems("間取タイプ 2LDK[LDK12帖 洋6帖 洋4.5帖]"), "2LDK") === 6);
  // 実物の資料の文字層（property_pickups 610・抜粋）
  const pdf610 = "千日前線「谷町九丁目」徒歩8分\n建築構造 鉄筋コンクリート造 地上15階 総戸数56戸\n間取タイプ 1K[洋室7.1]\n専有面積 25.52m2 開口部方位 南";
  t("実物 610（1K[洋室7.1]）→ 7.1", r(pdf610) === 7.1);
  t("実物 #711「間取タイプ 1K[9.3xK]」→ 9.3（図の読み 6.5 は読み違い）", r("間取タイプ 1K[9.3xK]\n専有面積 30.08m2") === 9.3);
  t("実物 #678「間取タイプ 1K[25.39]」は専有面積なので読まない", r("間取タイプ 1K[25.39]") === null);
}

console.log("── 間取り図の読み取り（sheet-prompt の rooms・実物）");
{
  t("[洋室6.2, K null] → 6.2", roomJoFromImageRooms([{ jo: 6.2, name: "洋室" }, { jo: null, name: "K" }], "1K") === 6.2);
  t("[Bedroom 6.1] → 6.1", roomJoFromImageRooms([{ jo: 6.1, name: "Bedroom" }], "1K") === 6.1);
  t("[居室 6.2] → 6.2", roomJoFromImageRooms([{ jo: 6.2, name: "居室" }], "1K") === 6.2);
  t("[洋室6, K 3] → 6（K を混ぜない）", roomJoFromImageRooms([{ jo: 6, name: "洋室" }, { jo: 3, name: "K" }], "1K") === 6);
  t("[洋室7.5, K, ロフト] → 7.5", roomJoFromImageRooms([{ jo: 7.5, name: "洋室" }, { jo: null, name: "K" }, { jo: 4, name: "ロフト" }], "1K") === 7.5);
  t("帖数が読めない図は null", roomJoFromImageRooms([{ jo: null, name: "洋室" }, { jo: null, name: "K" }], "1K") === null);
}

console.log("── 判定の線");
{
  const w7 = { jo: 7, approx: false };
  t("7 以上 → ok", judgeRoomJo(w7, 7) === "ok" && judgeRoomJo(w7, 7.1) === "ok");
  t("6.9 → ng", judgeRoomJo(w7, 6.9) === "ng");
  t("読めない → unknown", judgeRoomJo(w7, null) === "unknown");
  t("目安（7畳前後）は 6 まで ok・5.9 は ng", judgeRoomJo({ jo: 7, approx: true }, 6) === "ok" && judgeRoomJo({ jo: 7, approx: true }, 5.9) === "ng");
  t("札: 狭い＝ROOM_JO_NG・目安で狭い＝ROOM_JO_SOFT_NG", roomJoCodes({ kind: "洋", jo: 7, approx: false, soft: false, text: "" }, 6.5)[0] === "ROOM_JO_NG"
    && roomJoCodes({ kind: "洋", jo: 8, approx: true, soft: false, text: "" }, 6.5)[0] === "ROOM_JO_SOFT_NG");
  t("希望が無ければ札なし", roomJoCodes(null, 6).length === 0);
  t("図の読みだけで狭い → ROOM_JO_IMG_NG（保留）", roomJoCodes({ kind: "洋", jo: 7, approx: false, soft: false, text: "" }, 6.5, "間取り図")[0] === "ROOM_JO_IMG_NG");
}

console.log("── judgeProperty（未桜さんの条件・実物の説明文の形）");
{
  const mio: CustomerLike = { preferences: "7畳以上の部屋", floor_plan: "1K", rent_max: 80000 };
  const profile = buildCustomerProfile(mio);
  const SUM = "【3】アドバンス上町台シュタット 403号室\n75,000円 5,000円\n1K 25.52㎡\n近鉄大阪線「大阪上本町」徒歩7分\nAD 2ヶ月";
  const withJo = (jo: number | null) => { const f = parsePropertyFacts(SUM); if (jo != null) { f.roomJo = jo; f.roomJoFrom = "資料"; } return judgeProperty(f, profile, 0); };
  const ok = withJo(7.1), ng = withJo(6.5), un = withJo(null);
  t("7.1帖 → ROOM_JO_OK・通す", ok.reasonCodes.includes("ROOM_JO_OK") && ok.verdict === "pass", ok);
  t("6.5帖 → ROOM_JO_NG・外す候補", ng.reasonCodes.includes("ROOM_JO_NG") && ng.verdict === "drop", ng.reasonCodes);
  t("外す候補は AD の段を 0点（_HELD）に", ng.reasonCodes.includes("AD_HIGH_HELD"), ng.reasonCodes);
  t("外す候補は ngHitCodes に入る（質の高い10件に入れない）", ngHitCodes(ng.reasonCodes).includes("ROOM_JO_NG"));
  // 読めない時は 0点（書いた条件の数に入らないので「全部合う」が半分の +8 になる＝ok の 118 より 10 低い）
  t("読めない → ROOM_JO_UNKNOWN（0点・判定は変えない）", un.reasonCodes.includes("ROOM_JO_UNKNOWN") && un.verdict === ok.verdict && un.score < ok.score, { un: un.score, ok: ok.score });
  t("理由の日本語に要確認が出る", un.reasonsJa.some((x) => /洋室の帖数/.test(x)), un.reasonsJa);
  // 説明文に帖数があれば説明文から
  const fromSummary = parsePropertyFacts("【1】X 101号室\n60,000円\n1K[洋:7畳] 22.1㎡\nAD 1ヶ月");
  t("説明文の「1K[洋:7畳]」→ roomJo 7", fromSummary.roomJo === 7 && fromSummary.roomJoFrom === "資料", fromSummary);
  // 希望の無いお客様は今まで通り（札を足さない）
  const plain = judgeProperty(parsePropertyFacts(SUM), buildCustomerProfile({ floor_plan: "1K", rent_max: 80000 }), 0);
  t("帖数の希望が無いお客様は ROOM_JO_* を付けない", !plain.reasonCodes.some((c) => c.startsWith("ROOM_JO_")), plain.reasonCodes);
  // 後から読めた帖数で付け直す（間取り図の読み取り）
  const row = { reason_codes: un.reasonCodes, score: un.score, verdict: un.verdict };
  const rNg = applyRoomJoToRow(row, profile.roomJoWant, 6.2);
  t("付け直し: 図の読みだけで 6.2帖 → 保留（ROOM_JO_IMG_NG・外す候補にしない）", rNg?.verdict === "hold" && rNg.reason_codes.includes("ROOM_JO_IMG_NG") && !rNg.reason_codes.includes("ROOM_JO_UNKNOWN"), rNg);
  const rTxt = applyRoomJoToRow(row, profile.roomJoWant, 6.2, "資料");
  t("付け直し: 資料の文字で 6.2帖 → 外す候補", rTxt?.verdict === "drop" && rTxt.reason_codes.includes("ROOM_JO_NG"), rTxt);
  const rOk = applyRoomJoToRow(row, profile.roomJoWant, 7.5);
  t("付け直し: 図で 7.5帖 → 通す・文字で読めた時と同じ点", rOk?.verdict === "pass" && rOk.score === ok.score, rOk);
  t("付け直し: 読めない時は書き換えない", applyRoomJoToRow(row, profile.roomJoWant, null) === null);
  t("付け直し: もう決まった行は書き換えない", applyRoomJoToRow({ reason_codes: ok.reasonCodes, score: ok.score, verdict: ok.verdict }, profile.roomJoWant, 5) === null);
  const j2 = applyRoomJoToJudgment(un, profile.roomJoWant, 6, "資料");
  t("判定（Judgment）に当てる: 画像の行 6帖 → 外す候補・画像の確かめは止める", j2.verdict === "drop" && j2.imageChecks.length === 0 && j2.facts.roomJo === 6, j2.reasonCodes);
}

console.log("── 画像で分析（照合は決まった手順・DeepSeek に聞かない）");
{
  const want: ImageWant = { id: "W1", source: "条件", text: "7畳以上の部屋", topics: ["size"], ng: false, must: false };
  t("「7畳以上の部屋」は room_jo の希望", wantFeatures(want.text).includes("room_jo"));
  t("「5帖の部屋にエアコンがないのが気になる」は room_jo にしない", !wantFeatures("5帖の部屋にエアコンがないのが気になる").includes("room_jo"));
  t("帖数の希望だけでも画像で分析を勧める（自動で読む）", imageAnalysisNeed([want]).level === "recommended" && imageAnalysisNeed([want]).labels.includes("洋室の帖数"));
  const text: SheetTextFacts = parseSheetText("物件名 アドバンス上町台シュタット\n号室名 403\n間取タイプ 1K[洋:6.3畳]\n専有面積 25.52m2\n賃料 80,000円\n" + "x".repeat(40));
  t("資料の文字層の roomJo（「洋:」の形）", text.roomJo === 6.3, text.roomJo);
  const m1 = matchWantsWithFacts([want], text, null, "1K");
  t("資料 6.3帖 → ng（undecided にしない）", m1.checks[0]?.result === "ng" && m1.undecided.length === 0, m1);
  const noJo: SheetTextFacts = parseSheetText("物件名 X\n間取タイプ 1K\n専有面積 25.52m2\n賃料 80,000円\n" + "x".repeat(40));
  const img = (rooms: SheetImageFacts["rooms"]): SheetImageFacts => ({ see: "", fp_ok: true, other_unit: false, madori: "1K", rooms, area_sqm: null, type_label: "",
    kitchen: { placement: "不明", stove: "不明", burners: null }, water: { bath_toilet: "不明", washbasin: "不明", laundry: "不明" }, living_bedroom: "不明",
    storage: { wic: "不明", labels: [], closets: null, shoes: "不明" }, balcony: "不明", note: "" } as SheetImageFacts);
  const m2 = matchWantsWithFacts([want], noJo, img([{ name: "洋室", jo: 7.5 }, { name: "K", jo: null }]), "1K");
  t("資料に無ければ間取り図 7.5帖 → ok", m2.checks[0]?.result === "ok" && /間取り図/.test(m2.checks[0]?.why ?? ""), m2);
  const m3 = matchWantsWithFacts([want], noJo, img([{ name: "洋室", jo: null }]), "1K");
  t("図でも読めない → unknown", m3.checks[0]?.result === "unknown", m3);
  // 付け直しに使う帖数（資料が先・図は一致した時だけ）
  t("roomJoOfSheet: 資料が先", roomJoOfSheet(text, img([{ name: "洋室", jo: 8.3 }]), true)?.from === "資料");
  t("roomJoOfSheet: 図は review ok の時だけ", roomJoOfSheet(noJo, img([{ name: "洋室", jo: 6.2 }]), true)?.jo === 6.2 && roomJoOfSheet(noJo, img([{ name: "洋室", jo: 6.2 }]), false) === null);
  // 自動で読む物件の選び方
  t("文字で決まった物件（ROOM_JO_OK）は読まない", rowNeedsImage(["room_jo"], null, ["ROOM_JO_OK"]) === false);
  t("要確認（ROOM_JO_UNKNOWN）は読む", rowNeedsImage(["room_jo"], null, ["ROOM_JO_UNKNOWN"]) === true);
  // 画像の加点と二重に数えない
  t("判定で決まった帖数は画像の加点に足さない", judgedFeatures(["ROOM_JO_OK"]).has("room_jo") && judgedFeatures(["ROOM_JO_NG"]).has("room_jo") && !judgedFeatures(["ROOM_JO_UNKNOWN"]).has("room_jo"));
  t("カードの項目「洋室の帖数」", cellOfCode("ROOM_JO_NG")?.head === "洋室の帖数");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
