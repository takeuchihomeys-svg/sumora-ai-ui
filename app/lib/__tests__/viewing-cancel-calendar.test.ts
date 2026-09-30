// 2026-09-30 竹内: お客様が決まった内覧を取りやめた時、カレンダーの決まった内覧の予定を自動で消す — 消す対象を選ぶ判定
// 実行: npx tsx --env-file=.env.local app/lib/__tests__/viewing-cancel-calendar.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { decideViewingCancelFromLedgerInput, hasViewingCancelRequestLine, pickViewingEventsToCancel, isCancellableViewingEvent, viewingCancelAutoEnabled, type CalEventRow } from "../viewing-cancel-calendar";
import type { LedgerAixRow, LedgerMessage } from "../action-ledger";
import { pendingViewingNotes } from "../meeting-calendar";
import { holdNotes } from "../viewing-hold";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}
const at = (md: string, hm: string) => { const [m, d] = md.split("/").map(Number); const [h, mi] = hm.split(":").map(Number); return new Date(Date.UTC(2026, m - 1, d, h - 9, mi)).toISOString(); };
const c = (md: string, hm: string, text: string): LedgerMessage => ({ sender: "customer", text, createdAt: at(md, hm) });
const s = (md: string, hm: string, text: string): LedgerMessage => ({ sender: "staff", text, createdAt: at(md, hm) });
const aix = (type: string, iso: string, text: string) => ({ aix_type: type, created_at: iso, sent_at: iso, generated_text: text }) as unknown as LedgerAixRow;

// 成約した流れ（6fdadc8b 型・名前は YUMA）: 内覧調整 → 日＋時刻 → 待ち合わせ場所＝確定（9/14 16:00）
const INVITE = "直近ですと\n9/14(月) 12:00〜14:00\n9/15(火) 11:00〜13:00にてご案内可能です😊！！\nご都合よろしいお日にち御座いますでしょうか！！";
const MEETING = "かしこまりました！！\n9/14（月）16:00〜ご案内させて頂きます！！\n9/14 16:00にS-RESIDENCE難波大国町Deux\n現地エントランスお待ち合わせで何卒よろしくお願い致します！！\n住所: 大阪府大阪市浪速区";
const WON: LedgerMessage[] = [
  c("9/11", "10:00", "3件とも内覧行きたいのですが…いつ頃行けますか？"),
  s("9/11", "10:30", INVITE),
  c("9/11", "11:00", "では14日の16:00でお願いしたいです！"),
  s("9/11", "11:20", MEETING),
  c("9/11", "11:30", "ありがとうございます！よろしくお願いします！"),
];
const ROWS = [aix("viewing_invite", at("9/11", "10:30"), INVITE), aix("meeting_place", at("9/11", "11:20"), MEETING)];
const decide = (extra: LedgerMessage[], now = at("9/12", "09:01"), rows = ROWS) =>
  decideViewingCancelFromLedgerInput({ messages: [...WON, ...extra], recentAixRows: rows, lineTasks: [] }, Date.parse(now));

console.log("\n① 今回の連投で決まった内覧を取りやめたか");
for (const text of ["14日の内覧は一度キャンセルさせてください", "今回の内覧はキャンセルでお願いします", "いったんキャンセルでお願いいたします。"]) {
  it(`「${text}」→ 消す（決まっていた日 9/14 16:00）`, () => {
    const d = decide([s("9/11", "11:40", "こちらこそ何卒よろしくお願い致します！！"), c("9/12", "09:00", text)]);
    expect(d.cancel).toBe(true);
    if (d.cancel) { expect(d.day).toBe("9/14"); expect(d.time).toBe("16:00"); }
    expect(d.triggerText).toBe(text);
  });
}
it("YUMA の実物の形「2日の内覧は一度キャンセルさせてください」（10/2 13:00 の待ち合わせの後）→ 消す", () => {
  const inv = "直近ですと\n10/2(金) 13:00〜15:00にてご案内可能です😊！！\nYUMAさんご都合よろしいお日にち御座いますでしょうか！！";
  const meet = "かしこまりました！！\n10/2（金）13:00〜ご案内させて頂きます！！\n10/2 13:00にエステムコート大阪WEST\n現地エントランスお待ち合わせで何卒よろしくお願い致します！！\n住所: 大阪府大阪市西区九条南1丁目";
  const msgs = [c("9/30", "10:00", "内覧したいです"), s("9/30", "10:10", inv), c("9/30", "10:20", "2日の13時でお願いします"), s("9/30", "10:30", meet), c("9/30", "18:00", "2日の内覧は一度キャンセルさせてください")];
  const d = decideViewingCancelFromLedgerInput({ messages: msgs, recentAixRows: [aix("viewing_invite", at("9/30", "10:10"), inv), aix("meeting_place", at("9/30", "10:30"), meet)], lineTasks: [] }, Date.parse(at("9/30", "18:01")));
  expect(d.cancel).toBe(true);
  if (d.cancel) expect(d.day).toBe("10/2");
});
it("「14日キャンセルで15日に変更できますか」（別の日への変更）→ 消さない", () => expect(decide([c("9/12", "09:00", "すみません14日キャンセルで、15日に変更できますか？")]).cancel).toBe(false));
it("「15日の方が助かるんですけど変更お願いしても行けますか」→ 消さない", () => expect(decide([c("9/12", "09:00", "15日の方が助かるんですけど変更お願いしても行けますか")]).cancel).toBe(false));
it("「15日の12時からに変更お願いできますか？」→ 消さない", () => expect(decide([c("9/12", "09:00", "すみません、15日の12時からに変更お願いできますか？")]).cancel).toBe(false));
it("了承（「よろしくお願いします」）・別の質問 → 消さない", () => {
  expect(decide([]).cancel).toBe(false);
  expect(decide([c("9/12", "09:00", "保証会社はどこですか？")]).cancel).toBe(false);
});
it("取りやめの後にこちらが返した（最後がスタッフ）→ 今回の連投ではないので消さない", () => {
  const d = decide([c("9/12", "09:00", "今回の内覧はキャンセルでお願いします"), s("9/12", "09:10", "かしこまりました！！")], at("9/12", "09:11"));
  expect(d.cancel).toBe(false);
});
it("取りやめの後のお客様の別の発言（次の連投）→ 過去の取りやめでは消さない", () => {
  const d = decide([c("9/12", "09:00", "今回の内覧はキャンセルでお願いします"), s("9/12", "09:10", "かしこまりました！！"), c("9/12", "12:00", "別のお部屋も探してもらえますか？")], at("9/12", "12:01"));
  expect(d.cancel).toBe(false);
});
it("過去の取りやめの後に新しく確定した内覧（9/20 13:00）→ 了承では消さない", () => {
  const inv2 = "直近ですと\n9/20(日) 13:00〜15:00にてご案内可能です😊！！\nご都合よろしいお日にち御座いますでしょうか！！";
  const meet2 = "かしこまりました！！\n9/20（日）13:00〜ご案内させて頂きます！！\n9/20 13:00にS-RESIDENCE難波大国町Deux\n現地エントランスお待ち合わせで何卒よろしくお願い致します！！";
  const extra = [
    c("9/12", "09:00", "今回の内覧はキャンセルでお願いします"), s("9/12", "09:10", "かしこまりました！！"),
    c("9/13", "10:00", "やっぱり内覧したいです。20日は空いてますか？"), s("9/13", "10:10", inv2), c("9/13", "10:20", "20日の13時でお願いします"), s("9/13", "10:30", meet2),
    c("9/13", "10:40", "ありがとうございます！よろしくお願いします！"),
  ];
  const d = decide(extra, at("9/13", "10:41"), [...ROWS, aix("viewing_invite", at("9/13", "10:10"), inv2), aix("meeting_place", at("9/13", "10:30"), meet2)]);
  expect(d.cancel).toBe(false);
});
it("監査の実物 ae321772「現状抑えていただいてる分については一度キャンセルになりますか？💦」（申込で押さえた部屋の質問）→ 消さない", () => {
  expect(decide([s("9/11", "11:40", "審査のご案内です！！"), c("9/12", "09:00", "ご連絡いただきありがとうございます！\nでは現状抑えていただいてる分については一度キャンセルになりますか？💦")]).cancel).toBe(false);
  expect(hasViewingCancelRequestLine("では現状抑えていただいてる分については一度キャンセルになりますか？💦")).toBe(false);
  expect(hasViewingCancelRequestLine("審査通したらキャンセル不可ですかね、？")).toBe(false);
});
it("監査の実物（消す側）: 内覧の取りやめのお願いの行", () => {
  for (const t of ["すいません💦内覧キャンセルでも大丈夫ですか😂", "7月25日の内覧の件なんですがちょっと急用ができてしまったのでキャンセルでお願いします！", "すみません一旦引越し考え直すことになったので明日キャンセルでお願いします🙇‍♀️💦", "申し訳ありませんが、予定していたLuxe難波西2の内覧をキャンセルさせていただきたいです。"]) {
    if (!hasViewingCancelRequestLine(t)) throw new Error(t);
  }
});
it("候補日のやり取り中（待ち合わせ前）の取りやめ → 決まった内覧ではないので消さない", () => {
  const d = decideViewingCancelFromLedgerInput({ messages: [...WON.slice(0, 2), c("9/11", "11:00", "やっぱり内覧はキャンセルでお願いします")], recentAixRows: [ROWS[0]], lineTasks: [] }, Date.parse(at("9/11", "11:01")));
  expect(d.cancel).toBe(false);
});

console.log("\n② 消す予定を選ぶ（その会話の・今日以降の・済みでない・決まった内覧の1件）");
const CONV = "conv-yuma";
const NOW = Date.parse(at("9/12", "09:01"));
const ev = (id: number, md: string, hm: string, notes: string, extra: Partial<CalEventRow> = {}): CalEventRow => ({ id, conversation_id: CONV, event_type: "viewing", start_at: at(md, hm), notes, is_done: false, all_day: false, ...extra });
const DECIDED = pendingViewingNotes("S-RESIDENCE難波大国町Deux", "大阪府大阪市浪速区");
const pick = (events: CalEventRow[], day: string | null = "9/14", time: string | null = "16:00") => pickViewingEventsToCancel({ events, conversationId: CONV, day, time, nowMs: NOW });
it("待ち合わせ場所の送信で入った予定（9/14 16:00）を1件", () => expect(JSON.stringify(pick([ev(1, "9/14", "16:00", DECIDED)]).deleteIds)).toBe("[1]"));
it("内覧方法を入れた後の予定（【物件】…現地）も対象", () => expect(JSON.stringify(pick([ev(1, "9/14", "16:00", "【物件】S-RESIDENCE難波大国町Deux / 現地(オートロック: 1234)\n住所: 大阪府大阪市浪速区")]).deleteIds)).toBe("[1]"));
it("時間確保・ブレインの未確定の予定・【必ず】の約束は触らない", () => {
  const r = pick([ev(1, "9/14", "16:00", holdNotes("9/14(月) 12:00〜14:00")), ev(2, "9/14", "10:00", "件数: 1件\n物件: （未確定）（現地）"), ev(3, "9/14", "10:00", "【必ず】連絡")]);
  expect(JSON.stringify(r.deleteIds)).toBe("[]"); expect(r.why).toBe("no_candidate");
});
it("他のお客様の予定・済みの予定・過ぎた日の予定・内覧以外は触らない", () => {
  expect(isCancellableViewingEvent(ev(1, "9/14", "16:00", DECIDED, { conversation_id: "other" }), CONV, NOW)).toBe(false);
  expect(isCancellableViewingEvent(ev(1, "9/14", "16:00", DECIDED, { conversation_id: null }), CONV, NOW)).toBe(false);
  expect(isCancellableViewingEvent(ev(1, "9/14", "16:00", DECIDED, { is_done: true }), CONV, NOW)).toBe(false);
  expect(isCancellableViewingEvent(ev(1, "9/10", "16:00", DECIDED), CONV, NOW)).toBe(false);
  expect(isCancellableViewingEvent(ev(1, "9/14", "16:00", DECIDED, { event_type: "application" }), CONV, NOW)).toBe(false);
  expect(isCancellableViewingEvent(ev(1, "9/12", "18:00", DECIDED), CONV, NOW)).toBe(true);   // 今日の予定は対象
});
it("決まっていた日と違う日の予定しか無い → 消さない（day_mismatch）", () => {
  const r = pick([ev(1, "9/20", "13:00", DECIDED)]);
  expect(JSON.stringify(r.deleteIds)).toBe("[]"); expect(r.why).toBe("day_mismatch");
});
it("別の日にも決まった内覧がある → 決まっていた日の1件だけ", () => expect(JSON.stringify(pick([ev(1, "9/14", "16:00", DECIDED), ev(2, "9/20", "13:00", DECIDED)]).deleteIds)).toBe("[1]"));
it("同じ日に2件 → 時刻が合う1件だけ・時刻でも決まらなければ消さない", () => {
  expect(JSON.stringify(pick([ev(1, "9/14", "12:00", DECIDED), ev(2, "9/14", "16:00", DECIDED)]).deleteIds)).toBe("[2]");
  const r = pick([ev(1, "9/14", "12:00", DECIDED), ev(2, "9/14", "15:00", DECIDED)]);
  expect(JSON.stringify(r.deleteIds)).toBe("[]"); expect(r.why).toBe("ambiguous");
});
it("決まっていた日が読めない時は、候補が1件の時だけ", () => {
  expect(JSON.stringify(pick([ev(1, "9/14", "16:00", DECIDED)], null, null).deleteIds)).toBe("[1]");
  expect(JSON.stringify(pick([ev(1, "9/14", "16:00", DECIDED), ev(2, "9/20", "13:00", DECIDED)], null, null).deleteIds)).toBe("[]");
});
it("もう消してある（二重に走った）→ 何もしない", () => expect(pick([]).why).toBe("no_candidate"));
it("止める環境変数: VIEWING_CANCEL_AUTO=off で消さない", () => {
  expect(viewingCancelAutoEnabled("off")).toBe(false); expect(viewingCancelAutoEnabled("OFF")).toBe(false);
  expect(viewingCancelAutoEnabled(undefined)).toBe(true); expect(viewingCancelAutoEnabled("on")).toBe(true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
