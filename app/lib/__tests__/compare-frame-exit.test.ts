// app/lib/__tests__/compare-frame-exit.test.ts
// 2026-10-06 竹内（R・F asecia fonte 302 の物件オススメ）「複数の物件送った中で1件オススメする時は お送りさせて頂きましたお部屋の中でも使う。1件だけの場合は使わない」
//   出口（本文から比較の形を外す）は確かな時だけ: 束（AIX 物件ピックアップ）から1時間超・束の後に手で送った画像が無い・比較の場面でない
// 実行: npx tsx app/lib/__tests__/compare-frame-exit.test.ts
import { fixRecommendClosing, hasComparisonFrame } from "../recommend-closing";
import { compareFrameExitAllowed, hasManualImagesAfterBundle, resolveRecommendationScenario } from "../recommendation-frame";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") { if (cond) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); } }

// ── 実物（R・10/04 18:44 の下書き。束は2日前の3部屋・推したのは束に無い1件）
const R_DRAFT = "お送りさせて頂きましたお部屋の中でも特にF asecia fonte 302号室が敷金礼金なしで初期費用を抑える事ができ・2021年3月築で築年数浅く、かなりオススメ出来るお部屋となります！！\n\nお手隙の際にご査収ください😊！！";
t("R: 入口 — ピッカーなし・束から48.9時間 → 比較しない（追加提案）",
  resolveRecommendationScenario({ actionType: "property_recommendation", pickupType: null, checkPattern: null, facts: { priorSentPropertyCount: 5, priorBulkSendCount: 4, priorSingleSendCount: 1, hoursSinceLastSend: 48.9, brainSentPropertyCount: 9, hoursSinceLastBundle: 48.9, starInLastBundle: false } }) === "followup_single");
t("R: 出口を掛ける（束から48.9時間・手の画像なし）", compareFrameExitAllowed("followup_single", 48.9, false) === false);
{
  const r = fixRecommendClosing(R_DRAFT, { sentPropertyCount: 9, compareAllowed: false, notViewable: false });
  t("R: 比較の形だけ外れて物件名から始まる", r.text.startsWith("F asecia fonte 302号室が敷金礼金なしで") && r.applied.includes("comparison_frame"), r.text);
  t("R: 締めはそのまま", r.text.endsWith("お手隙の際にご査収ください😊！！"));
}
t("R: 件数（9件）だけでは今まで通り外さない", fixRecommendClosing(R_DRAFT, { sentPropertyCount: 9, notViewable: false }).applied.length === 0);

// ── 出口を掛けない時（誤って消さない）
t("比較の場面（継続ピックアップ等）は外さない", compareFrameExitAllowed("compare", 72, false) === true);
t("束の直後（1時間以内）は出口では決めない", compareFrameExitAllowed("followup_single", 0.2, false) === null);
t("束が AIX の記録に無い（手で束を送っていることがある）→ 決めない", compareFrameExitAllowed("followup_single", null, false) === null);
t("束の時間が分からない → 決めない", compareFrameExitAllowed("followup_single", undefined, false) === null);
t("束の後に手で画像を送っている → 決めない", compareFrameExitAllowed("followup_single", 6.4, true) === null);
t("シナリオが無い → 決めない", compareFrameExitAllowed(null, 48, false) === null);
{
  const kept = fixRecommendClosing(R_DRAFT, { sentPropertyCount: 9, compareAllowed: null, notViewable: false });
  t("compareAllowed=null・9件 → 本文はそのまま", kept.text === R_DRAFT);
}

// ── 言い換えも同じ語（実送信の形）
t("お送りさせていただいたお部屋の中でも", hasComparisonFrame("お送りさせていただいたお部屋の中でもフェルザ住之江公園 902号室が"));
t("お送りさせて頂いた物件の中でも特に", hasComparisonFrame("お送りさせて頂いた物件の中でも特にプレジオ松屋町は"));
t("これまでお送りさせて頂いたお部屋の中でも", hasComparisonFrame("これまでお送りさせて頂いたお部屋の中でも特にX 101号室が"));
t("お送りした中でも", hasComparisonFrame("お送りした中でもX 101号室が"));
t("送らせて頂いたお部屋の中でも", hasComparisonFrame("送らせて頂いたお部屋の中でもX 101号室が"));
t("お客様が送った物件（お送り頂きました物件の中で）は拾わない", !hasComparisonFrame("a🤫さんお送り頂きました物件の中で ・東住吉区照ヶ丘矢田2丁目貸テラス"));
t("お送り頂きましたお部屋の中でも（相手の送付）は拾わない", !hasComparisonFrame("お送り頂きましたお部屋の中でもこちらは募集中となります"));

// ── 外した後の形（全件監査で読んだ実物）
{
  const r = fixRecommendClosing("みやびさんにお送りさせて頂きましたお部屋の中でもリアライズ南巽は2024年築の1LDKでお部屋の条件が良く、特にオススメのお部屋となります！", { sentPropertyCount: 9, compareAllowed: false });
  t("呼びかけの「に」を残さない（みやびさんにリアライズ… にしない）", r.text.startsWith("みやびさん\nリアライズ南巽は2024年築"), r.text);
}
{
  const r = fixRecommendClosing("お送りさせて頂きましたお部屋の中でも\nパルビゾン箕面が特にオススメのお部屋となります！！\n\nお手隙の際にご査収ください😊！！", { sentPropertyCount: 9, compareAllowed: false });
  t("比較の形だけの行は行ごと消える", r.text.startsWith("パルビゾン箕面が特にオススメ"), r.text);
}
{
  const r = fixRecommendClosing("林田さん\nお送りさせて頂きましたお部屋の中でも特にエクセレント大阪城公園 00401号室が、天満橋駅徒歩7分で、林田さんにオススメ出来るお部屋となります！！", { sentPropertyCount: 9, compareAllowed: false });
  t("呼びかけの行は残る", r.text.startsWith("林田さん\nエクセレント大阪城公園 00401号室が、"), r.text);
}

// ── 束の後に手で送った画像
{
  const now = Date.parse("2026-10-04T09:44:00Z");
  const h = (Date.parse("2026-10-04T09:44:00Z") - Date.parse("2026-10-02T08:52:54Z")) / 3_600_000;
  const msgs = [
    { sender: "staff", text: "[画像]", created_at: "2026-10-02T08:52:52Z" },
    { sender: "staff", text: "Rさん …ピックアップさせて頂きました！！", created_at: "2026-10-02T08:52:53Z" },
    { sender: "staff", text: "[画像]", created_at: "2026-10-02T09:39:35Z" },
    { sender: "customer", text: "ここが安かったですよね。", created_at: "2026-10-02T09:58:56Z" },
    { sender: "staff", text: "[画像]", created_at: "2026-10-04T09:43:51Z" },
    { sender: "staff", text: "[画像]", created_at: "2026-10-04T09:43:51Z" },
  ];
  t("R: 束の後の画像は見積書の1枚だけ・今の通の画像は数えない → 手の画像なし", hasManualImagesAfterBundle(msgs, h, now) === false);
  const more = [...msgs, { sender: "staff", text: "[画像]", created_at: "2026-10-03T03:00:00Z" }, { sender: "staff", text: "[画像]", created_at: "2026-10-03T03:00:01Z" }];
  t("束の後に手で2枚以上 → あり", hasManualImagesAfterBundle(more, h, now) === true);
  t("会話が束の時刻まで届いていない → 分からない（あり側）", hasManualImagesAfterBundle(msgs.slice(3), h, now) === true);
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
