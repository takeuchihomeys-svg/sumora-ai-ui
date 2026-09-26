// 2026-09-26 竹内「お客さん気に入ったお部屋あって、今はそのお部屋の内覧前の状態なども認識できるように」「トークの上に今の状況…ズレがあった際にわかりやすい」
//   お客様の今の段階とお部屋ごとの状況（app/lib/customer-state.ts）。物件名・本文の形は本番の実物（2026-09-26 scripts/audit-customer-state.ts の CS 節で読んだ物）。
//   お客様の名前は YUMA に置き換えた。
// 実行: npx tsx app/lib/__tests__/customer-state.test.ts（自己完結ハーネス。全 PASS で exit 0）
import {
  resolveCustomerState, splitPropertyName, matchRoomRefs, estimateNamesFromText, cleanBuildingName, pickSingleFocusName,
  isDecidedElsewhere, applicationPropertyFromText, focusEventsFromFacts, focusEventsFromAixRows, buildingKeyOf, normalizeRoomNo, viewingLabel,
  compactCustomerStateForView,
  type CustomerStateInput, type CustomerStateAixRow,
} from "../customer-state";
import type { RecordedFact } from "../action-ledger";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toEqual(exp: unknown) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(sub: string) { if (!String(actual).includes(sub)) throw new Error(`expected to contain ${JSON.stringify(sub)} but got ${JSON.stringify(actual)}`); },
    notToContain(sub: string) { if (String(actual).includes(sub)) throw new Error(`expected NOT to contain ${JSON.stringify(sub)} but got ${JSON.stringify(actual)}`); },
  };
}
const ref = (s: string) => splitPropertyName(s)!;
// 2026-09-26(土) 12:00 JST
const NOW = Date.parse("2026-09-26T03:00:00Z");
const base = (o: Partial<CustomerStateInput>): CustomerStateInput => ({
  now: NOW, status: "proposing", messages: [], aixRows: [], recordedFacts: [], viewingHistory: [], sentProperties: [], lineTasks: [], ...o,
});
const C = (t: string, text: string) => ({ sender: "customer", text, createdAt: t });
const S = (t: string, text: string, isAix = false) => ({ sender: "staff", text, createdAt: t, isAix });
const AX = (t: string, aix_type: string, extra: Partial<CustomerStateAixRow> = {}): CustomerStateAixRow => ({ aix_type, created_at: t, sent_at: t, generated_text: null, property_names: null, estimate_sent: null, ...extra });

// 実物（aix_usage_logs estimate_sheet 1191b1eb・969f0162 の本文の形）
const ESTIMATE_2 = "①【伊原文化 206号室】\n\n初期費用：102,280円\n\nスモラなら一般的な不動産業者より24,520円節約出来ます！！\n\n②【マンション冨士】\n\n初期費用：52,980円\n\n※ご入居日によって日割家賃が発生致します。";
const ESTIMATE_1 = "【ジュネスニッコー 1003号室】\n\n初期費用さらに\n🌟48,000円割引させて頂き\n初期費用：213,000円\n\n※ご入居日によって日割家賃が発生致します。";

console.log("\n■ お部屋の照合（表記ゆれは寄せる・似ているだけは寄せない）");
it("空白なしの部屋番号「ジュネスニッコー1003」と「ジュネスニッコー 1003号室」は同じ部屋", () => {
  expect(matchRoomRefs(ref("ジュネスニッコー1003"), ref("ジュネスニッコー 1003号室"))).toBe("same_room");
});
it("号室の0埋め（0908↔908）は同じ部屋", () => {
  expect(matchRoomRefs(ref("ラクラス阿倍野元町 0507号室"), ref("ラクラス阿倍野元町 507号室"))).toBe("same_room");
  expect(normalizeRoomNo("0908号室")).toBe("908");
});
it("長音の有無（メルクリオル↔メルクリオール）は同じ建物", () => {
  expect(buildingKeyOf("メルクリオル難波")).toBe(buildingKeyOf("メルクリオール難波"));
});
it("Ⅱ↔II・大文字小文字と空白は同じ建物", () => {
  expect(matchRoomRefs(ref("KIIレジデンス西中島Ⅱ 202号室"), ref("KIIレジデンス西中島II 202号室"))).toBe("same_room");
  expect(matchRoomRefs(ref("OPUS RESIDENCE SHINSAIBASHI SOUTH 702号室"), ref("opus residence shinsaibashisouth 702"))).toBe("same_room");
});
it("同じ建物の別の部屋は別に持つ（スプランディッド本町グラン 1604↔1003）", () => {
  expect(matchRoomRefs(ref("スプランディッド本町グラン 1604号室"), ref("スプランディッド本町グラン 1003号室"))).toBe("different_room");
});
it("片方に部屋が無ければ建物で寄せる", () => {
  expect(matchRoomRefs(ref("スプランディッド本町グラン"), ref("スプランディッド本町グラン 1604号室"))).toBe("same_building");
});
it("画像の誤読（CITY SPIRE↔CITY SPIKE）・略称は寄せずに maybe（未確認）", () => {
  expect(matchRoomRefs(ref("CITY SPIRE難波"), ref("CITY SPIKE難波"))).toBe("maybe");
  expect(matchRoomRefs(ref("ジュネス"), ref("ジュネスニッコー"))).toBe("maybe");
});
it("別物は different（シリーズ名が同じでも寄せない: グランパシフィック生野東↔梅南）", () => {
  const m = matchRoomRefs(ref("グランパシフィック生野東"), ref("グランパシフィック梅南"));
  if (m === "same_room" || m === "same_building") throw new Error(`寄せてはいけない: ${m}`);
});
it("建物名が数字で終わる（リーダースパーク21）は部屋にしない・「3階」は階", () => {
  expect(ref("リーダースパーク21").room).toBe(null);
  expect(ref("プルス新北野 3階").building).toBe("プルス新北野");
  expect(ref("プルス新北野 3階").room).toBe(null);
});

console.log("\n■ 見積書の【】ラベル・物件名の整え");
it("見積書の本文の【】から物件名（号室の無い【マンション冨士】も）", () => {
  expect(estimateNamesFromText(ESTIMATE_2)).toEqual(["伊原文化 206号室", "マンション冨士"]);
  expect(estimateNamesFromText(ESTIMATE_1)).toEqual(["ジュネスニッコー 1003号室"]);
});
it("日割りの説明だけの見積書の本文は物件なし", () => {
  expect(estimateNamesFromText("10/15日から10/31日の17日間分の日割り家賃含めたお見積書お送りさせていただきました😊！！")).toEqual([]);
});
it("申込フォーマットの【〇〇欄】は物件にしない", () => {
  expect(estimateNamesFromText("【緊急連絡先欄】\n・氏名、フリガナ\n【同居人記入欄】")).toEqual([]);
});
it("待ち合わせの場所に混ざった文の頭を外す（d9d1f3c5）", () => {
  expect(cleanBuildingName("お部屋ご案内させて頂きます!! アーバネックス堺筋本町")).toBe("アーバネックス堺筋本町");
});
it("人の呼び名・お客様の文・画面の既定の名前は物件名にしない", () => {
  expect(cleanBuildingName("YUMAさん")).toBe(null);
  expect(cleanBuildingName("バルコニーを必要としていないので、丁度いいかもしれなくて")).toBe(null);
  expect(cleanBuildingName("(室内イメージ)")).toBe(null);
  expect(cleanBuildingName("物件1")).toBe(null);
  expect(cleanBuildingName("ネット口座振替登録手順のご案内")).toBe(null);
  expect(cleanBuildingName("選べる無料ギフトがたくさん!お見逃しなく!🎁")).toBe(null);
});

console.log("\n■ 1件に決まる今の相手のお部屋（申込の案内・物件名の無い内覧の推定）");
it("直前の見積が1部屋ならその部屋", () => {
  expect(pickSingleFocusName([{ at: "2026-09-20T03:00:00Z", names: ["ジュネスニッコー 1003号室"] }], "2026-09-21T03:00:00Z")).toBe("ジュネスニッコー 1003号室");
});
it("直前の見積が2物件なら決めない（null）", () => {
  expect(pickSingleFocusName([
    { at: "2026-09-18T03:00:00Z", names: ["ジュネスニッコー 1003号室"] },
    { at: "2026-09-20T03:00:00Z", names: ["伊原文化 206号室", "マンション冨士"] },
  ], "2026-09-21T03:00:00Z")).toBe(null);
});
it("21日より前の出来事は使わない", () => {
  expect(pickSingleFocusName([{ at: "2026-08-01T03:00:00Z", names: ["ジュネスニッコー 1003号室"] }], "2026-09-21T03:00:00Z")).toBe(null);
});
it("送信時の記録・AIX の記録から関心の出来事を作る（見積の estimateFor が空でも本文の【】で）", () => {
  const facts: Array<Pick<RecordedFact, "sent_at" | "kind" | "detail">> = [
    { sent_at: "2026-09-20T03:00:00Z", kind: "meeting_place_sent", detail: { appointment: { dateMD: "9/28", time: "12:00", place: "ジュネスニッコー 1003号室" } } },
    { sent_at: "2026-09-19T03:00:00Z", kind: "estimate_sent", detail: {} },
  ];
  expect(focusEventsFromFacts(facts).length).toBe(1);
  expect(focusEventsFromAixRows([AX("2026-09-19T03:00:00Z", "estimate_sheet", { generated_text: ESTIMATE_2 })])[0].names.length).toBe(2);
  expect(focusEventsFromAixRows([AX("2026-09-19T03:00:00Z", "property_check_result", { property_names: ["A棟 101号室", "Bハイツ 202号室"], prop_statuses: ["unavailable", "available"] })])[0].names).toEqual(["Bハイツ 202号室"]);
});

console.log("\n■ 他で決めた（お客様の言葉・365日の実物）");
it("当てる3通", () => {
  expect(isDecidedElsewhere("お世話になっております。 他の不動産屋で審査通しており返信していなかったのですが、そちらで物件決まりました。 ご協力いただいたのにすみませんありがとうございました。")).toBe(true);
  expect(isDecidedElsewhere("その後いろいろ検討した結果、〇〇様で契約を進めることになりました。 お忙しい中…このような結果となり申し訳ありません。")).toBe(true);
  expect(isDecidedElsewhere("わかりました！ ありがとうございました！ 他社で探します！")).toBe(true);
});
it("当てない（比べている・仮押さえ・条件つき・他社より安いので契約したい）", () => {
  expect(isDecidedElsewhere("この3件も他社で紹介していただいて、YUMAさんでも見積もりを出していただきたいです🥺")).toBe(false);
  expect(isDecidedElsewhere("前に見積もりだしていただいた富士林プラザなんですけど彼氏が別の不動産で仮押さえしてもらってるみたいで")).toBe(false);
  expect(isDecidedElsewhere("3親等が絶対条件でなければ審査通せない場合は、条件外なので諦めて他社で探します。")).toBe(false);
  expect(isDecidedElsewhere("他社より安いため契約させて頂きたいのですが、審査など詳細お聞きしてもよろしいでしょうか？")).toBe(false);
  expect(isDecidedElsewhere("別の不動産会社で、お送りした部屋の内見予約をしているのですが、契約先はまだ決めておらず比較検討中です。")).toBe(false);
  expect(isDecidedElsewhere("先程引っ越し業者と契約しました。6／6にしました。")).toBe(false);
});

console.log("\n■ 今の段階（resolveCustomerState）");
it("こちらがまだ何も送っていない → 初回", () => {
  const s = resolveCustomerState(base({ status: "hearing", messages: [C("2026-09-26T01:00:00Z", "はじめまして！お部屋探しています")] }));
  expect(s.stage).toBe("first");
  expect(s.headline).toContain("初回");
});
it("探す約束だけで物件をまだ送っていない → 物件検索中（まだ物件は未送付）", () => {
  const s = resolveCustomerState(base({ messages: [
    C("2026-09-25T01:00:00Z", "梅田周辺で1LDK探しています"),
    S("2026-09-25T01:10:00Z", "かしこまりました！！ご希望のご条件に合ったお部屋ピックアップしお送りさせて頂きます😊！！"),
  ] }));
  expect(s.stage).toBe("searching");
  expect(s.stageDetail).toBe("まだ物件は未送付");
});
it("見積（1部屋）→ 待ち合わせ案内（9/28 12:00）→ 内覧予定・日時・物件・見積済", () => {
  const s = resolveCustomerState(base({
    messages: [
      S("2026-09-20T03:00:00Z", ESTIMATE_1, true),
      C("2026-09-21T03:00:00Z", "内覧したいです！28日の12時いけますか？"),
      S("2026-09-21T03:10:00Z", "かしこまりました！！\n9/28 12:00にジュネスニッコー 1003号室\n現地エントランスお待ち合わせで何卒よろしくお願い致します😌！！", true),
    ],
    aixRows: [AX("2026-09-20T03:00:00Z", "estimate_sheet", { generated_text: ESTIMATE_1 }), AX("2026-09-21T03:10:00Z", "meeting_place", { generated_text: "かしこまりました！！\n9/28 12:00にジュネスニッコー 1003号室\n現地エントランスお待ち合わせで何卒よろしくお願い致します😌！！" })],
  }));
  expect(s.stage).toBe("viewing_scheduled");
  expect(s.upcomingViewing?.label ?? "").toBe("9/28(月)12:00");
  expect(s.headline).toContain("🏠 内覧予定 9/28(月)12:00 ジュネスニッコー 1003号室");
  expect(s.headline).toContain("見積済");
  expect(s.properties[0].status).toBe("viewing_scheduled");
  expect(s.properties[0].estimateSent).toBe(true);
});
it("AIX【内覧に誘う】の本文で待ち合わせを案内した回も内覧の予定に読む・その後キャンセルなら予定にしない（4aef01ff 型）", () => {
  const meet = "かしこまりました！！ 9/30 14:00ご案内させて頂きます！！ 9/30 14:00にスプランディッド難波VII 現地エントランスお待ち合わせで何卒よろしくお願い致します😌！！";
  const scheduled = resolveCustomerState(base({ messages: [C("2026-09-24T09:35:00Z", "9/30 14:00大丈夫ですか？"), S("2026-09-24T09:37:00Z", meet, true)], aixRows: [AX("2026-09-24T09:36:00Z", "viewing_invite", { generated_text: meet })] }));
  expect(scheduled.stage).toBe("viewing_scheduled");
  const cancelled = resolveCustomerState(base({ status: "viewing", messages: [
    C("2026-09-24T09:35:00Z", "9/30 14:00大丈夫ですか？"), S("2026-09-24T09:37:00Z", meet, true),
    C("2026-09-25T12:31:00Z", "すみません一旦引越し考え直すことになったので明日キャンセルでお願いします🙇‍♀️💦"),
    S("2026-09-26T01:20:00Z", "YUMAさん お世話になっております！！ かしこまりました！！ 内覧のキャンセル承りました！！"),
  ], aixRows: [AX("2026-09-24T09:36:00Z", "viewing_invite", { generated_text: meet })] }));
  expect(cancelled.upcomingViewing).toBe(null);
  expect(cancelled.conflicts.map((c) => c.code).join(",")).toContain("STATUS_VIEWING_STALE");
  expect(cancelled.headline).toContain("⚠ずれ");
});
it("予定表が lapsed のままでも内覧後のお礼があれば内覧済み（読む側で）・info の食い違いに残す", () => {
  const s = resolveCustomerState(base({
    messages: [S("2026-09-17T11:00:00Z", "YUMAさん 本日はお時間頂きありがとうございました😊！！ ご検討の程よろしくお願い致します！！")],
    viewingHistory: [{ scheduled_date: "2026-09-17", scheduled_time: "14:00:00", status: "lapsed", property_name: "メゾンベルキャステル 402号室", created_at: "2026-09-15T03:00:00Z" }],
  }));
  expect(s.stage).toBe("viewed");
  expect(s.properties[0].status).toBe("viewed");
  const c = s.conflicts.find((x) => x.code === "VIEWING_DONE_BUT_LAPSED");
  expect(c?.severity ?? "").toBe("info");
  expect(s.headline).notToContain("⚠ずれ");
});
it("status=viewing（審査管理の同期の残り）で、これからの内覧が無い → ⚠ずれ（STATUS_VIEWING_STALE）", () => {
  const s = resolveCustomerState(base({ status: "viewing", messages: [S("2026-09-12T07:56:00Z", "🌟グランヴァン新宿柏木 210号室\nYUMAさんにオススメ出来るお部屋となります！！", true), C("2026-09-12T09:51:00Z", "ありがとうございます 一旦検討してみます")],
    aixRows: [AX("2026-09-12T07:56:00Z", "property_recommendation", { generated_text: "🌟グランヴァン新宿柏木 210号室\nYUMAさんにオススメ出来るお部屋となります！！" })] }));
  expect(s.stage).toBe("proposing");
  expect(s.conflicts[0].code).toBe("STATUS_VIEWING_STALE");
  expect(s.conflicts[0].severity).toBe("warn");
});
it("申込の案内の物件はこちらの本文「〇〇号室お申込みさせていただきます」から（実物の形）", () => {
  expect(applicationPropertyFromText("かしこまりました！！ RIDGE江坂102号室お申込みさせていただきます😊！！")).toBe("RIDGE江坂 102号室");
  expect(applicationPropertyFromText("かしこまりました！！ S-RESIDENCE江坂Eminence601 お申込させて頂きます！！")).toBe("S-RESIDENCE江坂Eminence 601号室");
  expect(applicationPropertyFromText("かしこまりました！！ 保証会社審査承認後のオーナー審査まででしたらキャンセルも可能です！！ KANOACIA602号室お申込みさせていただきます😊！！")).toBe("KANOACIA 602号室");
  expect(applicationPropertyFromText("かしこまりました！！ J's Garden 201号室お申込みさせていただきます！！")).toBe("J's Garden 201号室");
});
it("物件名でない語（部屋だけ・2番手で・代理契約で・お部屋抑えた状態で）は読まない", () => {
  expect(applicationPropertyFromText("申し訳ございません。 こちらの1212号室をお申込させて頂く形となります！！")).toBe(null);
  expect(applicationPropertyFromText("かしこまりました！！ 2番手でお申込みさせていただきます！！")).toBe(null);
  expect(applicationPropertyFromText("代理契約でお申込み進めさせて頂きます！！")).toBe(null);
  expect(applicationPropertyFromText("お部屋抑えた状態でお申込みさせて頂きます")).toBe(null);
  expect(applicationPropertyFromText("明日のお部屋確定後すぐにお申込みさせて頂きます！！")).toBe(null);
  expect(applicationPropertyFromText("お気に召されましたら先にお申込みしお部屋を抑えさせて頂きます😊！！")).toBe(null);
});
it("申込の案内（フォーマットだけ）→ 前後の本文の物件に結ぶ・状態が申込前なら申込準備（部屋は見積済のまま）", () => {
  const s = resolveCustomerState(base({
    messages: [S("2026-09-20T03:00:00Z", ESTIMATE_1, true), C("2026-09-21T03:00:00Z", "ここで申込みたいです！"),
      S("2026-09-21T03:04:00Z", "かしこまりました！！ ジュネスニッコー1003号室お申込みさせていただきます😊！！"), S("2026-09-21T03:05:00Z", "YUMA様記入欄】\n・入居希望日\n・氏名、フリガナ", true)],
    aixRows: [AX("2026-09-20T03:00:00Z", "estimate_sheet", { generated_text: ESTIMATE_1 }), AX("2026-09-21T03:05:00Z", "application_push", { generated_text: "YUMA様記入欄】\n・入居希望日\n・氏名、フリガナ" })],
  }));
  expect(s.stage).toBe("apply_prep");
  const focus = s.properties.find((p) => p.key === s.focusKey);
  expect(focus?.name ?? "").toBe("ジュネスニッコー 1003号室");
  expect(focus?.status ?? "").toBe("estimate_sent");
  expect(focus?.events.some((e) => e.kind === "application") ?? false).toBe(true);
});
it("本文に物件名が無い申込の案内は、直前の見積から推定して結ばない（APPLY_NO_ROOM の info）", () => {
  const s = resolveCustomerState(base({
    messages: [S("2026-09-20T03:00:00Z", ESTIMATE_1, true), S("2026-09-21T03:05:00Z", "YUMA様記入欄】", true)],
    aixRows: [AX("2026-09-20T03:00:00Z", "estimate_sheet", { generated_text: ESTIMATE_1 }), AX("2026-09-21T03:05:00Z", "application_push", { generated_text: "YUMA様記入欄】" })],
  }));
  expect(s.stage).toBe("apply_prep");
  expect(s.properties.some((p) => p.events.some((e) => e.kind === "application"))).toBe(false);
  expect(s.conflicts.map((c) => c.code).join(",")).toContain("APPLY_NO_ROOM");
});
it("状態が申込中なら最後に申込んだ部屋だけ申込中（前に申込んだ別の部屋は申込中にしない・7beca4f5 型）", () => {
  const E2 = "【メルクリオール難波 303号室】\n初期費用：150,000円";
  const s = resolveCustomerState(base({
    status: "applying",
    messages: [S("2026-09-01T03:00:00Z", E2, true), S("2026-09-01T03:01:00Z", "かしこまりました！！ メルクリオール難波303号室お申込みさせていただきます！！"), S("2026-09-01T03:02:00Z", "YUMA様記入欄】", true),
      S("2026-09-20T03:00:00Z", ESTIMATE_1, true), S("2026-09-21T03:04:00Z", "かしこまりました！！ ジュネスニッコー1003号室お申込みさせていただきます！！"), S("2026-09-21T03:05:00Z", "YUMA様記入欄】", true)],
    aixRows: [
      AX("2026-09-01T03:00:00Z", "estimate_sheet", { generated_text: E2 }), AX("2026-09-01T03:02:00Z", "application_push", { generated_text: "YUMA様記入欄】" }),
      AX("2026-09-20T03:00:00Z", "estimate_sheet", { generated_text: ESTIMATE_1 }), AX("2026-09-21T03:05:00Z", "application_push", { generated_text: "YUMA様記入欄】" }),
    ],
  }));
  expect(s.stage).toBe("applying");
  const applying = s.properties.filter((p) => p.status === "applying").map((p) => p.name);
  expect(applying).toEqual(["ジュネスニッコー 1003号室"]);
});
it("見積の後に別の物件を送った → 段階は提案中・見積の部屋は残り「探し中」の印", () => {
  const rec = "🌟セレニテ難波ミラク参番館 506号室\nYUMAさんにオススメ出来るお部屋となります！！";
  const s = resolveCustomerState(base({
    messages: [S("2026-09-20T03:00:00Z", ESTIMATE_1, true), C("2026-09-21T03:00:00Z", "ほかにもないですか？"), S("2026-09-22T03:00:00Z", rec, true)],
    aixRows: [AX("2026-09-20T03:00:00Z", "estimate_sheet", { generated_text: ESTIMATE_1 }), AX("2026-09-22T03:00:00Z", "property_recommendation", { generated_text: rec })],
  }));
  expect(s.stage).toBe("proposing");
  expect(s.searching.active).toBe(true);
  expect(s.searching.reason ?? "").toBe("sent_after_focus");
  expect(s.headline).toContain("ジュネスニッコー 1003号室");
  expect(s.headline).toContain("探し中");
});
it("お客様の SUUMO の共有は候補（気に入った物件あり）・ギフトの URL は物件にしない", () => {
  const s = resolveCustomerState(base({ messages: [
    S("2026-09-20T03:00:00Z", "YUMAさん お世話になっております！！"),
    C("2026-09-21T03:00:00Z", "プルス新北野 3階\nhttps://suumo.jp/chintai/jnc_000000000/\nby SUUMO"),
  ] }));
  expect(s.stage).toBe("interested");
  expect(s.properties[0].name).toBe("プルス新北野");
  const g = resolveCustomerState(base({ messages: [
    S("2026-09-20T03:00:00Z", "YUMAさん お世話になっております！！"),
    C("2026-09-21T03:00:00Z", "選べる無料ギフトがたくさん!お見逃しなく!🎁\nhttps://example-gift.jp/campaign"),
  ] }));
  expect(g.properties.length).toBe(0);
});
it("お客様が他で決めたと言った → 見送り・他社決定＋状態が失注でなければ ⚠ずれ", () => {
  const s = resolveCustomerState(base({ status: "viewing", messages: [
    S("2026-09-20T03:00:00Z", "YUMAさん お世話になっております！！"),
    C("2026-09-25T03:00:00Z", "お世話になっております。 他の不動産屋で審査通しており返信していなかったのですが、そちらで物件決まりました。 ご協力いただいたのにすみませんありがとうございました。"),
  ] }));
  expect(s.stage).toBe("dropped");
  expect(s.conflicts.map((c) => c.code).join(",")).toContain("DECIDED_ELSEWHERE_OPEN");
});
it("新しい物件の内覧希望（前の物件の話の後）→ 内覧調整中（9b9b81ba 型）", () => {
  const s = resolveCustomerState(base({ messages: [
    S("2026-09-24T03:00:00Z", "🌟Designers KomiNka TAKADONO\nお気に召されましたらお申込しお部屋抑えさせて頂きます！！", true),
    C("2026-09-25T03:00:00Z", "日曜内覧可能でしょうか？"),
  ], aixRows: [AX("2026-09-24T03:00:00Z", "property_recommendation", { generated_text: "🌟Designers KomiNka TAKADONO\nお気に召されましたらお申込しお部屋抑えさせて頂きます！！" })] }));
  expect(s.stage).toBe("viewing_arranging");
});
it("画像の読み取り文の「内見予約」はお客様の内覧希望にしない", () => {
  const s = resolveCustomerState(base({ messages: [
    S("2026-09-24T03:00:00Z", "YUMAさん お世話になっております！！"),
    C("2026-09-25T03:00:00Z", "[画像] 物件情報 IBCレジデンスウエスト 7階 間取り：2LDK 内見予約はこちら"),
  ] }));
  if (s.stage === "viewing_arranging") throw new Error("画像の文で内覧調整中にした");
});
it("成約・失注は状態が正", () => {
  expect(resolveCustomerState(base({ status: "closed_won", messages: [S("2026-09-24T03:00:00Z", "ありがとうございます！！")] })).stage).toBe("won");
  expect(resolveCustomerState(base({ status: "closed_lost", messages: [S("2026-09-24T03:00:00Z", "ありがとうございます！！")] })).stage).toBe("dropped");
});
it("日付の表示（9/28(月)12:00）", () => {
  expect(viewingLabel("2026-09-28", "12:00")).toBe("9/28(月)12:00");
});

console.log("\n■ 画面用の軽い形（compactCustomerStateForView・段2）");
it("送っただけの候補は件数だけ・進んだお部屋と主のお部屋は一覧に残す・出来事は直近だけ", () => {
  const sent = Array.from({ length: 8 }, (_, i) => ({ property_name: `テスト候補${i + 1}`, room_no: `${101 + i}`, sent_at: `2026-09-1${i}T03:00:00Z` }));
  const s = resolveCustomerState(base({
    sentProperties: sent,
    messages: [S("2026-09-19T03:00:00Z", "YUMAさん お世話になっております！！"), S("2026-09-20T03:00:00Z", ESTIMATE_1, true)],
    aixRows: [AX("2026-09-20T03:00:00Z", "estimate_sheet", { generated_text: ESTIMATE_1, estimate_sent: true })],
  }));
  const v = compactCustomerStateForView(s, { maxEvents: 2 });
  expect(v.propertiesTotal).toBe(s.properties.length);
  expect(v.properties.length + v.candidateCount).toBe(s.properties.length);
  if (v.properties.some((p) => p.status === "candidate" && !p.estimateSent && !p.customerInterest && p.key !== s.focusKey)) throw new Error("送っただけの候補が一覧に残った");
  if (s.focusKey && v.properties[0]?.key !== s.focusKey) throw new Error("主のお部屋が先頭でない");
  if (v.properties.some((p) => p.events.length > 2)) throw new Error("出来事を絞っていない");
  expect(v.headline).toBe(s.headline);
  expect(JSON.stringify(v)).notToContain("brainSituation");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log("  - " + f); process.exit(1); }
