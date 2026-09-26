// 2026-09-26 竹内「ここの部分改善する根本的に」: 済んだ事・もう言った約束・決まった内覧（app/lib/done-state.ts）と
//   行動台帳の報告の語彙（action-ledger findConfirmReportSentence / classifyStaffTextFacts）・出口の待ち合わせの復唱の免除（validate-reply）
// 本文は実物（直近60〜180日の実送信・下書き）。お客様の名前は YUMA に置き換えた
// 実行: npx tsx app/lib/__tests__/done-state.test.ts（自己完結ハーネス。全 PASS で exit 0）
import {
  latestStaffBlock, findWaitFormPromises, withoutWaitFormPromises, isWholeShortAck, resolveViewingScheduled,
  buildViewingScheduledNote, buildFollowUpDoneNote, customerAnsweredByAix, viewingHoursOf, viewingAckLine, slotStartLabel,
  VIEWING_SCHEDULED_HEADING,
} from "../done-state";
import { buildActionLedger, classifyStaffTextFacts, findConfirmReportSentence, buildLedgerLinesForBrain, reportDetailOf, buildLedgerNote, reportObjectOf, REPORT_OBJECT_UNKNOWN } from "../action-ledger";
import { planPromiseCompletion } from "../promise-calendar";
import { resolveViewingThread } from "../viewing-thread";
import { enforceAixGates } from "../validate-reply";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(sub: string) { if (!String(actual).includes(sub)) throw new Error(`expected to contain ${JSON.stringify(sub)} but got ${JSON.stringify(actual)}`); },
    notToContain(sub: string) { if (String(actual).includes(sub)) throw new Error(`expected NOT to contain ${JSON.stringify(sub)} but got ${JSON.stringify(actual)}`); },
  };
}
const kinds = (t: string) => classifyStaffTextFacts(t, "2026-09-20T03:00:00Z").map((e) => e.kind).join("+");
const H = 3600_000;
const MSG_SEP_T = "\n⁣\n";

console.log("\n① 直前のこちらを6時間で区切る（latestStaffBlock）");
it("YUMA: 数日前の駐車場の約束は、今日の AIX の後の「直前」に入れない", () => {
  const t0 = Date.parse("2026-09-24T03:00:00Z");
  const b = latestStaffBlock([
    { sender: "customer", text: "駐車場ありますか？", t: t0 - 60_000 },
    { sender: "staff", text: "駐車場の空き状況も含めて確認させて頂きます！！", t: t0 },
    { sender: "staff", text: "(AI提案)「YUMAさんお世話になっております！！ご条件に合ったお部屋ピックアップさせて頂きました😊！！」", t: t0 + 50 * H },
    { sender: "customer", text: "ありがとうございます", t: t0 + 51 * H },
  ]);
  expect(b.dropped).toBe(1);
  expect(b.text ?? "").notToContain("駐車場");
  expect(b.text ?? "").toContain("ピックアップさせて頂きました");
});
it("6時間以内の連投は全部残す・時刻の無い行は外さない", () => {
  const t0 = Date.parse("2026-09-24T03:00:00Z");
  const b = latestStaffBlock([
    { sender: "staff", text: "A", t: t0 }, { sender: "staff", text: "B", t: null }, { sender: "staff", text: "C", t: t0 + 5 * H },
    { sender: "customer", text: "はい", t: t0 + 6 * H },
  ]);
  expect(b.text).toBe("A\nB\nC"); expect(b.dropped).toBe(0);
});
it("連投の途中（最後がこちら）は末尾の塊を見る・こちらの発言が無ければ undefined", () => {
  expect(latestStaffBlock([{ sender: "customer", text: "x", t: 1 }, { sender: "staff", text: "Y", t: 2 }]).text).toBe("Y");
  expect(latestStaffBlock([{ sender: "customer", text: "x", t: 1 }]).text).toBe(undefined);
});

console.log("\n② 待ちの形の約束（findWaitFormPromises）— 実物");
it("「審査の進捗あり次第ご連絡させていただきます」＝連絡（8d8c04b0 型）", () => {
  expect(findWaitFormPromises("〇〇さん\nお世話になっております！！\n\n管理会社よりお申込み無事1番手にて受理とのご連絡がございました😊！！\n\n審査の進捗あり次第ご連絡させていただきます！！\n\n引き続きよろしくお願いいたします！！").map((w) => w.kind).join(",")).toBe("連絡");
});
it("「確認でき次第すぐにご連絡させていただきます」＝確認（e544ffff 型）", () => {
  expect(findWaitFormPromises("YUMAさんお世話になっております！！\n\n8月7日のご内覧につきまして、管理会社に特別対応が可能か本日中に確認させていただきます！！\n確認でき次第すぐにご連絡させていただきます😊！！").map((w) => w.kind).join(",")).toBe("確認");
});
it("「火曜日確認させて頂き確認出来次第ご連絡」＝確認（4f9d58e8 型）・「9月30日に…ご連絡させて頂きます」＝連絡（日付・f71dfdea 型）", () => {
  expect(findWaitFormPromises("管理会社火曜日までお休みとなりますので、無事1番手でお申込出来ているか火曜日確認させて頂き確認出来次第ご連絡させて頂きます！！")[0]?.kind).toBe("確認");
  expect(findWaitFormPromises("はい😊！！\n9月30日に一度9月30日時点での募集状況をご連絡させて頂きます！！")[0]?.kind).toBe("連絡");
});
it("「見積書を作成出来次第お送りします」＝見積", () => {
  expect(findWaitFormPromises("かしこまりました！！\n御見積書作成出来次第お送りさせて頂きます！！")[0]?.kind).toBe("見積");
});
it("線の外: 初回の挨拶文・ピックアップ・新着で出次第・宣言だけ（次第なし）・お客様が先の条件付き・お客様への「ご連絡ください」", () => {
  expect(findWaitFormPromises("YUMAさん、はじめまして😊！！\nお部屋探しを担当させて頂きます鈴木と申します！！\n募集状況確認出来次第ご連絡させて頂きます！！").length).toBe(0);
  expect(findWaitFormPromises("オススメできるお部屋ピックアップ出来次第お送りさせて頂きます！！").length).toBe(0);
  expect(findWaitFormPromises("引き続き新着でオススメできるお部屋で次第お送りさせていただきます！！").length).toBe(0);
  expect(findWaitFormPromises("Nicher'a 加美の募集状況確認させていただきます！！").length).toBe(0);
  expect(findWaitFormPromises("気になりましたお部屋の募集状況お送り頂き次第確認させて頂きますので、いつでもお気軽にお送りください😊！！").length).toBe(0);
  expect(findWaitFormPromises("気になる点出てきましたらいつでもお気軽にご連絡ください！！").length).toBe(0);
  expect(findWaitFormPromises("撮影出来次第お送りさせて頂きます！！").length).toBe(0);
});
it("ピックアップと確認が1通にある時は、確認の文だけ外す（ピックアップの復唱はスタッフの多数の形）", () => {
  const r = withoutWaitFormPromises("かしこまりました！！\n管理会社に確認出来次第ご連絡させて頂きます！！\nYUMAさんにオススメできるお部屋ピックアップ出来次第お送りさせて頂きます！！");
  expect(r.removed.length).toBe(1);
  expect(r.text).toContain("ピックアップ出来次第");
  expect(r.text).notToContain("確認出来次第");
});
it("待ちの形の約束だけの直前は、残りに確認の語が無い（gratitudeActionHint の確認の枝に入らない）", () => {
  const r = withoutWaitFormPromises("無事一番手にてお申込み完了しております！！\n審査の進捗あり次第ご連絡させていただきます😊！！");
  expect(/管理会社|確認(?:して|させて|いたし)/.test(r.text)).toBe(false);
});

console.log("\n③ 決まった内覧（resolveViewingScheduled・isWholeShortAck）");
it("発言全体が短い了承: 「はい！大丈夫です！」「わかりました！\\n大丈夫です🙆」「よろしくお願いします。」", () => {
  expect(isWholeShortAck("はい！大丈夫です！")).toBe(true);
  expect(isWholeShortAck("わかりました！\n大丈夫です🙆")).toBe(true);
  expect(isWholeShortAck("よろしくお願いします。")).toBe(true);
  expect(isWholeShortAck("わかりました！" + MSG_SEP_T + "よろしくお願いします")).toBe(true); // 複数通（MSG_SEP）
});
it("短い了承ではない: 時刻の希望・日程変更・質問・長い苦情", () => {
  expect(isWholeShortAck("13時頃がありがたいです")).toBe(false);
  expect(isWholeShortAck("別日でお願いします")).toBe(false);
  expect(isWholeShortAck("18時半可能ですか？")).toBe(false);
  expect(isWholeShortAck("はい、でも昨日の件ですがまだ連絡をいただけていないので正直かなり不安に思っています。どうなっていますか")).toBe(false);
});
it("日時を1つ出して都合を聞いた打診への「はい！大丈夫です！」は受諾（d3a56a97 型）・日時は始まりだけ", () => {
  const msgs = [
    { sender: "staff", text: "9/7(月)16:00よりオンライン内見、YUMAさんご都合如何でしょうか😌!", rawCreatedAt: "2026-09-06T05:00:00Z" },
    { sender: "customer", text: "はい！大丈夫です！", rawCreatedAt: "2026-09-06T05:10:00Z" },
  ];
  const th = resolveViewingThread(msgs, { nowMs: Date.parse("2026-09-06T05:11:00Z") });
  const v = resolveViewingScheduled({ appointment: null, viewingDone: null, thread: th, customerText: "はい！大丈夫です！" });
  expect(v.scheduled).toBe(true); expect(v.source).toBe("customer_accepted");
  expect(v.label ?? "").toContain("16:00");
  expect(v.label ?? "").notToContain("18:00");
});
it("お礼だけ（「ありがとうございます」）は受諾にしない（提案中のまま）", () => {
  const th = resolveViewingThread([{ sender: "staff", text: "9/7(月)16:00よりオンライン内見、ご都合如何でしょうか😌!", rawCreatedAt: "2026-09-06T05:00:00Z" }, { sender: "customer", text: "ありがとうございます🙏🏻", rawCreatedAt: "2026-09-06T05:10:00Z" }], { nowMs: Date.parse("2026-09-06T05:11:00Z") });
  expect(resolveViewingScheduled({ appointment: null, viewingDone: null, thread: th, customerText: "ありがとうございます🙏🏻" }).scheduled).toBe(false);
});
it("待ち合わせ案内済み（台帳）は決まっている・内覧後のお礼を送った後は決まっていない", () => {
  const appt = { dateMD: "9/27", time: "13:00", place: null, day: "tomorrow" as const, sentAt: "2026-09-26T03:00:00Z" };
  expect(resolveViewingScheduled({ appointment: appt, viewingDone: null, thread: null }).source).toBe("meeting_place");
  expect(resolveViewingScheduled({ appointment: null, viewingDone: { appointment: appt, thankedAt: "x" }, thread: null }).scheduled).toBe(false);
  expect(viewingAckLine(appt)).toBe("明日何卒よろしくお願い致します！！");
  expect(viewingAckLine(null)).toBe("何卒よろしくお願い致します！！");
});
it("注記は見出しを持ち、未定に戻す2つの定型を名指しで止める（決まっていなければ空）", () => {
  const n = buildViewingScheduledNote({ scheduled: true, source: "meeting_place", label: "9/27 13:00（明日） 現地待ち合わせ" });
  expect(n).toContain(VIEWING_SCHEDULED_HEADING); expect(n).toContain("ご都合よろしいお日にちに"); expect(n).toContain("決まっている日時をそのまま");
  expect(buildViewingScheduledNote({ scheduled: false, source: null, label: null })).toBe("");
});
it("時刻の取り出し・枠の始まり", () => {
  expect(viewingHoursOf("9/27 13:00（明日） 現地待ち合わせ 9/7(月)16:00より").join(",")).toBe("13,16");
  expect(slotStartLabel("9/7(月) 16:00〜18:00")).toBe("9/7(月) 16:00〜");
});

console.log("\n④ 連投の途中の済んだ事（buildFollowUpDoneNote・customerAnsweredByAix）");
it("AIX 物件確認した（2件: 募集中・募集終了）の後の連投には「確認結果を報告済み（募集中1件・募集終了1件）」を渡す（物件名は書かない）", () => {
  const l = buildActionLedger({
    recentAixRows: [{ aix_type: "property_check_result", check_pattern: "available", created_at: "2026-09-20T03:00:00Z", sent_at: "2026-09-20T03:00:00Z", property_names: ["エスライズ難波 802号室", "都島ハイツ 201号室"], prop_statuses: ["available", "unavailable"] }],
    messages: [{ sender: "customer", text: "この2件空いてますか", createdAt: "2026-09-20T02:50:00Z" }, { sender: "staff", text: "YUMAさんお待たせ致しました！！", createdAt: "2026-09-20T03:00:00Z", isAix: true }],
    now: Date.parse("2026-09-20T03:03:00Z"),
  });
  const n = buildFollowUpDoneNote(l);
  expect(n).toContain("確認結果を報告済み（募集中1件・募集終了1件）");
  expect(n).notToContain("エスライズ");
  expect(buildLedgerLinesForBrain(l)).toContain("エスライズ難波 802号室=募集中");
  expect(buildLedgerNote(l)).toContain("募集中1件・募集終了1件");
  expect(reportDetailOf(l.entries.find((e) => e.kind === "confirmation_reported") ?? null) ?? "").toBe("募集中1件・募集終了1件");
});
it("お客様の最後の発言の後に AIX を送った連投だけ「もう AIX で答えた」", () => {
  const rows = [{ created_at: "2026-09-20T03:00:00Z", sent_at: "2026-09-20T03:00:30Z" }];
  expect(customerAnsweredByAix(true, "2026-09-20T02:50:00Z", rows)).toBe(true);
  expect(customerAnsweredByAix(false, "2026-09-20T02:50:00Z", rows)).toBe(false);
  expect(customerAnsweredByAix(true, "2026-09-20T03:10:00Z", rows)).toBe(false);
});

console.log("\n⑤ 台帳の報告の語彙（手打ちの確認結果）— 実物");
it("「お送りいただきました〇〇は現在募集に出ていないお部屋となります」は報告", () => {
  expect(kinds("お送りいただきましたクリアオーレ平野本町は現在募集に出ていないお部屋となります！！")).toBe("confirmation_reported");
});
it("「確認させていただきましたが、こちら専任のお部屋…／引き続き新着で…出次第お送り」は報告＋ピックアップの宣言", () => {
  expect(kinds("YUMAさん\nお世話になっております！！\n\nフローレンス本所の管理会社に確認させていただきましたが、こちら専任のお部屋となりご紹介出来ないお部屋となります。\n\n引き続き新着でオススメできるお部屋で次第お送りさせていただきます！！")).toBe("confirmation_reported+pickup_declared");
});
it("「確認させて頂きましたところ募集終了…／ご条件に合ったお部屋を新着物件併せて確認させて頂きます」は報告＋探し続ける宣言", () => {
  const f = classifyStaffTextFacts("レバンガ国分公園ＡＰ確認させて頂きましたところ、現在募集終了となっておりました😌\n\nYUMAさんのご希望のご条件に合ったお部屋を新着物件併せて確認させて頂きます！！", null);
  expect(f.map((e) => e.kind).join("+")).toBe("confirmation_reported+pickup_declared");
  expect(f[1]?.detail.watch ?? false).toBe(true);
});
it("報告と同じ通の別の文の約束（「月曜日に再度確認させていただきます」）は約束として残り、未履行", () => {
  const t = "確認させていただきましたが、こちら保証会社審査中とのご返事でした。\n\n管理会社翌営業日月曜日となりますので、月曜日に再度確認させていただきます！！";
  expect(kinds(t)).toBe("confirmation_reported+confirmation_promised");
  const l = buildActionLedger({ messages: [{ sender: "staff", text: t, createdAt: "2026-09-20T03:00:00Z" }], now: Date.parse("2026-09-20T04:00:00Z") });
  expect(l.facts.confirmationPromisedUnfulfilled).toBe(true);
});
it("物件送付・見積書が主な行為でも、同じ通の報告は別に記録（送付件数は減らさない）", () => {
  expect(kinds("YUMAさん\n吹田市、大阪市全域からお引越し費用10万円以内でご入居可能なお部屋探させていただき1件募集中でしたのでお送りさせていただきました😊！！")).toBe("properties_sent+confirmation_reported");
  expect(kinds("お待たせ致しました！！\nALEX23 301号室現在募集中となります！！\n最大限割引しました御見積書同封させて頂きました！！")).toBe("estimate_sent+confirmation_reported");
});
it("報告にしない: 推量・条件付き（「募集に出ていない可能性も…お送り頂けますと確認」）・一般の説明（「審査否決の場合」「掲載終了している場合」）", () => {
  expect(findConfirmReportSentence("SOOM掲載のお部屋は募集に出ていない可能性もございます！！\n\n気になるお部屋ございしましたら、お送り頂けますとお部屋の募集状況確認させていただきます😊！！")).toBe(null);
  expect(findConfirmReportSentence("1番手お申込み中の方がキャンセルもしくは審査否決の場合に2番手お申込み者の方が1番手に繰り上がり審査開始となります！！")).toBe(null);
  expect(findConfirmReportSentence("SUUMOですと掲載のルールが厳しく、実際募集されている物件が掲載されております（2週間毎の更新となりますので掲載終了している場合御座います）")).toBe(null);
});
it("約束を報告にしない: 「確認させていただき、…決まりましたら改めてご連絡させていただきます」「確認させて頂き、…御見積書とあわせてご連絡」", () => {
  expect(kinds("6月19日のご内覧と振込期日のご希望につきましては、私の方で管理会社に確認させていただき、詳しいお時間などが決まりましたら改めてご連絡させていただきます。")).toBe("confirmation_promised");
  expect(kinds("お送り頂きました物件の募集状況確認させて頂き、最大限割引しました初期費用の御見積書とあわせてご連絡させて頂きます！！").includes("confirmation_reported")).toBe(false);
});
it("相手の言葉の引用（「〜確認させていただきます。とのことですので」）はこちらの約束にしない", () => {
  expect(kinds("お送りいただきありがとうございます！！\n\nご提出後に保証会社に一度審査可能か確認させていただきます。とのことですので、\n・保険証\nお送りの程よろしくお願いいたします！！")).toBe("confirmation_reported");
});
it("約束の形の「審査結果出次第ご連絡」「お申込みが入りますと」は報告にしない", () => {
  expect(findConfirmReportSentence("審査結果出次第ご連絡させて頂きます！！")).toBe(null);
  expect(findConfirmReportSentence("人気のお部屋ですので他の方のお申込みが入りますと埋まってしまいます！！")).toBe(null);
});

console.log("\n⑥ 出口: 決まった内覧の日時の復唱は「待ち合わせ確定」の置換にしない（validate-reply）");
it("決まった13時の復唱は残す／違う時刻・住所入りは従来どおり置き換える", () => {
  const s = "はい！！\n明日13時現地エントランスにてお待ち合わせで何卒よろしくお願い致します！！";
  expect(enforceAixGates(s, { scheduledViewingHours: [13] }).cleaned).toContain("明日13時現地エントランス");
  expect(enforceAixGates(s, { scheduledViewingHours: [14] }).cleaned).notToContain("明日13時現地エントランス");
  expect(enforceAixGates(s, {}).cleaned).notToContain("明日13時現地エントランス");
  expect(enforceAixGates("明日13時に大阪市東成区深江南1丁目の現地エントランスにてお待ち合わせです！！", { scheduledViewingHours: [13] }).cleaned).notToContain("1丁目");
});

console.log("\n⑦ 反証レビュー（2026-09-26）: 決まった内覧の誤判定・報告の要件（約束カレンダー）・予約送信");
it("候補の日時が無い「打診」（費用の説明の「最安値のお日にち」）への「わかりました／お願いします」は決まった内覧にしない（77b29095 型）", () => {
  const msgs = [
    { sender: "staff", text: "はい!!\nお引越し初期費用¥153,200円となります😊!!\n毎月1日が初期費用最安値のお日にちとなります!!\nご都合よろしいお日にちにお部屋ご案内させて頂きます!!", rawCreatedAt: "2026-09-06T05:00:00Z" },
    { sender: "customer", text: "わかりました\nお願いします", rawCreatedAt: "2026-09-06T05:10:00Z" },
  ];
  const th = resolveViewingThread(msgs, { nowMs: Date.parse("2026-09-06T05:11:00Z") });
  expect(th.kind).toBe("scheduled");
  expect(resolveViewingScheduled({ appointment: null, viewingDone: null, thread: th, customerText: "わかりました\nお願いします" }).scheduled).toBe(false);
});
it("候補を出した打診への逆提案（「平日ですと18:30以降しか間に合わず」）は決まった内覧にしない（2ae0d94e 型）／「？」付きの受諾は決まっている（3d9b67d7 型）", () => {
  const proposal = { sender: "staff", text: "直近ですと\n9/17(木)13:00〜17:00\n9/18(金)14:00〜17:00にてご案内可能です😊!!\nYUMAさんご都合よろしいお日にち御座いますでしょうか", rawCreatedAt: "2026-09-15T05:00:00Z" };
  const counter = "内見可能な日程ありがとうございます！！\n大変申し訳ございませんが、平日ですと仕事の都合で18:30以降しか間に合わず、18:30以降でしたら可能です";
  const th1 = resolveViewingThread([proposal, { sender: "customer", text: counter, rawCreatedAt: "2026-09-15T05:10:00Z" }], { nowMs: Date.parse("2026-09-15T05:11:00Z") });
  expect(resolveViewingScheduled({ appointment: null, viewingDone: null, thread: th1, customerText: counter }).scheduled).toBe(false);
  const ok = "内見当日は現地集合になりますか？\n9/17の15時からお願いします！";
  const th2 = resolveViewingThread([proposal, { sender: "customer", text: ok, rawCreatedAt: "2026-09-15T05:10:00Z" }], { nowMs: Date.parse("2026-09-15T05:11:00Z") });
  expect(resolveViewingScheduled({ appointment: null, viewingDone: null, thread: th2, customerText: ok }).scheduled).toBe(true);
});
it("当日の待ち合わせで始まりから60分を過ぎた了承は「決まっている」にしない（内覧後。実送信は「本日お時間頂きありがとうございました」）", () => {
  const appt = { dateMD: "9/9", time: "10:30", place: null, day: "today" as const, sentAt: "2026-09-08T03:00:00Z" };
  // JST 11:50（= UTC 02:50）
  expect(resolveViewingScheduled({ appointment: appt, viewingDone: null, thread: null, nowMs: Date.parse("2026-09-09T02:50:00Z") }).scheduled).toBe(false);
  // JST 09:40 は内覧前
  expect(resolveViewingScheduled({ appointment: appt, viewingDone: null, thread: null, nowMs: Date.parse("2026-09-09T00:40:00Z") }).scheduled).toBe(true);
  // 明日の待ち合わせは時刻に関係なく決まっている
  expect(resolveViewingScheduled({ appointment: { ...appt, day: "tomorrow" }, viewingDone: null, thread: null, nowMs: Date.parse("2026-09-09T12:00:00Z") }).scheduled).toBe(true);
});
it("予約送信の AIX（sent_at が未来）では「もう AIX で答えた」にしない", () => {
  const rows = [{ created_at: "2026-09-20T03:00:00Z", sent_at: "2026-09-20T09:00:00Z" }];
  expect(customerAnsweredByAix(true, "2026-09-20T02:50:00Z", rows, Date.parse("2026-09-20T03:05:00Z"))).toBe(false);
  expect(customerAnsweredByAix(true, "2026-09-20T02:50:00Z", rows, Date.parse("2026-09-20T09:05:00Z"))).toBe(true);
});
it("「探させていただきましたが〇〇が1番オススメ」は確認結果の報告ではない（bfd172e6 型）", () => {
  expect(findConfirmReportSentence("新着でオススメできるお部屋探させていただきましたが、マツダ21天美が1番オススメできるお部屋となります！！")).toBe(null);
});
it("新しい語彙の報告は要件を持ち、要件の違う【必ず】を閉じない（ca571e21・d3f7f5f3 型）／旧の語彙の報告は旧と同じ要件", () => {
  const open = [
    { id: 1, event_type: "follow_up", notes: "【必ず】初期費用の確認→ご連絡", is_done: false },
    { id: 2, event_type: "follow_up", notes: "【必ず】募集状況の確認→ご連絡", is_done: false },
    { id: 3, event_type: "follow_up", notes: "【必ず】確認事項の確認→ご連絡", is_done: false },
  ];
  const doneOf = (t: string) => classifyStaffTextFacts(t, "2026-09-20T03:00:00Z").filter((e) => e.status === "done").map((e) => ({ kind: e.kind, object: e.detail.object ?? null, checkPattern: e.detail.checkPattern ?? null }));
  const closed1 = planPromiseCompletion(doneOf("YUMAさん\nお世話になっております！！\n\nはい！！まだお申込み入っておらずお部屋募集中となります😊！！"), open);
  expect(closed1.includes(1)).toBe(false); expect(closed1.includes(2)).toBe(true); expect(closed1.includes(3)).toBe(true);
  const closed2 = planPromiseCompletion(doneOf("かしこまりました！！\nご状況説明いただきありがとうございます！！\n\nグラン心斎橋EAST904号室も募集中となりお申込みも可能です！！"), open);
  expect(closed2.includes(1)).toBe(false);
  // 旧の語彙（とのご連絡がございました）で通全体の要件＝番手 → 旧と同じ
  expect(reportObjectOf("管理会社より1番手お申込みの方が審査通過し契約も確実とのご連絡がございました。", "YUMAさん\n管理会社より1番手お申込みの方が審査通過し契約も確実とのご連絡がございました。", true) ?? "").toBe("番手");
  // 要件の読めない新しい語彙の報告は「確認結果」（相手・不明の約束だけに当たる）
  expect(reportObjectOf("確認させて頂きましたところ、10月中旬まで工事中となり工事中はご内覧出来ないとの事です！！", "確認させて頂きましたところ、10月中旬まで工事中となり工事中はご内覧出来ないとの事です！！", true) ?? "").toBe(REPORT_OBJECT_UNKNOWN);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
