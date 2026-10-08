// 結果の台帳の決まり（app/lib/deal-outcome.ts）
// 実行: npx tsx app/lib/__tests__/deal-outcome.test.ts
// 文は実物（scripts/audit-outcome-ledger.ts --texts で読んだ物・名前と物件名は伏せた）
import {
  detectDealLossText, isScreeningRejectedText, isApplicationCancelText, closedWonCertainty, autoSeiyakuDays, autoSeiyakuWritesBack,
  pickDealProperty, resolveDealOutcomes, buildOutcomeEventRows, toDealOutcomeRow, countsAsConfirmedWin, strongPositiveStage, ruleLossReason,
  type DealInput, type DealMessage,
} from "../deal-outcome";
import { brainDecisionLedgerCols, brainDecisionDigestExtra, brainVersionOf } from "../brain-decision-ledger";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
const J = (s: string) => new Date(`${s}+09:00`).toISOString();
const cust = (at: string, text: string): DealMessage => ({ sender: "customer", text, createdAt: J(at) });
const staff = (at: string, text: string): DealMessage => ({ sender: "staff", text, createdAt: J(at) });
const base = (o: Partial<DealInput>): DealInput => ({
  conversationId: "c1", nowMs: Date.parse(J("2026-10-08T12:00:00")), status: "proposing", lineStatus: "active", createdAt: J("2026-08-01T10:00:00"), updatedAt: J("2026-10-01T10:00:00"),
  statusManualBackAt: null, isPostApply: false, screeningLastStatus: null, stageHistory: [], messages: [], firstMessageAt: null, viewings: [], propertySentAts: [], conditionAts: [], clues: [], ...o,
});

console.log("失注の文（お客様）＝実物");
it("「他の不動産屋で審査通しており…そちらで物件決まりました」→ 他で決めた", () => eq(detectDealLossText("お世話になっております。\n他の不動産屋で審査通しており返信していなかったのですが、そちらで物件決まりました。\nご協力いただいたのにすみませんありがとうございました。"), "declined_elsewhere"));
it("「今回は他社様で契約を進めることになりました…このような結果となり申し訳ありません」→ 他で決めた", () => eq(detectDealLossText("その後いろいろ検討した結果、今回は他社様で契約を進めることになりました。\nこのような結果となり申し訳ありません。"), "declined_elsewhere"));
it("「少し考えたいので今回は辞退させていただきます」→ 辞退", () => eq(detectDealLossText("ご連絡おそくなってすいません。\n少し考えたいので今回は辞退させていただきます。"), "declined_elsewhere"));
it("「他社で探します!」→ 他で決めた", () => eq(detectDealLossText("わかりました!\nありがとうございました!\n他社で探します!"), "declined_elsewhere"));
it("「そちらの物件拝見しましたが 今回はやめておきます」は物件1件の見送り（失注にしない）", () => eq(detectDealLossText("ありがとうございます!\nそちらの物件拝見しましたが\n今回はやめておきます🙇🏻‍♀️💦"), null));
it("「転勤の件無くなりましたので今回は見送りで」→ 引越し中止", () => eq(detectDealLossText("申し訳ありません。\n転勤の件無くなりましたので今回は見送りでお願いします。"), "move_cancelled"));
it("「引越しが2月まで延期になりそうです」→ 引越し中止・延期", () => eq(detectDealLossText("旦那の仕事の都合で引越しが2月まで延期になりそうです、、、\nまた年明けて物件探し始めた頃にご連絡させて頂きます!"), "move_cancelled"));
it("「引越しの計画が中止したので」→ 引越し中止", () => eq(detectDealLossText("申し訳ありません、引越しの計画が中止したので\n今回の物件キャンセルでお願い致します。"), "move_cancelled"));
it("「他社で決まる前に申込したい」（心配）は失注にしない", () => eq(detectDealLossText("他社で決まる前に申込したいです"), null));
it("「内覧の延期」は引越し中止にしない", () => eq(detectDealLossText("明日の内覧ですが延期できますか？"), null));

console.log("審査落ち・申込の取り消し＝実物");
it("「保証会社審査が否決とのご連絡がございました」→ 否決", () => eq(isScreeningRejectedText("管理会社に確認させていただき、保証会社審査が否決とのご連絡がございました。\n理由につきましてはご教授いただけませんでした。"), true));
it("「審査が否決となり審査継続不可能とのご連絡」→ 否決", () => eq(isScreeningRejectedText("管理会社より〇〇、〇〇の審査が否決となり審査継続不可能とのご連絡がございました。"), true));
it("「1番手お申込み中の方がキャンセルもしくは審査否決の場合に…繰り上がり」（説明）は否決にしない", () => eq(isScreeningRejectedText("1番手お申込み中の方がキャンセルもしくは審査否決の場合に2番手お申込み者の方が1番手に繰り上がり審査開始となります!!"), false));
it("「1番手保証会社の〇〇が否決となり、現在2番手の〇〇にて審査中」は否決にしない（審査中）", () => eq(isScreeningRejectedText("1番手保証会社の〇〇が否決となり、現在2番手の〇〇にて審査中となります!!"), false));
it("「女性1人入居は審査通らないですか?」（質問）は否決にしない", () => eq(isScreeningRejectedText("ちなみにお聞きしますが、女性1人入居は審査通らないですか?"), false));
it("「今回の物件キャンセルでお願い致します」→ 取り消し", () => eq(isApplicationCancelText("申し訳ありません、引越しの計画が中止したので\n今回の物件キャンセルでお願い致します。"), true));
it("「審査通したらキャンセル不可ですかね、?」（質問）は取り消しにしない", () => eq(isApplicationCancelText("審査通したらキャンセル不可ですかね、?"), false));
it("「申し込み取り消してもう1回とかは出来たりしますかね」は取り消しにしない", () => eq(isApplicationCancelText("なるほど、、申し込み取り消してもう1回とかは出来たりしますかね、?"), false));
it("「物件の内見の予約はキャンセルでお願い致します」（内覧の取りやめ）は申込の取り消しにしない", () => eq(isApplicationCancelText("本日11時に〇〇の物件の内見の予約はキャンセルでお願い致します。"), false));

console.log("成約の確かさ（決定②）");
it("auto-seiyaku（trigger cron）→ 推定", () => eq(closedWonCertainty({ history: [{ from_status: "applying", to_status: "closed_won", changed_at: J("2026-09-24T09:00:18"), trigger: "cron" }], updatedAt: null, screeningLastStatus: null }).certainty, "estimated"));
it("新しい印 cron:auto_seiyaku → 推定", () => eq(closedWonCertainty({ history: [{ from_status: "applying", to_status: "closed_won", changed_at: J("2026-10-20T09:00:00"), trigger: "cron:auto_seiyaku" }], updatedAt: null, screeningLastStatus: null }).evidence, "auto_seiyaku"));
it("スタッフが成約にした（manual）→ 確定", () => eq(closedWonCertainty({ history: [{ from_status: "applying", to_status: "closed_won", changed_at: J("2026-10-01T15:00:00"), trigger: "manual" }], updatedAt: null, screeningLastStatus: null }).certainty, "confirmed"));
it("申込のツールの同期で成約 → 確定", () => eq(closedWonCertainty({ history: [], updatedAt: J("2026-09-30T16:28:00"), screeningLastStatus: "closed_won" }).evidence, "screening_tool"));
it("履歴なし・7/23 より前 → 確定（自動が始まる前）", () => eq(closedWonCertainty({ history: [], updatedAt: J("2026-07-22T22:27:00"), screeningLastStatus: null }).certainty, "confirmed"));
it("履歴なし・JST 9:00 ちょうどの更新 → 推定（自動の古い分）", () => eq(closedWonCertainty({ history: [], updatedAt: "2026-07-23T00:00:08.447Z", screeningLastStatus: null }).evidence, "auto_seiyaku_legacy"));
it("履歴なし・7/23 以降・時刻も合わない → 推定（迷う物は学習に入れない側）", () => eq(closedWonCertainty({ history: [], updatedAt: J("2026-08-16T18:56:00"), screeningLastStatus: null }).evidence, "no_history_ambiguous"));
it("自動の成約の日数: 既定 20・AUTO_SEIYAKU_DAYS=14 で旧・変な値は既定", () => { eq(autoSeiyakuDays({}), 20); eq(autoSeiyakuDays({ AUTO_SEIYAKU_DAYS: "14" }), 14); eq(autoSeiyakuDays({ AUTO_SEIYAKU_DAYS: "abc" }), 20); });
it("自動の成約の学習への書き戻し: 既定しない・on で旧", () => { eq(autoSeiyakuWritesBack({}), false); eq(autoSeiyakuWritesBack({ AUTO_SEIYAKU_WRITEBACK: "on" }), true); });

console.log("物件の照合（どの物件で申込んだか）");
it("申込の前の見積書が画像より強い", () => {
  const p = pickDealProperty([
    { kind: "image", at: J("2026-09-10T10:00:00"), name: "ハイツA 101号室", sourceTable: "sent_image_properties", sourceId: "i1" },
    { kind: "estimate", at: J("2026-09-05T10:00:00"), name: "グランドB", room: "502", sourceTable: "estimate_records", sourceId: "1" },
  ], Date.parse(J("2026-09-11T10:00:00")), -Infinity);
  eq([p?.name, p?.evidence, p?.certainty], ["グランドB 502号室", "estimate", "confirmed"]);
});
it("ブレインの物件は申込の前後1日だけ・推定", () => {
  const clues = [{ kind: "brain" as const, at: J("2026-09-01T10:00:00"), name: "メゾンC 303", sourceTable: "brain_decision_logs", sourceId: "d1" }];
  eq(pickDealProperty(clues, Date.parse(J("2026-09-20T10:00:00")), -Infinity), null);
  eq(pickDealProperty(clues, Date.parse(J("2026-09-01T20:00:00")), -Infinity)?.certainty, "estimated");
});

console.log("案件と結果");
it("申込前で最後の発言から30日 → 推定の失注（無反応）・追いかけた印", () => {
  const e = resolveDealOutcomes(base({ messages: [cust("2026-08-01T10:00:00", "よろしくお願いします"), staff("2026-08-01T10:05:00", "条件を教えてください"), cust("2026-08-20T10:00:00", "梅田周辺で8万円まで"), staff("2026-09-01T10:00:00", "新着です")] }));
  eq([e.length, e[0].result, e[0].lostType, e[0].certainty, e[0].chased, e[0].lostReason], [1, "lost", "no_response", "estimated", true, "no_contact"]);
});
it("返事が来たら取り消し（29日なら進行中）", () => {
  const e = resolveDealOutcomes(base({ messages: [cust("2026-09-10T10:00:00", "ありがとうございます")] }));
  eq(e[0].result, "in_progress");
});
it("ブロック → 確定の失注", () => eq(resolveDealOutcomes(base({ lineStatus: "unfollowed", messages: [cust("2026-10-01T10:00:00", "はい")] }))[0].lostType, "blocked"));
it("最後の方で「他社で探します」→ 確定の失注（理由は他社・弱い参考）", () => {
  const e = resolveDealOutcomes(base({ messages: [cust("2026-10-01T10:00:00", "わかりました!\n他社で探します!")] }));
  eq([e[0].result, e[0].lostType, e[0].certainty, e[0].lostReason], ["lost", "declined_elsewhere", "confirmed", "other_company"]);
});
it("他社の話の後にまた探し始めた（最後の3通より前）→ 失注にしない", () => {
  const e = resolveDealOutcomes(base({ messages: [cust("2026-09-20T10:00:00", "他社で探します!"), cust("2026-10-01T10:00:00", "やっぱりお願いします"), cust("2026-10-02T10:00:00", "梅田で"), cust("2026-10-03T10:00:00", "8万円まで"), cust("2026-10-04T10:00:00", "よろしくです")] }));
  eq(e[0].result, "in_progress");
});
it("審査落ちで戻した → 案件2つ・前の案件は切り替え・次の案件に信頼の段階と審査の後の印（決定④）", () => {
  const e = resolveDealOutcomes(base({
    status: "proposing",
    stageHistory: [
      { from_status: "viewing", to_status: "applying", changed_at: J("2026-09-01T10:00:00"), trigger: "manual" },
      { from_status: "applying", to_status: "proposing", changed_at: J("2026-09-10T10:00:00"), trigger: "manual" },
    ],
    messages: [cust("2026-08-20T10:00:00", "内覧したいです"), staff("2026-09-09T18:00:00", "〇〇の管理会社より審査否決とのご連絡がございました。\n否決理由につきましてはご教授いただけませんでした。"), cust("2026-10-05T10:00:00", "次もお願いします")],
    viewings: [{ ymd: "2026-08-25", status: "done", thankedAt: J("2026-08-25T18:00:00"), name: "ハイツA" }],
  }));
  eq(e.map((x) => [x.episodeNo, x.result, x.switchReason, x.maxStage, x.carriedTrustStage, x.afterScreeningFail]),
    [[1, "switched", "screening_rejected", "applied", null, false], [2, "in_progress", null, "first_contact", "applied", true]]);
});
it("段階を戻していない審査落ち（否決の報告だけ）でも次の案件にする", () => {
  const e = resolveDealOutcomes(base({ messages: [cust("2026-09-01T10:00:00", "申込お願いします"), staff("2026-09-28T13:26:00", "〇〇の管理会社より保証会社審査が否決となり、審査継続不可能とのご連絡がございました。"), cust("2026-10-02T10:00:00", "わかりました")] }));
  eq(e.map((x) => [x.result, x.switchReason]), [["switched", "screening_rejected"], ["in_progress", null]]);
});
it("申込の印が誤り（申込フォーム・審査・否決・取り消しの文が無い戻し）は案件を分けず申込も数えない", () => {
  const e = resolveDealOutcomes(base({ stageHistory: [
    { from_status: "proposing", to_status: "applying", changed_at: J("2026-09-01T10:00:00"), trigger: "customer_message" },
    { from_status: "applying", to_status: "proposing", changed_at: J("2026-09-01T12:00:00"), trigger: "manual" },
  ], messages: [cust("2026-10-01T10:00:00", "申込の流れを教えてください")] }));
  eq([e.length, e[0].stageAt.applied ?? null], [1, null]);
});
it("auto-seiyaku の成約 → won/推定・学習の数に入らない（決定②）", () => {
  const e = resolveDealOutcomes(base({ status: "closed_won", stageHistory: [
    { from_status: "proposing", to_status: "applying", changed_at: J("2026-09-01T10:00:00"), trigger: "manual" },
    { from_status: "applying", to_status: "closed_won", changed_at: J("2026-09-24T09:00:00"), trigger: "cron" },
  ] }));
  const row = toDealOutcomeRow("c1", e[0], "2026-10-08T00:00:00Z");
  eq([row.result, row.result_certainty, countsAsConfirmedWin(row), strongPositiveStage(row)], ["won", "estimated", false, "applied"]);
});
it("スタッフの成約 → 確定・強い正は won", () => {
  const e = resolveDealOutcomes(base({ status: "closed_won", stageHistory: [{ from_status: "screening", to_status: "closed_won", changed_at: J("2026-10-01T10:00:00"), trigger: "manual" }] }));
  const row = toDealOutcomeRow("c1", e[0], "2026-10-08T00:00:00Z");
  eq([countsAsConfirmedWin(row), strongPositiveStage(row), row.applied_at_estimated], [true, "won", true]);
});
it("失注は強い正にも負にもしない（決定⑤: null を返すだけ）", () => {
  const e = resolveDealOutcomes(base({ lineStatus: "unfollowed" }));
  eq(strongPositiveStage(toDealOutcomeRow("c1", e[0], "x")), null);
});
it("審査の後の無反応の理由は「審査」", () => eq(ruleLossReason("no_response", true), "screening"));

console.log("出来事の行");
it("案件の番号を時刻で付け・結果の出来事を足す・同じ元は1つ", () => {
  const input = base({ stageHistory: [
    { from_status: "viewing", to_status: "applying", changed_at: J("2026-09-01T10:00:00"), trigger: "manual" },
    { from_status: "applying", to_status: "proposing", changed_at: J("2026-09-10T10:00:00"), trigger: "manual" },
  ], messages: [staff("2026-09-09T18:00:00", "審査否決とのご連絡がございました。"), cust("2026-10-05T10:00:00", "次もお願いします")] });
  const eps = resolveDealOutcomes(input);
  const rows = buildOutcomeEventRows("c1", [
    { at: J("2026-08-20T10:00:00"), kind: "aix_sent", sourceTable: "aix_usage_logs", sourceId: "a1", propertyName: "ハイツA 101号室" },
    { at: J("2026-08-20T10:00:00"), kind: "aix_sent", sourceTable: "aix_usage_logs", sourceId: "a1" },
    { at: J("2026-09-20T10:00:00"), kind: "brain_decision", sourceTable: "brain_decision_logs", sourceId: "d1", decisionId: "d1" },
  ], eps);
  eq(rows.map((r) => `${r.kind}#${r.episode_no}`), ["aix_sent#1", "applied#1", "switched#1", "brain_decision#2"]);
  eq(rows[0].building_key !== null && rows[0].room_no === "101", true);
});

console.log("ブレインの判断の行（段2）");
it("物件の鍵・号室・場面・版", () => {
  const c = brainDecisionLedgerCols({ current_property: "グランドB 502号室" }, "ありがとうございます！", { VERCEL_GIT_COMMIT_SHA: "f137f7a4abcdef" });
  eq([c.room_no, !!c.building_key, typeof c.scene_key, c.brain_version], ["502", true, "string", "f137f7a"]);
  eq(brainVersionOf({}), "local");
  eq(brainDecisionLedgerCols({}, "", {}).building_key, null);
});
it("digest の短い項目（tc・pp・cp・cs）・無い物は入れない", () => {
  eq(brainDecisionDigestExtra({ two_choice_mode: true, pending_pickup: true, checkpoint_stage: "viewing", closing_strategy: "x".repeat(80) }), { tc: true, pp: true, cp: "viewing", cs: "x".repeat(60) });
  eq(brainDecisionDigestExtra({ two_choice_mode: false }), {});
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
