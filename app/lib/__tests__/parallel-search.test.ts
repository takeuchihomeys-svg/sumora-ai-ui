// 2026-09-26 段3（切り替え）: 主の一手＋並行で探す・退去予定の補正をお部屋ごとに・ブレインに渡す今の状況・生成の内覧の手引きの入口
// 実行: npx tsx app/lib/__tests__/parallel-search.test.ts（自己完結ハーネス。全 PASS で exit 0）
// 本文は実物（お客様の名前は YUMA に置き換え）
import {
  resolveParallelSearchScene, resolveParallelSearchOutput, buildParallelSearchBrainNote, buildParallelSearchReplyNote, parallelSearchInputsFromMessages,
} from "../parallel-search";
import { moveOutBlocksViewing, moveOutViewingVerdict, moveOutPropRefs, samePropRef, moveOutMsgsFromHistory, moveOutSwitchedToOtherProperty } from "../move-out-context";
import { buildCustomerStateBrainBlock, customerStateHasViewing, emptyCustomerState, type CustomerState } from "../customer-state";
import { runProposalChecks, runDeterministicChecks } from "../final-check";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(sub: string) { if (!String(actual).includes(sub)) throw new Error(`expected to contain ${JSON.stringify(sub)} but got ${JSON.stringify(actual)}`); },
    notToContain(sub: string) { if (String(actual).includes(sub)) throw new Error(`expected not to contain ${JSON.stringify(sub)} but got ${JSON.stringify(actual)}`); },
  };
}
const NOW = Date.parse("2026-09-26T12:00:00+09:00");
const state = (over: Partial<CustomerState>): CustomerState => ({ ...emptyCustomerState(null), ...over });

// ─── 退去予定の補正（穴:G5）: お部屋ごとに見る ───
// 9b9b81ba（9/24）: 9/18 に退去予定の第2エクセルハイツを送り先押さえを勧めた後、9/24 に新着の別の物件（パレス城北 401）→「日曜内覧可能でしょうか？」
//   旧: 会話全体で「退去予定→先押さえ」を見て AIX【申込へ】。スタッフは内覧へ（viewing_invite）
const g5 = [ // 新しい順
  { sender: "customer", text: "日曜内覧可能でしょうか？" },
  { sender: "staff", text: "パレス城北401号室家賃管理費込89,000円の2LDK54㎡・敷金礼金なしのお部屋となります😊！！\n\nリビングにエアコン設備・ガスコンロ残置、インターネット無料、太鼓橋今市駅徒歩5分・千林大宮駅徒歩8分の2沿線駅近となっております！！\n\nお気に召されましたらお部屋のご案内もさせていただきます😌！！\n\nお手隙に際にご査収ください！！" },
  { sender: "staff", text: "🌟パレス城北 401\n\nリビングにエアコン設備、ガスコンロが残置YUMAさんにかなりオススメ出来るお部屋となります！！" },
  { sender: "staff", text: "（室内イメージ）\nhttps://example.com/x" },
  { sender: "staff", text: "[画像]" },
  { sender: "staff", text: "YUMAさんお世話になっております！！\n\n新着で大阪市旭区・都島区にオススメできる2DK・2LDK以上家賃10万円以内のお部屋が2件募集にでました！！\n\nお手隙の際にご査収ください😌！！" },
  { sender: "staff", text: "第2エクセルハイツ110号室\n自転車23分程の立地でリノベーション済み、家賃管理費込80,000円のお部屋となります！！\n\nYUMAさんお気に召されましたらお申込みしお部屋押さえさせて頂きます😊！！\nお手隙の際にご査収ください！！" },
  { sender: "staff", text: "🌟第2エクセルハイツ 110\n\n勤務先まで自転車23分程ですが、リノバーションされたオススメのお部屋となります！！\n\nDK6帖・洋室6帖・洋室4.5帖の2DKで、YUMAさんご希望の1階のお部屋となります！！\n\n9月末退去予定のお部屋となります！！" },
];
it("9b9b81ba: 退去予定の話の後に別のお部屋を送った → 新しいお部屋の内覧の希望は申込へにしない", () => {
  const v = moveOutViewingVerdict(g5, "newest_first");
  expect(v.blocks).toBe(false);
  expect(v.reason).toBe("switched_to_other_property");
});
it("同じ会話で、先押さえを勧めた直後（別のお部屋を送る前）の内覧の希望は従来どおり申込へ", () => expect(moveOutBlocksViewing([{ sender: "customer", text: "内覧可能でしょうか？" }, ...g5.slice(6)], "newest_first")).toBe(true));
it("お客様が退去予定のお部屋を名前で指した内覧の希望は、別のお部屋を送った後でも申込へ（そのお部屋の先押さえの勧めが最後）", () => {
  // 別のお部屋を送った後に、退去予定のお部屋にまた先押さえを勧めていれば補正する
  const msgs = [{ sender: "customer", text: "第2エクセルハイツの内覧できますか？" }, { sender: "staff", text: "第2エクセルハイツ110号室は9月末退去予定のため、先にお申込みしお部屋を抑えさせて頂きます！！" }, ...g5.slice(1)];
  expect(moveOutBlocksViewing(msgs, "newest_first")).toBe(true);
});
it("お客様が別のお部屋を名前で指した → 補正しない", () => {
  const msgs = [{ sender: "customer", text: "パレス城北の内覧できますか？" }, ...g5.slice(6)];
  const withSend = [msgs[0], g5[1], ...g5.slice(6)];
  expect(moveOutViewingVerdict(withSend, "newest_first").reason).toBe("customer_names_other_property");
});
it("物件送付の定型の締め（先押さえ）が別のお部屋の送付に付いている → 退去予定のお部屋の先押さえに数えない", () => {
  const msgs = [
    { sender: "customer", text: "内覧したいです" },
    { sender: "staff", text: "RIDGE江坂102号室 新着のお部屋となります！！\nお気に召されましたらお申込みしお部屋抑えさせて頂きます！！" },
    { sender: "staff", text: "メゾンラトゥール 103号室現在募集中となります！！\n10月30日退去予定、11月末ごろご入居可能なお部屋となります！！" },
  ];
  expect(moveOutViewingVerdict(msgs, "newest_first").reason).toBe("hold_for_other_property");
});
it("隼斗（既存の型）: 退去予定のお部屋の本文と同じ通の先押さえは従来どおり", () => {
  expect(moveOutBlocksViewing([{ sender: "customer", text: "一度内見してみたいです！" }, { sender: "staff", text: "クレール元町 203号室の初期費用御見積書同封させて頂きました！！\n退去予定のお部屋となりますので、お気に召されましたらお申込みしお部屋を抑えさせて頂きます！！" }], "newest_first")).toBe(true);
});
it("お部屋の手がかり: 「🌟パレス城北 401」「パレス城北401号室家賃」は同じお部屋・「第2エクセルハイツ 110」とは別", () => {
  const a = moveOutPropRefs("🌟パレス城北 401\n本文")[0];
  const b = moveOutPropRefs("パレス城北401号室家賃管理費込")[0];
  const c = moveOutPropRefs("🌟第2エクセルハイツ 110")[0];
  expect(samePropRef(a, b)).toBe(true);
  expect(samePropRef(a, c)).toBe(false);
});
it("号室の0埋め（0601↔601）は同じお部屋", () => expect(samePropRef(moveOutPropRefs("プレサンス心斎橋レヨン 0601号室")[0], moveOutPropRefs("【プレサンス心斎橋レヨン 601号室】")[0])).toBe(true));

// 9/5 以降に guard:viewing が働いた残りの実物（2026-09-26 新旧を当てた・4件とも新でスタッフの動きと合う）
// ad97cd40（9/22）: 名前の無い「10月末退去予定で募集にでました」→ アービングNeo岸里玉出に先押さえの勧め → 別の2件の見積 →「neoとこの二件行きたいです！」
//   スタッフは AIX【申込へ】。退去予定のお部屋が名前で取れない時は旧のまま（補正する）
const ad97 = [ // 新しい順
  { sender: "customer", text: "neoとこの二件行きたいです！" },
  { sender: "customer", text: "ありがとうございます！" },
  { sender: "staff", text: "YUMAさん\nお世話になっております！！\n\nアービンクNEO岸里玉出の駐車場に関して確認させていただき、屋外と屋内の2パターンあり屋外はマンションエントランス前方予定、屋内はマンションエントランス横から入っていただき、屋根付きの箇所とのことです！！\n\nどちらも1階が駐車スペースとなります😊！！" },
  { sender: "staff", text: "アービングNeo岸里玉出の駐車場の詳細につきまして明日管理会社に確認させて頂き、確認出来次第ご連絡させて頂きます！！" },
  { sender: "staff", text: "YUMAさん\n2件とも最大限割引しました初期費用の御見積書となります😊！！\nお手隙の際にご査収ください！！" },
  { sender: "customer", text: "こちら、礼金下げることは厳しいですか🥲" },
  { sender: "staff", text: "①【グランパシフィック花園Luxe 1006号室】\n\n初期費用さらに\n🌟33,000円割引させて頂き\n初期費用：287,480円\n\n②【堀江サン・ユー 501号室】\n\n初期費用さらに\n🌟30,000円割引させて頂き\n初期費用：258,570円" },
  { sender: "staff", text: "[画像]" },
  { sender: "customer", text: "新しく来た2件の、初期費用知りたいです！" },
  { sender: "customer", text: "ここの駐車所って１階ですか？" },
  { sender: "staff", text: "また全ての物件ふまえまして、お部屋の条件や、初期費用の安さを含めましてアービングNeo岸里玉出がYUMAさんに1番オススメのお部屋です！！\nアービングNeo岸里玉出のこり4部屋となり、今月内にも物件が全て募集埋まってしまう可能性が高いです！！\n\nアービングNeo岸里玉出お気に召されていましたらお申込しお部屋を抑えて頂き最終判断頂く事できますので、ご検討されていましたらお気軽にお申し付けください！！" },
  { sender: "staff", text: "[画像]" },
  { sender: "staff", text: "YUMAさんのご条件に合ったお部屋が10月末退去予定で募集にでました😊！！" },
];
it("ad97cd40: 退去予定のお部屋に名前が無い → 旧のまま先押さえの勧めで申込へ（スタッフも申込へ）", () => {
  const v = moveOutViewingVerdict(ad97, "newest_first");
  expect(v.blocks).toBe(true);
  expect(v.reason).toBe("hold_advised");
});
// 9b9b81ba（9/15）: 退去予定のお部屋（メゾンラトゥール 103）そのものの内覧の希望・先押さえの勧めは無い → 補正しない（スタッフは内覧へ）
it("9b9b81ba 9/15: 退去予定のお部屋そのものへの内覧の希望で先押さえの勧めが無い → 申込へにしない", () => {
  const msgs = [
    { sender: "customer", text: "こちら内覧希望です" },
    { sender: "staff", text: "お送りいただきました物件の中で\nメゾンラトゥール 103号室現在募集中となります！！\n10月30日退去予定、11月末ごろご入居可能なお部屋となります！！\n御見積書同封させて頂きました！！\n\nYUMAさんお送りいただきました他2件は\n募集終了しているお部屋となります。\n引き続き条件に合うお部屋を探させていただきます！！" },
    { sender: "staff", text: "かしこまりました。\n本日17:00からのご予約キャンセルさせていただきます！！\n\n引き続き新着でオススメできるお部屋で次第お送りさせていただきます！！" },
  ];
  const v = moveOutViewingVerdict(msgs, "newest_first");
  expect(v.blocks).toBe(false);
  expect(v.reason).toBe("no_hold_advice");
});

// 生成（detectPropertyStatus）の履歴の形「スモラ:」「お客様:」からも同じ判定になる
it("生成の履歴の形（スモラ:／お客様:・続きの行）でも 9b9b81ba は別のお部屋に移っている", () => {
  const hist = [...g5.slice(1)].reverse().map((m) => `${m.sender === "staff" ? "スモラ" : "お客様"}: ${m.text}`).join("\n");
  const msgs = moveOutMsgsFromHistory(hist, "日曜内覧可能でしょうか？");
  expect(msgs.length).toBe(8);
  expect(moveOutSwitchedToOtherProperty(moveOutViewingVerdict(msgs, "oldest_first"))).toBe(true);
});
// 最終チェック E6（退去予定のお部屋への内覧誘導）も同じ判定
const e6ctx = (msgsNewestFirst: Array<{ sender: string; text: string }>, cust: string) => ({
  lastCustomerMessage: cust, customerName: "YUMA",
  recentMessages: [...msgsNewestFirst].reverse().map((m, i) => ({ ...m, createdAt: new Date(Date.parse("2026-09-18T00:00:00Z") + i * 3600e3).toISOString() })),
}) as unknown as Parameters<typeof runDeterministicChecks>[1];
it("E6: 別のお部屋（パレス城北）の内覧の案内は VIEWING_BEFORE_VACANCY にしない／退去予定のお部屋だけの会話では従来どおり", () => {
  const text = "かしこまりました😊！！\nパレス城北401号室日曜日もご内覧可能です！！";
  const codes = runDeterministicChecks(text, e6ctx(g5.slice(1), "日曜内覧可能でしょうか？")).map((i) => i.code);
  expect(codes.includes("VIEWING_BEFORE_VACANCY")).toBe(false);
  const text2 = "かしこまりました😊！！\n第2エクセルハイツ110号室日曜日もご内覧可能です！！";
  const codes2 = runDeterministicChecks(text2, e6ctx(g5.slice(6), "日曜内覧可能でしょうか？")).map((i) => i.code);
  expect(codes2.includes("VIEWING_BEFORE_VACANCY")).toBe(true);
});

// ─── 並行で探す場面（決定論） ───
const viewedState = state({ stage: "viewed", viewings: [{ ymd: "2026-09-24", time: "14:00", name: "ジュネスニッコー 1003号室", status: "done", thankedAt: "2026-09-24T08:00:00Z" }] });
it("内覧後 → after_viewing（日付と物件を根拠に）", () => {
  const c = resolveParallelSearchScene({ state: viewedState, customerTurnText: "ありがとうございました！少し考えます", recentStaffTexts: [], silenceDays: 0.1, nowMs: NOW });
  expect(c.scene).toBe("after_viewing");
  expect(c.evidence).toBe("9/24 ジュネスニッコー 1003号室の内覧の後");
});
it("申込・審査中＋きっかけ（ほかの物件も） → applying／きっかけの無い「よろしくお願いします」は場面にしない（CS-5 の反証）", () => {
  expect(resolveParallelSearchScene({ state: state({ stage: "applying" }), customerTurnText: "審査中ですが他の物件も見てみたいです", recentStaffTexts: [], silenceDays: 0, nowMs: NOW }).scene).toBe("applying");
  expect(resolveParallelSearchScene({ state: state({ stage: "applying" }), customerTurnText: "よろしくお願いします", recentStaffTexts: [], silenceDays: 0, nowMs: NOW }).scene).toBe(null);
});
it("内覧後でもきっかけが無い「ありがとうございました！」は場面にしない", () => expect(resolveParallelSearchScene({ state: viewedState, customerTurnText: "本日はありがとうございました！", recentStaffTexts: [], silenceDays: 0.1, nowMs: NOW }).scene).toBe(null));
it("2番手を伝えた後 → rank_waiting（「1番手でお申込み可能」は含めない）", () => {
  expect(resolveParallelSearchScene({ state: state({ stage: "interested" }), customerTurnText: "そうなんですね", recentStaffTexts: ["先行申込が入っており2番手でのお申込みとなります"], silenceDays: 0, nowMs: NOW }).scene).toBe("rank_waiting");
  expect(resolveParallelSearchScene({ state: state({ stage: "interested" }), customerTurnText: "そうなんですね", recentStaffTexts: ["1301号室は1番手でお申込み可能なお部屋となります"], silenceDays: 0, nowMs: NOW }).scene).toBe(null);
});
it("7日以上ぶり → returned_after_silence", () => expect(resolveParallelSearchScene({ state: state({ stage: "proposing" }), customerTurnText: "お久しぶりです、他にも物件ありますか？", recentStaffTexts: [], silenceDays: 12.3, nowMs: NOW }).evidence).toBe("12日ぶり"));
it("成約・見送り・「ここに決めました」・まだ物件を送っていない は場面にしない", () => {
  expect(resolveParallelSearchScene({ state: state({ stage: "won" }), customerTurnText: "", recentStaffTexts: [], silenceDays: 30, nowMs: NOW }).scene).toBe(null);
  expect(resolveParallelSearchScene({ state: viewedState, customerTurnText: "ここに決めました！", recentStaffTexts: [], silenceDays: 0, nowMs: NOW }).blockedBy).toContain("決めた");
  expect(resolveParallelSearchScene({ state: state({ stage: "searching" }), customerTurnText: "", recentStaffTexts: [], silenceDays: 10, nowMs: NOW }).scene).toBe(null);
});
it("メッセージから材料: 連投・直前のこちらの連投（72時間以内）・間の日数", () => {
  const r = parallelSearchInputsFromMessages([
    { sender: "customer", text: "2番手でも大丈夫です", created_at: "2026-09-26T03:00:00Z" },
    { sender: "customer", text: "ありがとうございます", created_at: "2026-09-26T02:59:00Z" },
    { sender: "staff", text: "2番手でのお申込みとなります", created_at: "2026-09-25T03:00:00Z" },
    { sender: "staff", text: "古い", created_at: "2026-09-20T03:00:00Z" },
    { sender: "customer", text: "前", created_at: "2026-09-19T03:00:00Z" },
  ]);
  expect(r.customerTurnText).toBe("ありがとうございます\n2番手でも大丈夫です");
  expect(r.recentStaffTexts.length).toBe(1);
  expect(Math.round(r.silenceDays! * 10) / 10).toBe(1);
});

// ─── ブレインの出力の後処理（必須にしない・AIX は1つ・2つ目に物件ピックアップ） ───
const ctxViewed = resolveParallelSearchScene({ state: viewedState, customerTurnText: "少し考えます", recentStaffTexts: [], silenceDays: 0, nowMs: NOW });
it("ブレインが true → on・alt_actions に物件ピックアップを並べる（主の一手はそのまま）", () => {
  const r = resolveParallelSearchOutput(ctxViewed, { parallel_search: true, parallel_search_reason: "迷っている" }, "application_push", undefined);
  expect(r.parallel?.on).toBe(true);
  expect((r.altActions ?? []).join(",")).toBe("property_send");
});
it("ブレインが false・項目なし → off（alt はそのまま）", () => {
  expect(resolveParallelSearchOutput(ctxViewed, { parallel_search: false }, "application_push", ["property_recommendation"]).altActions?.join(",")).toBe("property_recommendation");
  expect(resolveParallelSearchOutput(ctxViewed, {}, null, undefined).parallel?.on).toBe(false);
});
it("主の一手がもう物件の送付 → 並行の印は付けない", () => expect(resolveParallelSearchOutput(ctxViewed, { parallel_search: true }, "property_send", undefined).parallel?.on).toBe(false));
it("場面の外 → ブレインが true でも何も付けない", () => {
  const none = resolveParallelSearchScene({ state: state({ stage: "proposing" }), customerTurnText: "", recentStaffTexts: [], silenceDays: 1, nowMs: NOW });
  expect(resolveParallelSearchOutput(none, { parallel_search: true }, null, undefined).parallel).toBe(undefined);
});
it("既に探す AIX が並んでいれば重ねない", () => expect(resolveParallelSearchOutput(ctxViewed, { parallel_search: true }, "estimate_sheet", ["property_recommendation"]).altActions?.join(",")).toBe("property_recommendation"));
it("ブレインへの材料は場面・実績・JSON の項目を書く（「探せ」の決まりにしない）", () => {
  const n = buildParallelSearchBrainNote(ctxViewed);
  expect(n).toContain("parallel_search");
  expect(n).toContain("両方は少数");
  expect(n).toContain("既定は false");
  expect(buildParallelSearchBrainNote({ scene: null, evidence: null, blockedBy: null })).toBe("");
});
it("生成への材料は許可（添えてもよい・添えなくてもよい）で、実送信の形を示す", () => {
  const n = buildParallelSearchReplyNote({ on: true, reason: "迷っている", scene: "after_viewing" });
  expect(n).toContain("添えてもよい（添えなくてもよい）");
  expect(n).toContain("引き続き新着でおすすめできる物件が出次第ご連絡させて頂きます");
  expect(buildParallelSearchReplyNote({ on: false, reason: null, scene: "after_viewing" })).toBe("");
});

// ─── ブレインに渡す今の状況 ───
it("今の状況のブロック: 段階・主のお部屋・内覧（お礼があれば実施済み）・ずれ", () => {
  const s = state({
    stage: "viewing_scheduled", stageLabel: "内覧予定", stageDetail: "9/28(月)14:00", since: "2026-09-25T03:00:00Z",
    focusKey: "k1",
    properties: [
      { key: "k1", name: "ジュネスニッコー 1003号室", building: "ジュネスニッコー", room: "1003", status: "viewing_scheduled", statusLabel: "内覧予定", vacating: false, estimateSent: true, customerInterest: true, sentByUs: true, firstAt: "2026-09-20T03:00:00Z", lastAt: "2026-09-25T03:00:00Z", events: [{ kind: "viewing_scheduled", at: "2026-09-25T03:00:00Z", source: "viewing" }], maybeSameAs: [] },
      { key: "k2", name: "RIDGE江坂 102号室", building: "RIDGE江坂", room: "102", status: "ended", statusLabel: "終了", vacating: false, estimateSent: false, customerInterest: false, sentByUs: true, firstAt: "2026-09-20T03:00:00Z", lastAt: "2026-09-21T03:00:00Z", events: [], maybeSameAs: [] },
      { key: "k3", name: "テスト荘 101号室", building: "テスト荘", room: "101", status: "candidate", statusLabel: "候補", vacating: false, estimateSent: false, customerInterest: false, sentByUs: true, firstAt: "2026-09-20T03:00:00Z", lastAt: "2026-09-20T03:00:00Z", events: [], maybeSameAs: [] },
    ],
    viewings: [{ ymd: "2026-09-20", time: "12:00", name: null, status: "done", thankedAt: "2026-09-20T06:00:00Z" }, { ymd: "2026-09-28", time: "14:00", name: "ジュネスニッコー 1003号室", status: "scheduled", thankedAt: null }],
    conflicts: [{ code: "STATUS_VIEWING_STALE", severity: "warn", detail: "状態＝内覧のまま" }, { code: "PHASE_MISMATCH", severity: "info", detail: "info は出さない" }],
    searching: { active: true, reason: "sent_after_focus", since: "2026-09-24T03:00:00Z" },
  });
  const b = buildCustomerStateBrainBlock(s);
  expect(b).toContain("今の段階: 内覧予定（9/28(月)14:00）");
  expect(b).toContain("主のお部屋: ジュネスニッコー 1003号室 — 内覧予定・見積済・お客様が指名");
  expect(b).toContain("募集終了のお部屋: RIDGE江坂 102号室");
  expect(b).toContain("送っただけの候補: 1件");
  expect(b).toContain("物件名の記録なし（実施済み・内覧後のお礼を送付済み）");
  expect(b).toContain("探し続けている: はい");
  expect(b).toContain("状態＝内覧のまま");
  expect(b).notToContain("info は出さない");
});

// ─── 生成の内覧の手引きの入口（status=viewing の残り） ───
it("これからの内覧が無く内覧後でもない → 内覧の話なし（status=viewing の残りで内覧の手引きを書かない）", () => {
  expect(customerStateHasViewing(state({ stage: "proposing" }), NOW)).toBe(false);
  expect(customerStateHasViewing(state({ stage: "viewing_arranging" }), NOW)).toBe(true);
  expect(customerStateHasViewing(state({ stage: "viewed", viewings: [{ ymd: "2026-09-24", time: null, name: null, status: "done", thankedAt: null }] }), NOW)).toBe(true);
  expect(customerStateHasViewing(state({ stage: "viewed", viewings: [{ ymd: "2026-08-24", time: null, name: null, status: "done", thankedAt: null }] }), NOW)).toBe(false);
  expect(customerStateHasViewing(null, NOW)).toBe(false);
});

// ─── 最終チェック（四者同名）: 並行で探す時は引き続き探す一文を余計な提案に数えない ───
it("お礼だけの返事に「引き続き…お探し」: 並行で探す判断があれば UNPROMPTED_PROPOSAL にしない", () => {
  const text = "こちらこそありがとうございました😊！！\n引き続きYUMAさんにオススメ出来るお部屋お探しさせて頂きます！！";
  const cust = "ありがとうございました😊";
  const base = {
    lastCustomerMessage: cust, customerName: "YUMA",
    recentMessages: [{ sender: "staff", text: "YUMAさん\n本日お時間頂きありがとうございました！！", createdAt: "2026-09-24T08:00:00Z" },
                     { sender: "customer", text: cust, createdAt: "2026-09-24T08:10:00Z" }],
  } as unknown as Parameters<typeof runProposalChecks>[1];
  const without = runProposalChecks(text, base).filter((i) => i.code === "UNPROMPTED_PROPOSAL").length;
  const withP = runProposalChecks(text, { ...base, parallelSearch: true }).filter((i) => i.code === "UNPROMPTED_PROPOSAL").length;
  expect(without).toBe(1); // 並行の判断が無ければ従来どおり余計な提案として指摘する
  expect(withP).toBe(0);
  // 反証レビュー: 同じブレインが avoid_topics に新規ピックアップを入れていれば、避ける方を優先（免除しない・block）
  const avoid = runProposalChecks(text, { ...base, parallelSearch: true, brainStrategy: { avoid_topics: ["新規物件ピックアップ"] } } as unknown as Parameters<typeof runProposalChecks>[1])
    .filter((i) => i.code === "UNPROMPTED_PROPOSAL");
  expect(avoid.length).toBe(1);
  expect(avoid[0]?.severity).toBe("block");
});

// ─── 反証レビュー（2026-09-26）: お部屋の照合の誤りで退去予定の縛りを外さない ───
it("「第2エクセルハイツ 110」と「第二エクセルハイツ110号室」は同じお部屋（漢数字）→ 退去予定のお部屋の後の通を別のお部屋と読まない", () => {
  expect(samePropRef(moveOutPropRefs("🌟第2エクセルハイツ 110")[0], moveOutPropRefs("第二エクセルハイツ110号室の件")[0])).toBe(true);
  const msgs = [
    { sender: "staff", text: "🌟第2エクセルハイツ 110\n9月末退去予定のお部屋となります！！\nお気に召されましたらお申込みしお部屋押さえさせて頂きます！！" },
    { sender: "customer", text: "ありがとうございます" },
    { sender: "staff", text: "第二エクセルハイツ110号室は現地のご案内が10月以降となります！！" },
    { sender: "customer", text: "内覧可能でしょうか？" },
  ];
  expect(moveOutViewingVerdict(msgs, "oldest_first").reason).toBe("hold_advised");
});
it("費用の見出し【家賃 65000】【管理費 5000】はお部屋にしない・「こちらのメゾンラトゥール 103号室」は名前を残す", () => {
  expect(moveOutPropRefs("【家賃 65000】\n【管理費 5000】").length).toBe(0);
  expect(moveOutPropRefs("こちらのメゾンラトゥール 103号室")[0]?.room).toBe("103");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
