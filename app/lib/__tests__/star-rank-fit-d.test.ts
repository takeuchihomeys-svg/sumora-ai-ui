// 2026-10-06d 🌟（👑）の並べ方: 同点を AD → 初期費用面で分ける・1LDK以上の「一番新しい」でリノベ済みを築0とみなす・
// 見積書の割引から AD を補う関数・新着1件に刺さったかの印。根拠は scripts/audit-star-fit-d.ts
// 実行: npx tsx app/lib/__tests__/star-rank-fit-d.test.ts
import { rankStarCandidates, starTieBreak, starSituationOf, STAR_RANK_RULE, STAR_FIT_RULE_TAG, type StarCandidate } from "../recommend-star-rank";
import { renovationOfText } from "../listing-renovation";
import { adHintFromDiscount, estimateAdHintFor, ESTIMATE_AD_HINT_RULE } from "../estimate-ad-hint";
import { newArrivalHookOf } from "../new-arrival-hook";
import { starCandidateOfPickup, renovatedOfPickup, initialMonthsOfPickup } from "../star-rank-pickup";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ""}`); }
}
const cand = (key: string, o: Partial<StarCandidate> = {}): StarCandidate => ({ key, codes: [], score: 100, pointsOf: () => 0, adMonths: 2, ...o });

// ── リノベの読み（資料の実物の文字）──
t("◆リノベーション物件 → true", renovationOfText("犬猫2匹まで) ◆リノベーション物件 ◆事務所利用可") === true);
t("こだわりの札「, リノベーション ,」→ true", renovationOfText("日当り良好 , 分譲タイプ , リノベーション , 敷地内ごみ置き場") === true);
t("「内 装リフォーム済」（PDF で語が割れる）→ true", renovationOfText("分譲タイプ , 内 装リフォーム済 , 振分") === true);
t("「令和3年8月に室内改装済み」→ true", renovationOfText("特記事項: 令和3年8月に室内改装済み ・保証会社") === true);
t("「フルリノベ中です」→ true（入居の時には改装済み）", renovationOfText("好立地!フルリノベ中です☆彡3DK→2LDKへ") === true);
t("ITANDI「・リノベー ション 6058004 出力日」→ true", renovationOfText("カギ交換費用:16,500円(入居時)・リノベー ション 6058004 出力日:2026") === true);
t("ITANDI「リノベーション:[内装]システムキッチン交換」→ true", renovationOfText("・リノベーション:[内装]システムキッチン交換(2024)") === true);
t("物件名「パークモダン新大阪（フルリノベーション）」→ true", renovationOfText("パークモダン新大阪（フルリノベーション）") === true);
t("「エントランスリノベーション工事予定」→ false（共用部・予定）", renovationOfText("■エントランスリノベーション工事予定 ・ゴミ庫が裏側駐輪場に") === false);
t("「共用部リノベ ーション完了」→ false", renovationOfText("好立地マンション・共用部リノベ ーション完了 ★★1階に") === false);
t("「リノベーション:[外装]エントランス」→ false", renovationOfText("・リノベーション:[外装]エントランス(2025)") === false);
t("「プチリノベ実施!洗面所とトイレに棚新設」→ false", renovationOfText("プチリノベ実施!洗面所とトイレに棚新設♪♪") === false);
t("「リフォーム中」「リフォーム後現状有姿」→ false", renovationOfText("備考 リフォーム中 ≪ 諸費用 ≫") === false && renovationOfText("※リフォーム後、室内現状有姿") === false);
t("「畳リフォーム済み」→ false（畳だけ）", renovationOfText("特殊清掃・畳リフォーム済み)") === false);
t("「外装リフォーム済」だけ → false", renovationOfText("モニタ付インターホン , 外装リフォーム済 , ペット対応") === false);
t("文字なし → null", renovationOfText("") === null && renovationOfText(null) === null);

// ── 同点の分け方 ──
t("同点: AD が高い方が先", starTieBreak(cand("A", { adMonths: 2 }), cand("B", { adMonths: 3 })) > 0);
t("同点: AD 不明は分かる物の後", starTieBreak(cand("A", { adMonths: null }), cand("B", { adMonths: 1.5 })) > 0);
t("同点: 同じ AD なら敷礼0", starTieBreak(cand("A", { zeroZero: false }), cand("B", { zeroZero: true })) > 0);
t("同点: 次にフリーレント", starTieBreak(cand("A"), cand("B", { codes: ["FREE_RENT_MATCH"] })) > 0);
t("同点: 次に敷金＋礼金が少ない", starTieBreak(cand("A", { initialMonths: 2 }), cand("B", { initialMonths: 1 })) > 0);
t("同点: どれも同じなら 0（元の並び）", starTieBreak(cand("A"), cand("B")) === 0);
{
  const r = rankStarCandidates([cand("A", { adMonths: 2 }), cand("B", { adMonths: 3 })]);
  t("並べ方: 合い方が同じなら AD 3 の B が🌟", r[0].key === "B" && r[0].fit === r[1].fit, r);
  const r2 = rankStarCandidates([cand("A", { adMonths: 2 }), cand("B", { adMonths: 3 })], { ...STAR_RANK_RULE, tieBreak: false });
  t("tieBreak:false なら元の並び（A）", r2[0].key === "A");
  const r3 = rankStarCandidates([cand("A", { adMonths: 2, score: 101 }), cand("B", { adMonths: 3 })]);
  t("合い方が1点でも上なら AD で覆さない（A）", r3[0].key === "A");
}

// ── 1LDK以上の希望でリノベ済みを新しい側に ──
{
  const hh = starSituationOf({ household: true });
  // 実物の形: 🌟 ライフ野江 401（築35・本文「リノベーション」）／束の一番新しいは築10
  const cs = [cand("新しい", { buildingAge: 10 }), cand("リノベ", { buildingAge: 35, renovated: true })];
  const r = rankStarCandidates(cs, STAR_RANK_RULE, hh);
  t("1LDK以上: リノベ済み（築35）は築0とみなして +15（築10 は束の一番新しい +8 だけ）→ リノベが🌟", r[0].key === "リノベ" && r[0].fit - r[1].fit === 7, r);
  const r2 = rankStarCandidates([cand("新しい", { buildingAge: 10 }), cand("リノベ", { buildingAge: 35, renovated: true, adMonths: 2.5 })], STAR_RANK_RULE, hh);
  t("1LDK以上: 理由に「リノベ済みで一番新しい側」", r2[0].key === "リノベ" && r2[0].reasons.some((x) => /リノベ済みで一番新しい側/.test(x)), r2);
  const r3 = rankStarCandidates(cs, STAR_RANK_RULE, starSituationOf({}));
  t("一人暮らし（1LDK以上でない）: リノベは見ない（束の一番新しい +8 は築10）", r3[0].key === "新しい", r3);
  const r4 = rankStarCandidates(cs, { ...STAR_RANK_RULE, renoAge: null }, hh);
  t("renoAge:null なら 06c と同じ（築10 が +15）", r4[0].key === "新しい" && r4[0].fit - r4[1].fit >= 15, r4);
  const r5 = rankStarCandidates([cand("新しい", { buildingAge: 10 }), cand("古い", { buildingAge: 35 })], STAR_RANK_RULE, hh);
  t("リノベでない古い部屋は今まで通り（新しい方に +15）", r5[0].key === "新しい" && r5[0].fit - r5[1].fit >= 15, r5);
}

// ── 見積書の割引 → AD の補い ──
t("線は 0.5ヶ月・補う AD は 1.5", ESTIMATE_AD_HINT_RULE.ratioLine === 0.5 && ESTIMATE_AD_HINT_RULE.adMonths === 1.5);
t("割引 4万・家賃 6万（0.67）→ 1.5", adHintFromDiscount(40000, 60000) === 1.5);
t("割引 2.2万・家賃 6万（0.37＝AD1 の見積書の最大）→ null", adHintFromDiscount(22000, 60000) === null);
t("家賃なし・割引0 → null", adHintFromDiscount(40000, null) === null && adHintFromDiscount(0, 60000) === null);
{
  const rows = [{ property_name: "エスプレイス難波サウスゲート", room_no: "603", discount_yen: 40000 }, { property_name: "カーサビエント", room_no: "203", discount_yen: 45000 }];
  t("同じ建物・同じ号室 → 1.5", estimateAdHintFor("エスプレイス 難波サウスゲート", "603号室", 70000, rows) === 1.5);
  t("号室が違えば補わない", estimateAdHintFor("エスプレイス難波サウスゲート", "702", 70000, rows) === null);
  t("濁点だけ違う建物は同じ（カーサピエント／カーサビエント）", estimateAdHintFor("カーサピエント", "203", 80000, rows) === 1.5);
  t("別の建物 → null", estimateAdHintFor("グレース畑中", "101", 60000, rows) === null);
}

// ── 新着1件に刺さったか（実物の返事の形・名前は出さない）──
{
  const at = "2026-10-05T03:00:00Z", later = (h: number) => new Date(Date.parse(at) + h * 36e5).toISOString();
  const base = { starName: "エスプレイス難波サウスゲート", sentAt: at, aix: [] as never[] };
  t("「初期費用いくらですか？」→ 刺さった", newArrivalHookOf({ ...base, messages: [{ sender: "customer", text: "初期費用いくらですか？", created_at: later(1) }] }).hooked);
  t("見積書の AIX がその物件 → 刺さった（estimate）", newArrivalHookOf({ ...base, messages: [], aix: [{ aix_type: "estimate_sheet", generated_text: "エスプレイス難波サウスゲート 603号室の御見積書", created_at: later(5) }] as never }).signals.includes("estimate"));
  t("「ありがとうございます！確認します！」→ 刺さっていない", !newArrivalHookOf({ ...base, messages: [{ sender: "customer", text: "ありがとうございます！確認します！", created_at: later(1) }] }).hooked);
  t("別の物件の URL を送ってきた返事 → この物件の反応ではない", !newArrivalHookOf({ ...base, messages: [{ sender: "customer", text: "ここ気になります https://suumo.jp/chintai/xxx", created_at: later(1) }] }).hooked);
  const d = newArrivalHookOf({ ...base, messages: [{ sender: "customer", text: "ここも気になってたんですけどスーパーが遠いかなと思って辞めてたんですよね。", created_at: later(1) }] });
  t("断りの言葉があれば返事だけでは刺さったに数えない", !d.hooked && d.declined, d);
  t("72時間の窓の外（49時間後）の返事は見ない", !newArrivalHookOf({ ...base, messages: [{ sender: "customer", text: "初期費用いくらですか？", created_at: later(49) }] }).hooked);
}

// ── 売上サポの行 → 候補 ──
{
  t("物件名の（フルリノベーション）→ renovated", renovatedOfPickup({ property_name: "レジオン新大阪（フルリノベーション）", summary_text: null }) === true);
  t("判定の時に残した terms.renovated → renovated", renovatedOfPickup({ property_name: "梶町マンション", summary_text: null, terms: { renovated: true } }) === true);
  t("読めなければ null（false にしない＝築年で比べる）", renovatedOfPickup({ property_name: "グレース畑中", summary_text: "家賃6万" }) === null);
  t("敷金1＋礼金1 → 2", initialMonthsOfPickup({ terms: { deposit: 1, keyMoney: 1 } }) === 2 && initialMonthsOfPickup({ terms: { deposit: 1 } }) === null);
  const c = starCandidateOfPickup({ id: 7, property_name: "パークモダン新大阪（フルリノベーション）", terms: { deposit: 0, keyMoney: 0, buildingAge: 29 } }, 80);
  t("候補に renovated・initialMonths", c.renovated === true && c.initialMonths === 0 && c.buildingAge === 29, c);
}

// 2026-10-06e 保留（初期費用だけ・AD2以上）を候補に入れて版を上げた（star-soft-hold-building-ad.test.ts）
t("決まりの版は 06d 以降", STAR_FIT_RULE_TAG >= "star-fit@2026-10-06d");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
