// 2026-09-27 竹内「重い順から治す」①: 学習した語のルール（信号5.5・8）がブレインの「AIX なし」を意味の無い語で上書きしていた（穴:G5）
//   お客様の発言は YUMA の徹底テスト（b34eb51a・85894e05・671d868f）と本番の実物（scripts/audit-brain-keyword-rules.ts・名前は伏せた）。
//   ルールの語は trigger_action_rules（2026-09-27 時点）の実物。
// 実行: npx tsx app/lib/__tests__/brain-keyword-rules.test.ts（自己完結ハーネス。全 PASS で exit 0）
import {
  isExplicitNoAix, isMeaninglessRuleKeyword, meaninglessRuleKeywordReason,
  humanKeywordRuleHit, summedKeywordRuleHit, adoptSignalAixOverBrainNull, type KeywordRule,
} from "../brain-keyword-rules";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

// 本番の表の実物（action_type / keyword / confidence / occurrence_count）
const R = (action_type: string, keyword: string, confidence: number, occurrence_count: number): KeywordRule => ({ action_type, keyword, confidence, occurrence_count });
const TABLE: KeywordRule[] = [
  R("property_check_result", "も見て", 1, 3),
  R("property_send", "ていま", 1, 7),
  R("property_send", "ています", 1, 6),
  R("property_check_result", "ですか", 0.95, 10),
  R("property_send", "どんな", 0.95, 10),
  R("property_send", "ます😊", 0.868, 3),
  R("property_send", "す😊", 0.868, 3),
  R("property_send", "います😊", 0.868, 3),
  R("property_send", "しました", 0.825, 24),
  R("property_send", "知しました", 1, 9),
  R("property_recommendation", "ただきます", 1, 6),
  R("estimate_sheet", "⑥ご希望", 0.707, 19),
  // 中身のある語（残す）
  R("viewing_invite", "内覧希望", 0.95, 13),
  R("estimate_sheet", "見積もり", 0.95, 10),
  R("estimate_sheet", "いくらで", 0.961, 4),
  R("property_recommendation", "おすすめ", 1, 10),
  R("property_check_result", "まだありますか", 0.95, 10),
  R("property_recommendation", "も見たい", 1, 10),
  R("property_recommendation", "1LDK", 1, 11),
];
const CLEAN = TABLE.filter((r) => !isMeaninglessRuleKeyword(r.keyword));

console.log("isMeaninglessRuleKeyword（意味の無い語）");
it("語尾・絵文字: ます😊・す😊・います😊・うか💦", () => {
  for (const k of ["ます😊", "す😊", "います😊", "うか💦", "ょうか💦"]) eq(meaninglessRuleKeywordReason(k), "語尾・絵文字");
});
it("語尾・助詞: しました・ていま・ています・ですか・どんな・ただきます・ちなみに", () => {
  for (const k of ["しました", "ていま", "ています", "ですか", "どんな", "ただきます", "ちなみに", "ございませ"]) eq(meaninglessRuleKeywordReason(k), "語尾・助詞");
});
it("助詞で始まる断片: も見て・が見つ・を探し", () => {
  for (const k of ["も見て", "が見つ", "を探し"]) eq(meaninglessRuleKeywordReason(k), "助詞で始まる断片");
});
it("定型の敬語の断片: 知しました・て頂きます・した宜・訳ござい・話になりま・数お掛けし", () => {
  for (const k of ["知しました", "て頂きます", "した宜", "訳ござい", "話になりま", "数お掛けし", "承知致しま"]) eq(meaninglessRuleKeywordReason(k), "定型の敬語の断片");
});
it("フォームの断片: ⑥ご希望・分数⇒・住所〒住", () => {
  for (const k of ["⑥ご希望", "分数⇒", "住所〒住"]) eq(meaninglessRuleKeywordReason(k), "フォームの断片");
});
it("中身のある語は残す: 内覧希望・見積もり・いくらで・おすすめ・まだありますか・も見たい・1LDK・審査落ち・の空き・みにいきたい・ここにします・初期費用・また連絡します", () => {
  for (const k of ["内覧希望", "見積もり", "いくらで", "くらですか", "おすすめ", "まだありますか", "も見たい", "1LDK", "審査落ち", "の空き", "みにいきたい", "ここにします", "初期費用", "また連絡します", "いつから", "どこで", "こだわり", "なんば"]) {
    eq([k, meaninglessRuleKeywordReason(k)], [k, null]);
  }
});

console.log("isExplicitNoAix（ブレインがはっきり「なし」）");
it("null・空・\"null\"・\"なし\" は「なし」", () => {
  for (const v of [null, undefined, "", " ", "null", "NULL", "none", "なし"]) eq(isExplicitNoAix(v), true);
});
it("AIX のキー・知らない語は「なし」ではない（従来どおり信号で補ってよい）", () => {
  for (const v of ["property_send", "見積書送る", "よく分からない語"]) eq(isExplicitNoAix(v), false);
});

console.log("語のルールの当て方（YUMA・本番の実物）");
it("YUMA 85894e05「楽しみにしてます😊」: 旧は property_send・意味の無い語を外すと当たらない", () => {
  const t = "9/29(火)14時、承知しました！当日よろしくお願いします。楽しみにしてます😊";
  eq(summedKeywordRuleHit(t, TABLE)?.action, "property_send");
  eq(summedKeywordRuleHit(t, CLEAN), null);
  eq(humanKeywordRuleHit(t, CLEAN), null);
});
it("YUMA b34eb51a「気になってます😊 他も見てみますね」: 旧は AIX が出た（本番の表では も見て 1.0 で property_check_result）・外すと当たらない", () => {
  const t = "プレサンス難波WEST 0205が気になってます😊 他も見てみますね";
  eq(summedKeywordRuleHit(t, TABLE) !== null, true);
  eq(summedKeywordRuleHit(t, CLEAN), null);
});
it("YUMA 671d868f「…気になっていますが、他も見てから決めたい」: 旧は property_send（ていま・ています）・外すと当たらない", () => {
  const t = "Rainbow Court 立売堀が気になっていますが、他も見てから決めたいです";
  eq(summedKeywordRuleHit(t, TABLE)?.action, "property_send");
  eq(summedKeywordRuleHit(t, CLEAN), null);
});
it("本番 d3f7f5f3・469a614a「承知しました！」: 旧は property_send・外すと当たらない", () => {
  eq(summedKeywordRuleHit("承知しました！", TABLE)?.action, "property_send");
  eq(summedKeywordRuleHit("承知しました！", CLEAN), null);
});
it("本番: 「〜ですか」だけで信号5.5（0.95/10）が property_check_result を出していた → 外すと当たらない", () => {
  const t = "審査いつ頃わかりますか！何日くらいですか";
  eq(humanKeywordRuleHit(t, TABLE)?.action_type, "property_check_result");
  eq(humanKeywordRuleHit(t, CLEAN), null);
});
it("中身のある語は外した後も当たる: 「内覧希望です」→ viewing_invite・「2LDKも見たいです」→ property_recommendation", () => {
  eq(humanKeywordRuleHit("土曜に内覧希望です", CLEAN)?.action_type, "viewing_invite");
  eq(summedKeywordRuleHit("2LDKも見たいです", CLEAN)?.action, "property_recommendation");
});

// 2026-10-08 竹内さん「ちゃんとブレインを基盤に」: ブレインが「AIX なし」の時、語・状態の信号の AIX は採らない（本番 97番中 一致 3・AIX なし 84）
//   実物（信号が立てた AIX・お客様の発言）: 「他社で決まりました」→property_recommendation／「検討してみます」→property_send／
//   「本日電話いけますか」→property_search／「家賃をいくらまでにしたら…出てきますか」→estimate_sheet／「14:30-15:00くらいに掛けても大丈夫でしょうか」→S5 待ち合わせ
it("ブレインがはっきり「なし」（null）→ 信号の AIX（見積書送る・物件オススメ・物件検索・申込へ・確認します）は採らない", () => {
  const env = {};
  for (const action of ["estimate_sheet", "property_recommendation", "property_search", "property_send", "application_push", "acknowledge_check", "followup_revive"]) {
    eq(adoptSignalAixOverBrainNull(isExplicitNoAix(null), { kind: "signal", action }, env), false);
  }
});
it("場面の信号: S5（日時の語→待ち合わせ）は採らない・S2/S3/S11（竹内さんの決定）は残す", () => {
  const env = {};
  eq(adoptSignalAixOverBrainNull(true, { kind: "scene", scene: "S5_time_spec" }, env), false);
  eq(adoptSignalAixOverBrainNull(true, { kind: "scene", scene: "S2_move_in" }, env), true);
  eq(adoptSignalAixOverBrainNull(true, { kind: "scene", scene: "S3_screening" }, env), true);
  eq(adoptSignalAixOverBrainNull(true, { kind: "scene", scene: "S11_other_room" }, env), true);
});
it("ブレインが分からない語を返した（「なし」とは言っていない）→ 従来どおり信号で補う", () => {
  eq(adoptSignalAixOverBrainNull(isExplicitNoAix("内覧したいので日程"), { kind: "signal", action: "viewing_invite" }, {}), true);
  eq(adoptSignalAixOverBrainNull(isExplicitNoAix("unknown_button"), { kind: "scene", scene: "S5_time_spec" }, {}), true);
});
it("戻す: BRAIN_NULL_SIGNAL_FALLBACK=on で旧（信号で AIX を立てる）", () => {
  eq(adoptSignalAixOverBrainNull(true, { kind: "signal", action: "estimate_sheet" }, { BRAIN_NULL_SIGNAL_FALLBACK: "on" }), true);
  eq(adoptSignalAixOverBrainNull(true, { kind: "scene", scene: "S5_time_spec" }, { BRAIN_NULL_SIGNAL_FALLBACK: "ON" }), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(" - " + f); process.exit(1); }
