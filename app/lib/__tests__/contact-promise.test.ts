// app/lib/__tests__/contact-promise.test.ts
// 2026-10-08 竹内さん「連絡する期間を約束したらカレンダーに入れる…1ヶ月半前から探し出す形が理想の流れと伝えて、その日に連絡するように約束後カレンダーに組み込む」
// 実行: npx tsx app/lib/__tests__/contact-promise.test.ts（文は実際の LINE のまま・名前は伏せ字）
import {
  parseContactPromise, resolveMoveInStart, moveInFromCustomerText, contactDateFor, farMoveInPlan, farMoveInTurn,
  contactEventRow, planContactPromiseSync, isContactPromiseNotes, contactDue, ymdStr, farMoveInCoreText,
} from "../contact-promise";
import { isWaitPromiseNotes, waitPromiseBadge } from "../promise-timing";
import { promiseEventRows } from "../promise-calendar";
import { classifyTarget, brainNeedsStaff } from "../brain-attention";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const cp = (text: string, at: string) => { const p = parseContactPromise(text, at); return p ? ymdStr(p.contact) : null; };

console.log("■ こちらの送信の連絡の日の約束（竹内さんの実送信）");
t("きむら 7月1日にピックアップしお送り", cp("きむらさんおはようございます！！\nご連絡ありがとうございます😊！！\n\nかしこまりました！！\n8月20頃に向けてきむらさんがご満足頂くお部屋でお引越し出来ますよう全力でサポートさせて頂きます😌！！\n\nジーメゾン所沢星の宮確認しましたところ、現在募集終了となっております！\n\n\nお部屋の抑える事が出来るのが、伸ばす事が出来て30日となりますので、7月に入ってから本格的にお部屋探しを進めて頂くのがオススメです！！\n7月1日にきむらさんのご条件に合ったお部屋をピックアップしお送りさせて頂きます！！\n引き続き何卒よろしくお願い致します！！", "2026-06-07T23:17:00Z") === "2026-07-01");
t("あい 7月下旬（7月20日）に…お送り（改行で割れた文）", cp("はい！！\n7月下旬（7月20日）に最新の物件で\nあいさんにオススメ出来るお部屋ピックアップし一度お送りさせて頂きます😊！！\n引き続き何卒よろしくお願い致します！！", "2026-06-14T02:50:00Z") === "2026-07-20");
t("Hayato 8月から…8月に入りましたら…お送り", cp("Hayato.Iさんお世話になっております！！\n\n慎重にご検討頂いている姿勢、とても大事だと思います😊！！\n\n8月から本格的にお部屋探しを進めて頂く形で、8月に入りましたら新着物件も含めてHayato.Iさんのご希望条件に合った家賃帯ももう少し抑えられるお部屋含め優先的にピックアップしてお送りさせて頂きます！！", "2026-06-28T04:28:00Z") === "2026-08-01");
t("友哉 8月後半から物件ピックアップを開始（入居の日は約束の日にしない）", cp("かしこまりました！！\n\n8月後半から物件ピックアップを開始し、9月頭のお申込み・9月27〜30日頃のご入居に向けてしっかりサポートさせて頂きます😊！！\n\nその時期になりましたらすぐにご連絡させて頂きますので、引き続き何卒よろしくお願い致します！！", "2026-07-02T08:41:00Z") === "2026-08-16");
t("友哉 8月後半に友哉さんへご連絡", cp("はい😊！！\n8月後半に友哉さんへご連絡させて頂きます！！\n引き続き何卒よろしくお願い致します😌！！", "2026-07-03T01:58:00Z") === "2026-08-16");
t("カメ 2028年1月からお部屋探しをさせて頂ければ", cp("カメさんお世話になっております！！\n2028年3月ご入居とのことで、弊社では2ヶ月前からお引越しのサポートをさせて頂いております。\n2028年1月からお部屋探しをさせて頂ければと思います😊！！", "2026-10-06T02:14:00Z") === "2028-01-01");
t("カメ 入居の時期を拾う（2028年3月）", parseContactPromise("2028年3月ご入居とのことで、弊社では2ヶ月前からお引越しのサポートをさせて頂いております。\n2028年1月からお部屋探しをさせて頂ければと思います😊！！", "2026-10-06T02:14:00Z")?.moveInLabel === "2028年3月");
t("従業員 10月のご入居に向け8月ごろから…探し再開させていただきます", cp("10月のご入居に向け8月ごろから友哉さんにオススメできるお部屋探し再開させていただきます！！", "2026-06-24T07:53:00Z") === "2026-08-01");

console.log("■ 約束ではない（入れない）");
t("審査の進捗ございましたら改めてご連絡", cp("はい😊！！\n審査の進捗ございましたら改めてご連絡させて頂きます！！", "2026-09-09T11:36:00Z") === null);
t("月曜日に改めてご連絡（日付が読めない）", cp("礼金の件は月曜日に改めてご連絡させて頂きますので、何卒よろしくお願い致します😌！！", "2026-08-11T07:41:00Z") === null);
t("11月お引越し予定でしたら9月ごろからお部屋探し本格的にしていただき（お客様の動き）", cp("お部屋お申込みから1ヶ月以内で入居日を設定いただく必要がございますので、11月お引越し予定でしたら9月ごろからお部屋探し本格的にしていただき9月中旬〜10月上旬にご内覧、お申込みいただくのをオススメいたします😌！！", "2026-07-25T02:36:00Z") === null);
t("確認出来次第ご連絡", cp("10月ご入居希望とのこと、確認出来次第ご連絡させて頂きます！！", "2026-09-04T05:01:00Z") === null);
t("時期が来ましたら（日付なし）", cp("夏奈さんのお引越し時期が来ましたら再度お部屋探しサポートさせていただきます😌！！", "2026-06-24T01:46:00Z") === null);
t("お気軽にご連絡ください", cp("10月に入りましたらお気軽にご連絡ください😊！！", "2026-08-24T01:46:00Z") === null);
t("明日のご連絡（2日未満は今の【必ず】の仕組み）", cp("10月9日にご連絡させて頂きます！！", "2026-10-08T05:00:00Z") === null);
t("内覧の日（6月1日でお手配）", cp("レオンコンフォート堀江とビオラコートの内覧を6月1日でお手配させていただきますね😊", "2026-05-19T09:22:00Z") === null);

console.log("■ お客様の入居の時期 → 連絡の日（1ヶ月半前）");
t("8/20 → 7/5", ymdStr(contactDateFor({ y: 2026, m: 8, d: 20 })) === "2026-07-05");
t("8/31 → 7/16", ymdStr(contactDateFor({ y: 2026, m: 8, d: 31 })) === "2026-07-16");
t("3/31 → 2/13（2月末にそろえて15日戻す）", ymdStr(contactDateFor({ y: 2027, m: 3, d: 31 })) === "2027-02-13");
t("1/10 → 前年 11/25", ymdStr(contactDateFor({ y: 2027, m: 1, d: 10 })) === "2026-11-25");
t("条件「2028/3月以降」→ 2028-03-01", ymdStr(resolveMoveInStart("2028/3月以降", "2026-10-05T06:22:00Z")!.ymd) === "2028-03-01");
t("条件「9~11月頃」→ 9/1（始まり）", ymdStr(resolveMoveInStart("9~11月頃", "2026-06-26T00:00:00Z")!.ymd) === "2026-09-01");
t("条件「2月」（10月に）→ 来年2月", ymdStr(resolveMoveInStart("2月", "2026-10-08T00:00:00Z")!.ymd) === "2027-02-01");
t("条件「すぐにでも」→ 読まない", resolveMoveInStart("すぐにでも", "2026-10-08T00:00:00Z") === null);
t("お客様「一応八月の下旬あたりに引っ越そうからと思ってます！\\n8月20頃」→ 8/21", ymdStr(moveInFromCustomerText("おはようございます！\n一応八月の下旬あたりに引っ越そうからと思ってます！\n8月20頃\n前の家はもうなくなってますよ」？", "2026-06-07T22:45:00Z")!.ymd) === "2026-08-21");
t("お客様「2028/3月以降入居」", ymdStr(moveInFromCustomerText("2028/3月以降入居\n4~7万\n2LDK", "2026-10-05T06:22:00Z")!.ymd) === "2028-03-01");
t("お部屋の入居可能日の質問は読まない", moveInFromCustomerText("ここは12月から入居できますか？", "2026-10-08T00:00:00Z") === null);
const far = farMoveInPlan(resolveMoveInStart("2月", "2026-10-08T00:00:00Z")!, "2026-10-08T00:00:00Z", "condition");
t("10/8 に「2月」→ 連絡の日 12/17（先）", !!far && ymdStr(far.contact) === "2026-12-17", JSON.stringify(far));
t("10/8 に「11月中旬」→ 連絡の日 9/26（過ぎた＝先ではない）", farMoveInPlan(resolveMoveInStart("11月中旬", "2026-10-08T00:00:00Z")!, "2026-10-08T00:00:00Z", "condition") === null);

console.log("■ この番か（farMoveInTurn）");
const turn = farMoveInTurn({ customerTurn: [{ text: "2月に引っ越し予定です！", at: "2026-10-08T03:00:00Z" }], staffHistory: [], nowIso: "2026-10-08T03:00:00Z" });
t("お客様が2月の引越しを言った → 番", !!turn && turn.contactLabel === "12月17日", JSON.stringify(turn));
t("既に 12月17日にご連絡を約束済み → 番ではない", farMoveInTurn({ customerTurn: [{ text: "2月に引っ越し予定です！", at: "2026-10-08T03:00:00Z" }], staffHistory: [{ text: "12月17日にYUMAさんのご条件に合ったお部屋をピックアップしお送りさせて頂きます！！", at: "2026-10-01T03:00:00Z" }], nowIso: "2026-10-08T03:00:00Z" }) === null);
t("条件の入居時期だけ・お礼の番 → 番ではない", farMoveInTurn({ customerTurn: [{ text: "ありがとうございます！", at: "2026-10-08T03:00:00Z" }], conditionMoveIn: "2月", staffHistory: [], nowIso: "2026-10-08T03:00:00Z" }) === null);
t("条件の入居時期・物件の依頼 → 番", !!farMoveInTurn({ customerTurn: [{ text: "お部屋探して頂けますか？", at: "2026-10-08T03:00:00Z" }], conditionMoveIn: "2月", staffHistory: [], nowIso: "2026-10-08T03:00:00Z" }));

console.log("■ カレンダーの行と出し入れ");
const p = parseContactPromise("2月にお引越しのご予定とのことで、12月17日にYUMAさんのご条件に合ったお部屋をピックアップしお送りさせて頂きます！！", "2026-10-08T03:00:00Z")!;
const row = contactEventRow(p, { customerName: "YUMA", conversationId: "c1", sentAt: "2026-10-08T03:00:00Z" });
t("title「YUMAさんに連絡（入居2月）」", row.title === "YUMAさんに連絡（入居2月）", row.title);
t("start_at は 12/17 10:00 JST", row.start_at === "2026-12-17T01:00:00.000Z", row.start_at);
t("notes は【必ず】＋連絡日の印・約束・AIX の行", isContactPromiseNotes(row.notes) && row.notes.startsWith("【必ず】") && /\n約束: /.test(row.notes) && /\nAIX: 【物件ピックアップした】/.test(row.notes));
t("連絡の日より前は待ちの約束（🔴必ず・N日に数えない）", isWaitPromiseNotes(row.notes, Date.parse("2026-12-16T12:00:00Z")) && waitPromiseBadge(row.notes, Date.parse("2026-12-10T00:00:00Z")) === "12/17に連絡");
t("当日からは今日の約束", !isWaitPromiseNotes(row.notes, Date.parse("2026-12-17T00:30:00Z")) && waitPromiseBadge(row.notes, Date.parse("2026-12-17T00:30:00Z")) === null);
t("contactDue: 前日 false・当日 true", !contactDue(row.notes, Date.parse("2026-12-16T05:00:00Z")) && contactDue(row.notes, Date.parse("2026-12-17T00:00:00Z")));
const open = [{ id: 1, notes: row.notes, is_done: false }];
t("同じ約束の言い直し → 入れない・閉じない", JSON.stringify(planContactPromiseSync({ open, promise: p, sentAt: "2026-10-09T03:00:00Z", delivered: false })) === JSON.stringify({ closeIds: [], insert: false }));
t("途中のふつうの送信 → 閉じない", planContactPromiseSync({ open, promise: null, sentAt: "2026-11-01T03:00:00Z", delivered: false }).closeIds.length === 0);
t("物件を送った → 閉じる", planContactPromiseSync({ open, promise: null, sentAt: "2026-11-01T03:00:00Z", delivered: true }).closeIds[0] === 1);
t("連絡の日の前日以降に送った → 閉じる", planContactPromiseSync({ open, promise: null, sentAt: "2026-12-16T03:00:00Z", delivered: false }).closeIds[0] === 1);
const p2 = parseContactPromise("1月10日にご連絡させて頂きます！！", "2026-10-20T03:00:00Z")!;
const r2 = planContactPromiseSync({ open, promise: p2, sentAt: "2026-10-20T03:00:00Z", delivered: false });
t("別の日の約束に言い直し → 古いのを閉じて新しく入れる", r2.closeIds[0] === 1 && r2.insert);

console.log("■ 同じ送信の「ピックアップの約束」を今日中の【必ず】にしない");
const rowsToday = promiseEventRows([{ kind: "pickup_declared", status: "promised", evidence: "お送りさせて頂きます", detail: { sentence: "7月1日にきむらさんのご条件に合ったお部屋をピックアップしお送りさせて頂きます！！" } }] as never, { customerName: "きむら", conversationId: "c", sentAt: "2026-06-07T23:17:00Z" });
t("7月1日の約束 → 今日の物件ピックアップ送付【今日中】を作らない（連絡の日の行が持つ）", rowsToday.length === 0, JSON.stringify(rowsToday.map((r) => r.title)));
const rowsToday2 = promiseEventRows([{ kind: "pickup_declared", status: "promised", evidence: "お送りさせて頂きます", detail: { sentence: "本日中にピックアップしお送りさせて頂きます！！" } }] as never, { customerName: "A", conversationId: "c", sentAt: "2026-06-07T23:17:00Z" });
t("今日の約束は今まで通り", rowsToday2.length === 1);

console.log("■ 下書きの芯 → 送ったらカレンダーに入る（往復）");
const core = farMoveInCoreText({ contactLabel: "1月6日" }, "YUMA");
t("芯の文から連絡の日 2027-01-06 を読める", cp(`かしこまりました！！\n${core}`, "2026-10-08T03:00:00Z") === "2027-01-06", core);

console.log("■ その日に戻す（ターゲット・要対応）");
const NOW = Date.parse("2026-12-17T01:30:00Z");
t("連絡の約束の日 → 段 contact_due（終わった案件・発言なしでも）", classifyTarget({ status: "property_search", lastCustomerAt: "2026-10-08T03:00:00Z", meta: null, dealEndedAt: "2026-10-09T00:00:00Z", contactDueYmd: "2026-12-17", nowMs: NOW })?.tier === "contact_due");
t("約束の日が無ければ外れる（同じ人）", classifyTarget({ status: "property_search", lastCustomerAt: "2026-10-08T03:00:00Z", meta: null, nowMs: NOW }) === null);
t("申込以降は戻さない", classifyTarget({ status: "applying", meta: null, contactDueYmd: "2026-12-17", nowMs: NOW }) === null);
t("要対応（スタッフが動く番）", brainNeedsStaff({ meta: null, contactDueYmd: "2026-12-17" }).needs);

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
