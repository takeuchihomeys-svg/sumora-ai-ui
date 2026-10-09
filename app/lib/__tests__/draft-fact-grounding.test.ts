// 下書きの事実の照らし（app/lib/draft-fact-grounding.ts・canAutoReply ⑥-3c）のテスト。
// 2026-10-09。文は scripts/audit-draft-fact-grounding.ts（90日）の実物の形（名前・番号は伏せ・物件名だけ残す）。
// 実行: npx tsx app/lib/__tests__/draft-fact-grounding.test.ts
import { extractDraftFacts, findUngroundedFacts, groundingKinds, buildGroundIndex, groundFact, aixForUngroundedFact } from "../draft-fact-grounding";
import { canAutoReply, type AutoReplyInput } from "../auto-reply-policy";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") { if (cond) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); } }

// ── 作り話（AI の下書き・実物）──
const FAKE_SLOTS = "お部屋ご案内させて頂きます！！\n直近ですと\n7月18日(土)13:00〜16:00\n7月19日(日)16:00〜18:00\nにてご案内可能です😌！！";
const FAKE_MOVEIN = "審査がスムーズに進みますと8/5〜8/7頃のご入居も可能となります😊!";
const GROUND_MOVEIN = "お客様: いつ頃入居できますか？\nスタッフ: 審査がスムーズに進みますと8/3〜8/7頃のご入居も可能となります！！";
// ── 根拠あり ──
const DRAFT_OK = "かしこまりました！！\n10/8 13:00にカーサ・クラシオンF 302号室で何卒よろしくお願い致します！！";
const GROUND_OK = "お客様: 13時から14時半でお願いします。\n【AIX】10/8 13:00にカーサ・クラシオンF 302号室\n現地エントランスお待ち合わせ";

console.log("── 抜き出し");
{
  const f = extractDraftFacts(FAKE_SLOTS);
  t("候補日の日付と時刻を拾う", f.some((x) => x.kind === "date" && x.key === "7/18") && f.some((x) => x.kind === "time" && x.key === "13:00"));
  t("物件名＋号室を拾う", extractDraftFacts(DRAFT_OK).some((x) => x.kind === "property_name" && /カーサ/.test(x.value)));
  t("条件・質問の文は拾わない", extractDraftFacts("ご希望のお日にち（例 10/8 13:00）御座いますでしょうか？").length === 0);
  t("★ 申込のフォーマットの「・駐輪場利用の有無」は拾わない（90日の監査の誤検知）", extractDraftFacts("・駐輪場利用の有無").length === 0);
  t("★ 文の切れ端「現在募集中の301号室」を物件名にしない", !extractDraftFacts("現在募集中の301号室家賃は5,000円高くなります").some((x) => x.kind === "property_name"));
}

console.log("── 照らし");
{
  t("★ 作った内覧の候補日は根拠なし", findUngroundedFacts(FAKE_SLOTS, "お客様: 内覧したいです").some((h) => h.kind === "date"));
  t("★ 作った入居可能日（8/5）は根拠なし・材料にある 8/7 は根拠あり", (() => { const h = findUngroundedFacts(FAKE_MOVEIN, GROUND_MOVEIN); return h.some((x) => x.key === "8/5") && !h.some((x) => x.key === "8/7"); })());
  t("材料にある日時・号室・物件名は止めない", findUngroundedFacts(DRAFT_OK, GROUND_OK).length === 0, JSON.stringify(findUngroundedFacts(DRAFT_OK, GROUND_OK)));
  t("号室の先頭の 0（0503 と 503）は同じ", findUngroundedFacts("エスリードレジデンスグラン大阪福島ノース 503号室ご案内可能です", "エスリードレジデンスグラン大阪福島ノース 0503号室").length === 0);
  t("日付の別の書き方（2026-10-08）も根拠", groundFact(extractDraftFacts("10月8日にご案内させて頂きます！！")[0], buildGroundIndex("viewing 2026-10-08 13:00")).grounded);
  t("材料が無い時（groundText 空）は判定しない", findUngroundedFacts(FAKE_SLOTS, "").length === 0);
  t("読み取りの化け（エヴゼ峰渡西II ↔ エグゼ難波西Ⅱ）は止めない（あいまい）", findUngroundedFacts("お送り頂きましたエヴゼ峰渡西II 202号室のご内覧可否確認させて頂きます!", "エグゼ難波西Ⅱ 202号室").filter((h) => h.kind === "property_name").length === 0);
}

console.log("── 種類と戻し");
{
  const k = groundingKinds({});
  t("既定は全部の種類（日付・時刻・号室・物件名・設備・広さ・階・ペット・内訳…）", k.has("date") && k.has("property_name") && k.has("facility") && k.has("floor") && k.has("pet") && k.has("cost_item"));
  t("DRAFT_FACT_GROUNDING=off で止めない", groundingKinds({ DRAFT_FACT_GROUNDING: "off" }).size === 0);
  t("DRAFT_FACT_GROUNDING_KINDS で種類を選べる", [...groundingKinds({ DRAFT_FACT_GROUNDING_KINDS: "date,facility" })].join(",") === "date,facility");
}

console.log("── 細かい種類（10/09）と本来の AIX");
{
  // 竹内さんの手打ちの実物（材料の外＝資料の画像を読めていない物件）
  const g0 = "スタッフ: 【AIX】[画像]\nお客様: こちらいいですね";
  const area = findUngroundedFacts("60m2とかなり広めの2LDK.フルリノベーション物件の為内装綺麗です!", g0);
  t("★ 材料に無い広さ（60m2）は根拠なし", area.some((h) => h.kind === "area"));
  t("資料の読み取りの JSON（area_sqm 60）があれば根拠あり", findUngroundedFacts("60m2とかなり広めの2LDKです!", `${g0}\n{"area_sqm": 60, "floor": 13}`).filter((h) => h.kind === "area").length === 0);
  t("階は号室の頭の数字（1302 → 13階）でも根拠", findUngroundedFacts("こちら13階のお部屋となります!", "モノトーン難波 1302号室").filter((h) => h.kind === "floor").length === 0);
  t("★ ペット飼育不可（材料に無い）→ 根拠なし・AIX は物件確認した→ペットの可否", (() => { const h = findUngroundedFacts("こちらのお部屋はペット飼育不可となります!", g0).find((x) => x.kind === "pet"); return !!h && aixForUngroundedFact(h).catalogKey === "property_check_result/mgmt_pet"; })());
  t("お客様の条件の行（\"pet\": true）はペット可の根拠にしない", findUngroundedFacts("こちらペット可能なお部屋となります!", '{"pet": true}').some((h) => h.kind === "pet"));
  t("礼金の月数は資料の JSON（key_money_months）で照らす", findUngroundedFacts("礼金1ヶ月必要となります!", '{"key_money_months": 1}').filter((h) => h.kind === "cost_item").length === 0);
  t("★ 敷礼なしと書いた資料なら「礼金なし」は根拠あり", findUngroundedFacts("礼金なしのお部屋となります!", "敷礼なし・駅徒歩5分").filter((h) => h.kind === "cost_item").length === 0);
  t("キャンセル料は会社の事実にあれば根拠", findUngroundedFacts("キャンセル料はかかりません!", "会社の事実: 申込後のキャンセル料はかからない").filter((h) => h.kind === "cancel_fee").length === 0);
  t("「〇㎡以上」は条件（拾わない）", extractDraftFacts("25㎡以上のお部屋でピックアップさせて頂きます").length === 0);
  // 本来の AIX
  const one = (draft: string) => aixForUngroundedFact(extractDraftFacts(draft)[0]).catalogKey;
  t("★ 作った内覧の候補日 → 内覧調整", one("10/12(土)13:00〜15:00にてご案内可能です") === "viewing_invite/通常");
  t("★ 作った入居可能日 → 物件確認した→入居可能日", one("8/5〜8/7頃のご入居も可能となります") === "property_check_result/mgmt_move_in");
  t("退去予定日 → 物件確認した→退去予定日", one("9/30退去予定となります") === "property_check_result/vacate_date");
  t("推しどころの箇条書き（・南向き）→ 物件オススメ", one("・南向きで採光良好") === "property_recommendation/継続ピックアップ");
  t("ペットの時の敷金 → 物件確認した→ペット", one("ペット飼育時敷金1ヶ月") === "property_check_result/mgmt_pet");
}

console.log("── canAutoReply ⑥-3c");
{
  const base: AutoReplyInput = { autoSendEnabled: true, lastSender: "customer", replyMode: "auto_reply", suggestedAixAction: null, draft: FAKE_MOVEIN, draftHasBlock: false, status: "proposing", hasPendingScheduled: false, groundText: GROUND_MOVEIN };
  const v = canAutoReply(base);
  t("★ 作った入居可能日の下書きは自動で送らない", !v.ok && v.reason === "staff_only_fact:ungrounded_date", v.reason);
  const ok = canAutoReply({ ...base, draft: "かしこまりました！！\n8/3〜8/7頃のご入居も可能となります！！よろしくお願い致します！！", groundText: GROUND_MOVEIN });
  t("材料にある日付だけなら止めない", ok.reason !== "staff_only_fact:ungrounded_date", ok.reason);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
