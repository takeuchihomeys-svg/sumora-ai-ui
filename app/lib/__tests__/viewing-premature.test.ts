// 2026-09-30 竹内さん（みことさん事例）「内覧確定していないのに内覧のこと自動返信で入れてしまっている」
//   app/lib/viewing-premature.ts と action-ledger の viewing_presumed（実行前提語ゲート）
// 本文は実物（本番の自動返信・スタッフの実送信）。お客様の名前は YUMA に置き換えた
// 実行: npx tsx app/lib/__tests__/viewing-premature.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { findPrematureViewing, findStaffViewingDeclaration, stripPrematureViewing, customerMentionsFixedViewing, annotateUnconfirmedViewing, isViewingFixTopic, UNCONFIRMED_VIEWING_SUFFIX } from "../viewing-premature";
import { buildActionLedger, checkDonePresupposition, applyLedgerAutoFix, buildActionLedgerNote, type LedgerMessage, type LedgerAixRow } from "../action-ledger";

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

// 実物（8a77820b・2026-09-30 の自動返信2通）
const AUTO1 = "はい！！\nお仕事面こちらでサポートさせて頂きます😊！！\nご内覧時に内覧担当から詳しく打ち合わせさせていただきますのでご安心ください😌！！";
const AUTO2 = "はい😊！！\n\n初期費用の分割払いは難しいですが、お支払いのタイミングや初期費用を抑える方法について、内覧時に内覧担当より詳しくご案内させて頂きます😌！！";
// 竹内さんのスクリーンショットの下書き（言い回し）
const SHOT = "はい！！\nお仕事面こちらでサポートさせて頂きますので、お電話等かかってきませんのでご安心くださいませ😊！！\n10/2日のご内覧もよろしくお願い致します😌！！";

console.log("\n① 見つける（findPrematureViewing）");
it("実物1: 「ご内覧時に内覧担当から」", () => {
  const h = findPrematureViewing(AUTO1);
  expect(h.length).toBe(1);
  expect(h[0].kind).toBe("at_viewing");
  expect(h[0].fixed).toBe("詳しく打ち合わせさせていただきますのでご安心ください😌！！");
});
it("実物2: 「内覧時に内覧担当より」は語だけ外して答え（分割払いは難しい）を残す", () => {
  const h = findPrematureViewing(AUTO2);
  expect(h.length).toBe(1);
  expect(h[0].fixed).toContain("初期費用の分割払いは難しいですが");
  expect(h[0].fixed).notToContain("内覧");
});
it("スクショ: 「10/2日のご内覧もよろしく」は文ごと外す", () => {
  const h = findPrematureViewing(SHOT);
  expect(h.length).toBe(1);
  expect(h[0].kind).toBe("viewing_greeting");
  expect(h[0].fixed).toBe("");
});
it("「当日お会いできますのを楽しみにしております」", () => {
  expect(findPrematureViewing("慶次さんお世話になっております！\n当日お会いできますのを楽しみにしております😌！")[0]?.kind).toBe("looking_forward");
});
it("過去の話は当てない（内覧時にお伝えした／ご内覧時に説明させていただいた／内覧時にお伺いした）", () => {
  expect(findPrematureViewing("ご内覧時にお伝えした環状線上と御堂筋線上の駅周辺で…ピックアップしお送りさせていただきます😌！！").length).toBe(0);
  expect(findPrematureViewing("ご内覧時に説明させていただいた先にお部屋を抑えておくのをオススメいたします！！").length).toBe(0);
  expect(findPrematureViewing("内覧時にお伺いした敷金礼金どちらもなしのお部屋は募集にございませんでした").length).toBe(0);
});
it("仮定は当てない（写真が無い場合は内覧の際に／よろしければ）", () => {
  expect(findPrematureViewing("写真がない場合は内覧の際に直接お部屋をご確認頂けますので、ご安心ください✨").length).toBe(0);
  expect(findPrematureViewing("ご希望いただければ内覧時に直接ご確認いただくのが一番わかりやすいかなと思います🏠").length).toBe(0);
});
it("内覧の打診・候補日の提示は当てない（AIX 内覧日調整の型）", () => {
  expect(findPrematureViewing("10/2日ですと13:00〜16:00ご内覧可能です！！\nみことさんご都合如何でしょうか😌！！").length).toBe(0);
  expect(findPrematureViewing("お気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！").length).toBe(0);
  expect(findPrematureViewing("10/3日は終日予定が入っておりご案内が出来ないお日にちとなります！！\n\n10/2日のご予定はいかがでしょうか😌！！").length).toBe(0);
});

console.log("\n② 直す（stripPrematureViewing）");
it("実物1: 決まっていなければ語を外す", () => {
  const r = stripPrematureViewing(AUTO1, { confirmed: false, customerText: "夜職なのですがアリバイ会社使えますか？" });
  expect(r.text).toBe("はい！！\nお仕事面こちらでサポートさせて頂きます😊！！\n詳しく打ち合わせさせていただきますのでご安心ください😌！！");
});
it("スクショ: 前の文は残し、内覧へのよろしくの文だけ外す", () => {
  const r = stripPrematureViewing(SHOT, { confirmed: false });
  expect(r.text).toContain("お電話等かかってきませんのでご安心くださいませ😊！！");
  expect(r.text).notToContain("ご内覧");
});
it("決まっている（待ち合わせ案内済み）なら触らない", () => {
  expect(stripPrematureViewing(AUTO1, { confirmed: true }).text).toBe(AUTO1);
});
it("お客様が決まった内覧を自分から言った時は触らない", () => {
  expect(customerMentionsFixedViewing("明日の内覧の時に鍵って必要ですか？")).toBe(true);
  expect(customerMentionsFixedViewing("2日はどうですか？")).toBe(false);
  expect(customerMentionsFixedViewing("10/2の内覧可能ですか？")).toBe(false);
  expect(stripPrematureViewing(AUTO1, { confirmed: false, customerText: "明日の内覧の時に鍵って必要ですか？" }).text).toBe(AUTO1);
});

console.log("\n③ 入口（ブレインの方向・話題）");
it("方向に内覧があり未確定なら「まだ決まっていない」を添える", () => {
  const d = "夜職の審査不安を受け止め、お仕事面をこちらでサポートする旨と管理会社への確認を約束し、10/2の内覧へ進め";
  expect(annotateUnconfirmedViewing(d, false)).toBe(d + UNCONFIRMED_VIEWING_SUFFIX);
  expect(annotateUnconfirmedViewing(d, true)).toBe(d);
  expect(annotateUnconfirmedViewing("保証会社名を案内する", false)).toBe("保証会社名を案内する");
});
it("話題「10/2（金）13:00〜16:00の内覧日確定」は内覧の確定の話題", () => {
  expect(isViewingFixTopic("10/2（金）13:00〜16:00の内覧日確定")).toBe(true);
  expect(isViewingFixTopic("初期費用の分割払い可否を確認して回答")).toBe(false);
});

console.log("\n④ 台帳（viewing_presumed）: 待ち合わせの有無で分かれる");
const T0 = Date.parse("2026-09-30T06:26:45Z");
const invited: LedgerAixRow[] = [
  { aix_type: "viewing_invite", created_at: "2026-09-28T03:20:44Z", sent_at: "2026-09-28T03:20:44Z", generated_text: "かしこまりました！！\n\nレジュールアッシュ北大阪 GRAND STAGE 206号室、ご内覧可能です😊！！\n\n直近ですと\n本日 9/28(月) 15:00〜17:00\n明日 9/29(火) 12:00〜16:00にてご案内可能です😊！！" },
  { aix_type: "viewing_invite", created_at: "2026-09-30T03:07:43Z", sent_at: "2026-09-30T03:07:43Z", generated_text: "みことさん\nお世話になっております！！\n\n10/2日ですと13:00〜16:00ご内覧可能です！！\nみことさんご都合如何でしょうか😌！！" },
];
const msgs: LedgerMessage[] = [
  { sender: "customer", text: "3日はおやすみですよね💦", createdAt: "2026-09-30T06:13:34Z" },
  { sender: "staff", text: "10/3日は終日予定が入っておりご案内が出来ないお日にちとなります！！\n\n10/2日のご予定はいかがでしょうか😌！！", createdAt: "2026-09-30T06:22:35Z" },
  { sender: "customer", text: "夜職なのですがアリバイ会社使えますか？", createdAt: "2026-09-30T06:26:45Z" },
];
const ledgerUnconfirmed = buildActionLedger({ recentAixRows: invited, messages: msgs, lineTasks: [], lastCustomerAt: "2026-09-30T06:26:45Z", now: T0 });
it("みことさんの時点: 内覧の打診はあるが待ち合わせは無い", () => {
  expect(ledgerUnconfirmed.facts.viewingInvited).toBe(true);
  expect(ledgerUnconfirmed.facts.viewingAppointment).toBe(null);
});
it("台帳の注記に「まだ決まっていない」の行が入る", () => {
  expect(buildActionLedgerNote(ledgerUnconfirmed)).toContain("内覧は**まだ決まっていない**");
});
it("検査: viewing_presumed が block で当たる", () => {
  const h = checkDonePresupposition(AUTO1, ledgerUnconfirmed, { customerMessage: "夜職なのですがアリバイ会社使えますか？", name: "みことさん" });
  const v = h.find((x) => x.key === "viewing_presumed");
  expect(!!v).toBe(true);
  expect(v!.exempt).toBe(null);
  expect(v!.severity).toBe("block");
});
it("自動修正: 生成直後・最終チェックの修正ループで同じ直し", () => {
  const r = applyLedgerAutoFix(AUTO2, ledgerUnconfirmed, { customerMessage: "ありがとうございます。\n初期費用分割は難しいですよね🥲", name: "みことさん" });
  expect(r.text).notToContain("内覧");
  expect(r.text).toContain("初期費用の分割払いは難しいですが");
});
it("自動修正: 文ごと外しても「！」だけの行を残さない（スクショの下書き）", () => {
  const r = applyLedgerAutoFix(SHOT, ledgerUnconfirmed, { customerMessage: "夜職なのですがアリバイ会社使えますか？", name: "みことさん" });
  expect(r.text).notToContain("ご内覧");
  expect(/^[！!]+$/m.test(r.text)).toBe(false);
  expect(r.text.trim()).toBe("はい！！\nお仕事面こちらでサポートさせて頂きますので、お電話等かかってきませんのでご安心くださいませ😊！！");
});
const meeting: LedgerAixRow[] = [...invited, {
  aix_type: "meeting_place", created_at: "2026-09-30T05:00:00Z", sent_at: "2026-09-30T05:00:00Z",
  generated_text: "かしこまりました！！\n10/2(金) 13:00にレジュールアッシュ北大阪 GRAND STAGEの現地エントランスにてお待ち合わせでお願い致します😊！！",
}];
const ledgerConfirmed = buildActionLedger({ recentAixRows: meeting, messages: msgs, lineTasks: [], lastCustomerAt: "2026-09-30T06:26:45Z", now: T0 });
it("待ち合わせを送った後は当てない（決まっている）", () => {
  expect(!!ledgerConfirmed.facts.viewingAppointment).toBe(true);
  const h = checkDonePresupposition(AUTO1, ledgerConfirmed, { customerMessage: "夜職なのですがアリバイ会社使えますか？", name: "みことさん" });
  expect(h.find((x) => x.key === "viewing_presumed")?.exempt).toBe("evidence");
  expect(buildActionLedgerNote(ledgerConfirmed)).notToContain("まだ決まっていない");
});

console.log("\n⑤ こちらの本文の確定の宣言（待ち合わせの語が無い形・監査で見つけた誤削除の候補）");
it("オンライン内覧の宣言（d3a56a97）は確定", () => {
  const at = Date.parse("2026-09-06T03:20:12Z");
  expect(findStaffViewingDeclaration("かしこまりました！！\n明日 9/7 16:00〜よりオンライン内見させて頂きます！！\n何卒よろしくお願い致します😌！！", at)).toBe("9/7");
});
it("お客様が決めた日時への宣言（595b1cd4）は確定", () => {
  expect(findStaffViewingDeclaration("かしこまりました！！\n7月2日（木）14:30よりプレサンス心斎橋レヨン 601号室ご案内させていただきます😊！！", Date.parse("2026-06-19T05:37:19Z"))).toBe("7/2");
});
it("日付の宣言＋待ち合わせの場所だけ聞く（60d5b1e9）は確定", () => {
  expect(findStaffViewingDeclaration("かしこまりました！！\n6/16日お部屋ご案内させていただきます😊！！\n6/16日16:00にビエラ江戸堀現地エントランス前待ち合わせいかがでしょうか😌！！", Date.parse("2026-06-13T01:36:24Z"))).toBe("6/16");
});
it("「23日の17:00でのご内見、確定させていただきますね」（13a701a8）は確定", () => {
  expect(findStaffViewingDeclaration("かしこまりました😊\n\n23日の17:00でのご内見、確定させていただきますね✨", Date.parse("2026-05-22T11:29:37Z"))).toBe("5/23");
});
it("打診（AIX 内覧日調整の型・みことさん）は確定ではない", () => {
  const at = Date.parse("2026-09-30T03:07:43Z");
  expect(findStaffViewingDeclaration("みことさん\nお世話になっております！！\n\n10/2日ですと13:00〜16:00ご内覧可能です！！\nみことさんご都合如何でしょうか😌！！", at)).toBe(null);
  expect(findStaffViewingDeclaration("10/3日は終日予定が入っておりご案内が出来ないお日にちとなります！！\n\n10/2日のご予定はいかがでしょうか😌！！", at)).toBe(null);
  expect(findStaffViewingDeclaration("直近ですと\n本日 9/28(月) 15:00〜17:00\n明日 9/29(火) 12:00〜16:00にてご案内可能です😊！！", at)).toBe(null);
});
it("台帳: 宣言の後は viewing_presumed を通す（本日オンライン内見の際に…）", () => {
  const l = buildActionLedger({ recentAixRows: [], lineTasks: [], now: Date.parse("2026-09-07T02:59:00Z"), lastCustomerAt: "2026-09-07T00:23:47Z", messages: [
    { sender: "staff", text: "9/7（月）16:00より、オンライン内覧Sさんご都合如何でしょうか😌！", createdAt: "2026-09-05T14:49:50Z" },
    { sender: "customer", text: "はい！大丈夫です！", createdAt: "2026-09-06T03:12:33Z" },
    { sender: "staff", text: "かしこまりました！！\n明日 9/7 16:00〜よりオンライン内見させて頂きます！！\n何卒よろしくお願い致します😌！！", createdAt: "2026-09-06T03:20:12Z" },
    { sender: "customer", text: "ちなみに契約するとなると旦那の名義で契約したいのですが、個人事業主になりたてですが、審査は大丈夫でしょうか…", createdAt: "2026-09-07T00:23:47Z" },
  ] });
  expect(l.facts.viewingDeclared?.dateMD).toBe("9/7");
  const h = checkDonePresupposition("はい！！審査面無事通過致しますようにサポートさせて頂きます！！\n本日オンライン内見の際に審査通過に関しましてもお電話で簡単にお打ち合わせさせて頂きます！！", l, { customerMessage: "", name: "" });
  expect(h.find((x) => x.key === "viewing_presumed")?.exempt).toBe("evidence");
});
it("監査で直した語: 内覧時期・内覧時間・内覧当日の集合場所は当てない", () => {
  expect(findPrematureViewing("管理会社に内覧時期確認させていただき、7/3日退去予定のお部屋となっております").length).toBe(0);
  expect(findPrematureViewing("7/12日のご内覧時間の変更も可能ですのでお気軽にお知らせください😊！！").length).toBe(0);
  expect(findPrematureViewing("かしこまりました！！\n内覧当日の集合場所・時間につきましては改めてご連絡させて頂きます😊！！").length).toBe(0);
});
it("監査で止めた: スタッフの手書きのお願い・希望の形／選択肢の片方は出口で触らない（誤削除0）", () => {
  expect(findPrematureViewing("あいりさんお気に召されたお部屋ご都合よろしいお日にちにご案内させて頂きます！！お仕事の事や、今後の状況についてもご内覧の際等にお聞かせ頂きますと幸いです😌✨").length).toBe(0);
  expect(findPrematureViewing("審査面通過しますよう、お打ち合わせをご内覧の際または、お手隙の際にお電話でお伝えさせて頂きます！！").length).toBe(0);
  expect(findPrematureViewing("基本的に連帯保証人と緊急連絡先は審査の際に必要となります！！\n審査無事通りますようにサポートさせて頂きますので、お部屋ご内覧の際に簡単にお打ち合わせさせて頂ければと思います😌！！").length).toBe(0);
});
it("言い切りは直す（竹内さんが指摘した会話の文・内覧へのよろしく）", () => {
  expect(findPrematureViewing("審査無事通るようサポートさせていただきます！！\nご内覧時に内覧担当より詳しくお話しさせていただきますので気になる点などございましたらお気軽にお知らせください😊！！")[0].fixed).toBe("詳しくお話しさせていただきますので気になる点などございましたらお気軽にお知らせください😊！！");
  expect(findPrematureViewing("かしこまりました！！\nご内覧当日もどうぞよろしくお願いいたします！！")[0].kind).toBe("viewing_greeting");
});
// 2026-09-30 見直し（形の確認用の文。実送信には無い形＝手本ではない）
it("見直し: 「には」を外した後に「は」が残らない", () => {
  expect(findPrematureViewing("ご内覧時には身分証は不要です😊！！")[0].fixed).toBe("身分証は不要です😊！！");
});
it("見直し: 日程のお返事を待つ文（内覧調整中の正しい返事）は当てない", () => {
  expect(findPrematureViewing("ご内覧ご希望のお日にちお待ちしております😊！！").length).toBe(0);
  expect(findPrematureViewing("ご内覧希望日よろしくお願い致します！！").length).toBe(0);
  // 内覧そのものへの挨拶・楽しみは今まで通り当たる（実物 0133b787・60d5b1e9）
  expect(findPrematureViewing("6月1日のご内覧、楽しみにお待ちしております！")[0].kind).toBe("looking_forward");
  expect(findPrematureViewing("6/16のビエラ江戸堀内覧もどうぞよろしくお願い致します😌！！")[0].kind).toBe("viewing_greeting");
});
it("見直し: 同じ行の前にある質問（？）は消さない", () => {
  const l = buildActionLedger({ recentAixRows: [], messages: [
    { sender: "staff", text: "10/2日ですと13:00〜16:00ご内覧可能です！！\nYUMAさんご都合如何でしょうか😌！！", createdAt: "2026-09-30T03:07:00Z" },
    { sender: "customer", text: "3日はおやすみですよね💦", createdAt: "2026-09-30T03:10:00Z" },
  ] as LedgerMessage[], lineTasks: [], lastCustomerAt: "2026-09-30T03:10:00Z", now: Date.parse("2026-09-30T06:30:00Z") });
  const r = applyLedgerAutoFix("10/2日のご都合いかがでしょうか？ご内覧時に内覧担当より詳しくお話しさせていただきます！！", l, { customerMessage: "3日はおやすみですよね💦", name: "" });
  expect(r.text).toContain("10/2日のご都合いかがでしょうか？");
  expect(r.text).notToContain("ご内覧時に");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
