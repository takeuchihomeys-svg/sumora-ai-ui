// 2026-09-27 竹内「この問題直して大丈夫」: ブレインの段階を customer-state で補正（viewing に上げる）・会話の方向の段階を段階から決める（app/lib/brain-stage.ts）
//   実物は scripts/audit-brain-stage.ts（本番30〜60日の会話）で前後を読んだ物。お客様の発言は本文のまま（名前は YUMA に置き換え）。
// 実行: npx tsx app/lib/__tests__/brain-stage.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { correctBrainStage, resolveDirectionPhase, resolveNextStaffAction, VIEWED_FRESH_DAYS } from "../brain-stage";
import { resolveCustomerState, type CustomerStateInput, type CustomerStateAixRow } from "../customer-state";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}
const NOW = Date.parse("2026-09-27T03:00:00Z");
const base = (o: Partial<CustomerStateInput>): CustomerStateInput => ({
  now: NOW, status: "proposing", messages: [], aixRows: [], recordedFacts: [], viewingHistory: [], sentProperties: [], lineTasks: [], ...o,
});
const C = (t: string, text: string) => ({ sender: "customer", text, createdAt: t });
const S = (t: string, text: string, isAix = false) => ({ sender: "staff", text, createdAt: t, isAix });
const AX = (t: string, aix_type: string, extra: Partial<CustomerStateAixRow> = {}): CustomerStateAixRow => ({ aix_type, created_at: t, sent_at: t, generated_text: null, property_names: null, estimate_sent: null, ...extra });
const cs = (i: CustomerStateInput) => { const s = resolveCustomerState(i); return { stage: s.stage, since: s.since }; };

console.log("\n■ ブレインの段階の補正（上げるだけ）");
it("お客様「レジュールアッシュ内見可能ですか？」・LLM proposing → viewing（8a77820b）", () => {
  const c = cs(base({ messages: [
    S("2026-09-26T03:00:00Z", "🌟レジュールアッシュ北大阪 GRAND STAGE 206号室 お気に召されましたらご案内させて頂きます！！", true),
    C("2026-09-26T08:37:00Z", "レジュールアッシュ内見可能ですか？"),
  ] }));
  expect(c.stage).toBe("viewing_arranging");
  const r = correctBrainStage("proposing", c, NOW);
  expect(r.stage).toBe("viewing");
  expect(r.source).toBe("customer_state");
});
it("内覧の日時を送った後（YUMA 型: 待ち合わせの案内）・LLM proposing → viewing", () => {
  const c = cs(base({ messages: [
    C("2026-09-18T03:40:00Z", "28日はいけますか？"),
    S("2026-09-18T04:03:00Z", "かしこまりました😊！！ 9/28（月）ご案内させて頂きます！！ 9/28 12:00にジュネスニッコー 1003号室 現地エントランスお待ち合わせで何卒よろしくお願い致します！！", true),
    C("2026-09-26T20:50:00Z", "そんな事あるんですか😓"),
  ], aixRows: [AX("2026-09-18T04:03:00Z", "meeting_place", { generated_text: "9/28 12:00にジュネスニッコー 1003号室 現地エントランスお待ち合わせ", property_names: ["ジュネスニッコー 1003号室"] })] }));
  expect(c.stage).toBe("viewing_scheduled");
  expect(correctBrainStage("proposing", c, NOW).stage).toBe("viewing");
});
it("LLM が段階を出さなかった（null）時も内覧の場面なら viewing", () => {
  expect(correctBrainStage(null, { stage: "viewing_scheduled", since: "2026-09-25T00:00:00Z" }, NOW).stage).toBe("viewing");
});
it("LLM hearing も上げる（内覧の話がある会話を条件の聞き取りにしない）", () => {
  expect(correctBrainStage("hearing", { stage: "viewing_arranging", since: "2026-09-26T00:00:00Z" }, NOW).stage).toBe("viewing");
});
it("LLM applying（内覧後に「10/26に入居できたら」d3a56a97）は下げない", () => {
  const r = correctBrainStage("applying", { stage: "viewed", since: "2026-09-20T00:00:00Z" }, NOW);
  expect(r.stage).toBe("applying");
  expect(r.source).toBe("llm");
});
it("LLM viewing・customer-state 提案中は下げない（語の一覧で拾えない内覧の希望がある）", () => {
  expect(correctBrainStage("viewing", { stage: "proposing", since: "2026-09-26T00:00:00Z" }, NOW).stage).toBe("viewing");
});
it("contract は触らない", () => {
  expect(correctBrainStage("contract", { stage: "viewing_scheduled", since: "2026-09-26T00:00:00Z" }, NOW).stage).toBe("contract");
});
it("申込以降（申込準備・申込中）・見送りは補正しない", () => {
  for (const stage of ["apply_prep", "applying", "won", "dropped"] as const) {
    expect(correctBrainStage("proposing", { stage, since: "2026-09-26T00:00:00Z" }, NOW).stage).toBe("proposing");
  }
});
it("内覧の場面でない段階（提案中・見積送付済み・気に入った物件あり）は LLM のまま", () => {
  for (const stage of ["first", "searching", "proposing", "interested", "estimate_sent"] as const) {
    expect(correctBrainStage("proposing", { stage, since: "2026-09-26T00:00:00Z" }, NOW).source).toBe("llm");
  }
});
it("customer-state が読めない（null）時は LLM のまま", () => {
  expect(correctBrainStage("proposing", null, NOW).stage).toBe("proposing");
  expect(correctBrainStage("bogus", null, NOW).stage).toBe(null);
});
it("内覧調整中でも今回お客様が新しい条件で探してと言った（condition_change_type）時は上げない（3db9db75）", () => {
  const c = cs(base({ messages: [
    S("2026-09-24T23:44:00Z", "YUMAさんお世話になっております！！ 天王寺周辺から家賃を抑えたマンションでYUMAさんにオススメできる新着のお部屋ピックアップさせて頂きました！！", true),
    C("2026-09-25T13:06:00Z", "いろいろみててここの物件気になるので"),
    C("2026-09-25T13:06:30Z", "内覧してみたいです"),
    S("2026-09-25T16:09:00Z", "エグゼ難波西Ⅱの募集状況確認させていただきましたが、既にご契約が決まったお部屋となります！！"),
    C("2026-09-26T01:22:00Z", "わかりました"),
    C("2026-09-26T01:22:10Z", "芦原橋らへんも"),
    C("2026-09-26T01:22:20Z", "探してほしいです"),
  ] }));
  expect(c.stage).toBe("viewing_arranging");
  expect(correctBrainStage("proposing", c, NOW, { conditionChangeType: "area_change" }).stage).toBe("proposing");
  expect(correctBrainStage("proposing", c, NOW, { conditionChangeType: null }).stage).toBe("viewing");
});
it("内覧予定（日時つき）は条件の話が出ても上げる（決まった内覧はまだある・110b3053）", () => {
  expect(correctBrainStage("proposing", { stage: "viewing_scheduled", since: "2026-09-18T04:03:00Z" }, NOW, { conditionChangeType: "area_change" }).stage).toBe("viewing");
});
it(`内覧後（viewed）は最後の内覧から ${VIEWED_FRESH_DAYS} 日以内だけ上げる`, () => {
  expect(correctBrainStage("proposing", { stage: "viewed", since: "2026-09-20T00:00:00Z" }, NOW).stage).toBe("viewing");
  expect(correctBrainStage("proposing", { stage: "viewed", since: "2026-09-01T00:00:00Z" }, NOW).stage).toBe("proposing");
  expect(correctBrainStage("proposing", { stage: "viewed", since: null }, NOW).stage).toBe("proposing");
});
it("資料の「娘と拝見します」（d416295c）は内覧の場面にならず上げない", () => {
  const c = cs(base({ messages: [
    S("2026-09-23T00:46:00Z", "YUMAさんお世話になっております！！ 西九条駅周辺からオススメできるお部屋を7件ピックアップさせて頂きました😊！！", true),
    C("2026-09-23T05:10:00Z", "お世話になります。 ありがとうございます。娘と拝見します。"),
  ] }));
  expect(correctBrainStage("proposing", c, NOW).stage).toBe("proposing");
});

console.log("\n■ 会話の方向の段階（戦略の文の語は見ない）");
it("status が申込以降なら applying（旧と同じ最優先）", () => {
  expect(resolveDirectionPhase({ checkpointStage: "proposing", status: "applying" })).toBe("applying");
  expect(resolveDirectionPhase({ checkpointStage: "hearing", status: "screening" })).toBe("applying");
});
it("段階がそのまま方向の段階になる（戦略の文「…申込へつなげる」でも viewing のまま＝YUMA の内覧調整中が applying になった件）", () => {
  expect(resolveDirectionPhase({ checkpointStage: "viewing", status: "proposing" })).toBe("viewing");
  expect(resolveDirectionPhase({ checkpointStage: "proposing", status: "property_recommendation" })).toBe("proposing");
  expect(resolveDirectionPhase({ checkpointStage: "hearing", status: "proposing" })).toBe("hearing");
});
it("contract は applying に畳む（方向の段階は4つ）", () => {
  expect(resolveDirectionPhase({ checkpointStage: "contract", status: "first_reply" })).toBe("applying");
});
it("段階が無い時は status から（status=viewing は古いことが多いので proposing）・それも無ければ hearing", () => {
  expect(resolveDirectionPhase({ checkpointStage: null, status: "property_search" })).toBe("hearing");
  expect(resolveDirectionPhase({ checkpointStage: null, status: "viewing" })).toBe("proposing");
  expect(resolveDirectionPhase({ checkpointStage: undefined, status: null })).toBe("hearing");
  expect(resolveDirectionPhase({ checkpointStage: "bogus", status: "estimate_request" })).toBe("proposing");
});
it("申込経験者（審査落ち→別の物件）は hearing に降格しない", () => {
  expect(resolveDirectionPhase({ checkpointStage: "hearing", status: "proposing", hasApplicationHistory: true })).toBe("proposing");
  expect(resolveDirectionPhase({ checkpointStage: "hearing", status: "proposing", hasApplicationHistory: false })).toBe("hearing");
});

console.log("\n■ 【現在フェーズの参考】の次の一手（戦略の文の語で定型文に置き換えない・2026-09-27）");
// 実物は scripts/audit-next-staff-action.ts（本番30日）で前後を読んだ物
it("ブレインの手順をそのまま（前置きだけ外す）。旧は語「物件」で『希望条件に合う物件を…送る』に置き換えていた", () => {
  expect(resolveNextStaffAction({ nextSteps: ["Step1（今すぐ）: 送付した4件への反応・気になる物件の有無を確認する", "Step2: …"], phase: "proposing" }))
    .toBe("送付した4件への反応・気になる物件の有無を確認する");
  expect(resolveNextStaffAction({ nextSteps: ["Step1: 両物件の保証会社審査進捗と、通過しやすい保証会社の有無を管理会社に確認する"], phase: "applying" }))
    .toBe("両物件の保証会社審査進捗と、通過しやすい保証会社の有無を管理会社に確認する");
});
it("旧は語「申込」で『申込書類の準備について自然に案内する』（書類を受け取った後でも）→ ブレインの手順のまま", () => {
  expect(resolveNextStaffAction({ nextSteps: ["Step1（今すぐ）: 管理会社へ火災保険申込用紙の日付指定再発行を依頼する"], phase: "applying" }))
    .toBe("管理会社へ火災保険申込用紙の日付指定再発行を依頼する");
});
it("（完了）の手順は飛ばして次の手順（旧は『Step1（完了）: 見積書を作成した』を次の一手にしていた）", () => {
  expect(resolveNextStaffAction({ nextSteps: ["Step1（完了）: 904号室の最大限割引済み見積書を作成した", "Step2（今すぐ）: 顧客からの申込返信・質問・確認を待機"], phase: "proposing" }))
    .toBe("顧客からの申込返信・質問・確認を待機");
});
it("前置きの無い手順・文字列1つの手順もそのまま", () => {
  expect(resolveNextStaffAction({ nextSteps: ["桜川・堀江・大国町エリアで家賃7万円以内の物件を再検索する"], phase: "hearing" })).toBe("桜川・堀江・大国町エリアで家賃7万円以内の物件を再検索する");
  expect(resolveNextStaffAction({ nextSteps: "Step1: 内覧の感想を伺う", phase: "viewing" })).toBe("内覧の感想を伺う");
});
it("手順が無い時は段階の既定。内覧の段階は日時が決まっている・当日・内覧済みで『日程を調整』を出さない", () => {
  expect(resolveNextStaffAction({ nextSteps: null, phase: "hearing" })).toBe("希望条件を確認");
  expect(resolveNextStaffAction({ nextSteps: [], phase: "viewing", viewingDetail: "scheduling" })).toBe("内覧日程を調整");
  expect(resolveNextStaffAction({ nextSteps: [], phase: "viewing", viewingDetail: "confirmed_future" })).toBe("内覧の日時は決まっている（日程の打診はしない）");
  expect(resolveNextStaffAction({ nextSteps: ["Step1（完了）: 待ち合わせを案内した"], phase: "viewing", viewingDetail: "today" })).toBe("本日が内覧日");
  expect(resolveNextStaffAction({ nextSteps: undefined, phase: "viewing", viewingDetail: "after_viewing" })).toBe("内覧済み（内覧後のフォロー）");
  expect(resolveNextStaffAction({ nextSteps: undefined, phase: null })).toBe("状況を確認して次の一手を判断");
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log("  - " + f); process.exit(1); }
