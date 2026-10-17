// app/lib/__tests__/viewing-morning-greeting.test.ts — 内覧当日の朝の挨拶の要対応（10/08 竹内さん「作る」）
// 実行: npx tsx app/lib/__tests__/viewing-morning-greeting.test.ts
import { morningViewingGreetingPlan, keepViewingGreetingItem, morningGreetingNoticeLine, isMorningGreetingItem, viewingDayGreetingDue, viewingFlowCancelled, viewingGreetingSetMinute, minuteLabel, morningGreetingCardDue, morningGreetingCardNote } from "../viewing-day-greeting";
import { staffTextFulfillsAixItem } from "../aix-item-cleanup";
import { buildActionLedger } from "../action-ledger";
import { aixButtonText } from "../aix-action-text";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };

const now = Date.parse("2026-10-09T01:00:00Z"); // JST 10/9（金）10:00＝セットの時刻（2026-10-15〜。旧は 9:15）
// 実物: 10/8 14:22 JST の AIX【待ち合わせ場所】（翌日の内覧）
const MP = "かしこまりました！！\n10/9（金）ご案内させて頂きます！！\n\n10/9 16:00にクリエオーレ一津屋II 103号室\n現地エントランスお待ち合わせで何卒よろしくお願い致します！！\n住所: 大阪府摂津市一津屋2丁目25-10";
const ledgerOf = (extra: Array<{ sender: string; text: string; createdAt: string }> = [], nowMs = now) => buildActionLedger({
  recentAixRows: [{ aix_type: "meeting_place", created_at: "2026-10-08T05:22:21Z", sent_at: "2026-10-08T05:22:22Z", generated_text: MP }],
  messages: [
    { sender: "customer", text: "10/9の16時でお願いします", createdAt: "2026-10-08T05:10:00Z" },
    { sender: "staff", text: MP, createdAt: "2026-10-08T05:22:22Z", isAix: true },
    ...extra,
  ],
  now: nowMs,
});
const base = (l: ReturnType<typeof ledgerOf>, pending: { action: string; check_pattern: string | null } | null = null) => ({
  appointmentDay: l.facts.viewingAppointment?.day ?? null,
  flowConfirmed: l.facts.viewingFlow ? l.facts.viewingFlow.confirmed : null,
  flowCancelled: /cancelled/.test(l.facts.viewingFlow?.reason ?? ""),
  appointmentTime: l.facts.viewingAppointment?.time ?? null,
  postApply: false,
  pending,
  staffMessages: [] as Array<{ text: string; createdAt: string }>,
  nowMs: now,
  env: {} as Record<string, string>,
});

const l1 = ledgerOf();
t("台帳: 待ち合わせの AIX の内覧が今日（10/9 16:00）", l1.facts.viewingAppointment?.day === "today" && l1.facts.viewingAppointment?.time === "16:00", JSON.stringify(l1.facts.viewingAppointment));
t("確定した内覧の朝・挨拶まだ → 立てる", morningViewingGreetingPlan(base(l1)).why === "due");
t("前の日（10/8 の朝）は立てない（明日の内覧）", morningViewingGreetingPlan({ ...base(ledgerOf([], Date.parse("2026-10-08T06:00:00Z"))), nowMs: Date.parse("2026-10-08T06:00:00Z") }).why === "not_today");
// 実物: その日の朝にスタッフが送った当日の挨拶（10/8 11:11 JST ゆいとさん）
const greeted = { text: "ゆいとさんお世話になっております！！\n本日13時お部屋ご案内させて頂きます！\n本日は何卒よろしくお願い致します！！", createdAt: "2026-10-09T00:05:00Z" };
t("今日もう当日の挨拶を送った → 立てない", morningViewingGreetingPlan({ ...base(l1), staffMessages: [greeted] }).why === "already_greeted");
t("今日 内覧挨拶の AIX を押した → 立てない", morningViewingGreetingPlan({ ...base(l1), aixTypesToday: ["greeting_viewing"] }).why === "already_greeted");
// お客様の取りやめ（流れが none に戻る）
const lc = ledgerOf([{ sender: "customer", text: "すみません、明日の内覧キャンセルでお願いします", createdAt: "2026-10-08T12:00:00Z" }]);
t("取りやめの後は立てない", morningViewingGreetingPlan(base(lc)).register === false, `${lc.facts.viewingFlow?.stage}/${lc.facts.viewingFlow?.reason}`);
// 2026-10-08 竹内さん「取りやめの後はブレインの当日の挨拶も出さないようにそろえる」（viewingDayGreetingDue も同じ viewingFlowCancelled）
t("ブレインの当日の挨拶も取りやめの後は出さない", viewingDayGreetingDue({ appointmentDay: "today", flowReason: lc.facts.viewingFlow?.reason ?? null, staffMessages: [], nowMs: now, env: {} }) === false
  && viewingFlowCancelled(lc.facts.viewingFlow?.reason), `${lc.facts.viewingFlow?.reason}`);
t("取りやめが無ければブレインの当日の挨拶は出す（今まで通り）", viewingDayGreetingDue({ appointmentDay: "today", flowReason: l1.facts.viewingFlow?.reason ?? null, staffMessages: [], nowMs: now, env: {} }) === true);
t("VIEWING_DAY_GREETING_CANCEL_GUARD=off → 旧（取りやめでも出す）", viewingDayGreetingDue({ appointmentDay: "today", flowReason: "customer_cancelled_after_confirm", staffMessages: [], nowMs: now, env: { VIEWING_DAY_GREETING_CANCEL_GUARD: "off" } }) === true);
// 内覧後のお礼（済んだ）→ 台帳が null
t("申込以降 → 立てない", morningViewingGreetingPlan({ ...base(l1), postApply: true }).why === "post_apply");
t("内覧まで30分を切った → 立てない", morningViewingGreetingPlan({ ...base(l1), appointmentTime: "9:30" }).why === "too_late");
t("時刻なし → 時刻では止めない", morningViewingGreetingPlan({ ...base(l1), appointmentTime: null }).why === "due");
// 2026-10-08 竹内さん「（別の AIX要対応が残っていても）立てる」: 別の行として並べる（ブレインの依頼は上書きしない）
t("別の AIX要対応が未完了 → 立てる（別の行）", morningViewingGreetingPlan(base(l1, { action: "estimate_sheet", check_pattern: null })).why === "due");
t("VIEWING_MORNING_GREETING_SIDE=off → 旧（立てない）", morningViewingGreetingPlan({ ...base(l1, { action: "estimate_sheet", check_pattern: null }), env: { VIEWING_MORNING_GREETING_SIDE: "off" } }).why === "other_pending");
t("朝の挨拶の行の見分け（resolution_note の頭）", isMorningGreetingItem({ resolution_note: "rule:viewing_morning_greeting 10/9 16:00" }) && !isMorningGreetingItem({ resolution_note: null }) && !isMorningGreetingItem({ resolution_note: "brain_customer_paused" }));
t("同じ内覧挨拶が未完了 → 何もしない", morningViewingGreetingPlan(base(l1, { action: "greeting_viewing", check_pattern: "before" })).why === "already_pending");
t("VIEWING_MORNING_GREETING=off", morningViewingGreetingPlan({ ...base(l1), env: { VIEWING_MORNING_GREETING: "off" } }).why === "off");
t("VIEWING_DAY_GREETING=off でも止まる", morningViewingGreetingPlan({ ...base(l1), env: { VIEWING_DAY_GREETING: "off" } }).why === "off");

// 済み（普通の送信で挨拶を送った）— 実物の文
const item = { action: "greeting_viewing", check_pattern: "before" };
for (const s of [greeted.text, "かしこまりました！！\n\n本日16:30現地エントランス前お気をつけてお越しください！！", "隼斗さん\nお世話になっております！！\n\nかしこまりました！！\n13:30より高殿サンクご案内させていただきます！！\n本日はよろしくお願いいたします😊！！"]) {
  t(`済み: ${s.slice(0, 24).replace(/\n/g, "⏎")}`, staffTextFulfillsAixItem(item, s).done);
}
for (const s of ["かしこまりました😊！！\n日曜日のお送りお待ちしております！！", "はい😊！！\n\nあかりさんからのご連絡お待ちしております！！"]) {
  t(`済みにしない: ${s.slice(0, 24).replace(/\n/g, "⏎")}`, !staffTextFulfillsAixItem(item, s).done);
}
t("内覧後（after:*）はこの線で済みにしない", !staffTextFulfillsAixItem({ action: "greeting_viewing", check_pattern: "after:apply" }, greeted.text).done);

// ブレインの「AIX なし」で取り下げない（当日だけ）
t("当日に立てた内覧前は残す", keepViewingGreetingItem({ action: "greeting_viewing", check_pattern: "before", created_at: "2026-10-09T00:15:00Z" }, Date.parse("2026-10-09T03:00:00Z"), {}));
t("前の日に立てた物は残さない", !keepViewingGreetingItem({ action: "greeting_viewing", check_pattern: "before", created_at: "2026-10-08T00:15:00Z" }, Date.parse("2026-10-09T03:00:00Z"), {}));
t("他の AIX は対象外", !keepViewingGreetingItem({ action: "estimate_sheet", check_pattern: null, created_at: "2026-10-09T00:15:00Z" }, Date.parse("2026-10-09T03:00:00Z"), {}));
t("off で旧", !keepViewingGreetingItem({ action: "greeting_viewing", check_pattern: "before", created_at: "2026-10-09T00:15:00Z" }, Date.parse("2026-10-09T03:00:00Z"), { VIEWING_MORNING_GREETING: "off" }));

// 通知の文
t("通知のボタン名", aixButtonText("greeting_viewing", "before") === "AIX【内覧挨拶→内覧前】", aixButtonText("greeting_viewing", "before"));
t("通知の2行目", morningGreetingNoticeLine({ time: "16:00", place: "クリエオーレ一津屋II 103号室" }) === "本日 16:00 のご内覧（クリエオーレ一津屋II 103号室）の前に内覧挨拶");

// ─── 2026-10-15 竹内さん「内覧日の10時には内覧挨拶がセットされるようにする」───
const at = (hhmm: string) => Date.parse(`2026-10-09T${hhmm}:00+09:00`);
t("セットの時刻: 13:00 の内覧 → 10:00", minuteLabel(viewingGreetingSetMinute("13:00", {})) === "10:00");
t("セットの時刻: 11:00 の内覧 → 10:00（竹内さん 10/16）", minuteLabel(viewingGreetingSetMinute("11:00", {})) === "10:00");
t("VIEWING_GREETING_11AM=off: 11:00 の内覧 → 9:00（旧の2時間前）", minuteLabel(viewingGreetingSetMinute("11:00", { VIEWING_GREETING_11AM: "off" })) === "9:00");
t("セットの時刻: 10:30 の内覧 → 8:30", minuteLabel(viewingGreetingSetMinute("10:30", {})) === "8:30");
t("セットの時刻: 12:00 の内覧 → 10:00", minuteLabel(viewingGreetingSetMinute("12:00", {})) === "10:00");
t("セットの時刻: 時刻なし → 10:00", minuteLabel(viewingGreetingSetMinute(null, {})) === "10:00");
t("セットの時刻: 「9時」→ 7:00", minuteLabel(viewingGreetingSetMinute("9時", {})) === "7:00");
t("VIEWING_GREETING_SET_TIME=off → 旧の 9:15", minuteLabel(viewingGreetingSetMinute("13:00", { VIEWING_GREETING_SET_TIME: "off" })) === "9:15");
t("9:30（16:00 の内覧）→ まだ（not_yet）", morningViewingGreetingPlan({ ...base(l1), nowMs: at("09:30") }).why === "not_yet");
t("10:00（16:00 の内覧）→ 立てる", morningViewingGreetingPlan({ ...base(l1), nowMs: at("10:00") }).why === "due");
t("14:30（16:00 の内覧・その日に予約が入った）→ 立てる", morningViewingGreetingPlan({ ...base(l1), nowMs: at("14:30") }).why === "due");
t("8:30（10:30 の内覧）→ 立てる（2時間前）", morningViewingGreetingPlan({ ...base(l1), appointmentTime: "10:30", nowMs: at("08:30") }).why === "due");
t("8:00（10:30 の内覧）→ まだ", morningViewingGreetingPlan({ ...base(l1), appointmentTime: "10:30", nowMs: at("08:00") }).why === "not_yet");
t("監査の probe（ignoreSetTime）は時刻で止めない", morningViewingGreetingPlan({ ...base(l1), nowMs: at("06:00"), ignoreSetTime: true }).why === "due");
t("off の時は 9:15 を過ぎれば立てる（旧）", morningViewingGreetingPlan({ ...base(l1), nowMs: at("09:30"), env: { VIEWING_GREETING_SET_TIME: "off" } }).why === "due");

// 画面の主のボタン（朝の行がある間）
const mItem = { created_at: "2026-10-09T01:00:10Z", resolution_note: "rule:viewing_morning_greeting 10/9 16:00 クリエオーレ一津屋II 103号室" };
t("主のボタン: 今日立てた朝の行・挨拶まだ → 出す", morningGreetingCardDue({ item: mItem, staffMessages: [], nowMs: at("10:05") }));
t("主のボタン: 挨拶を送った → 消す（読み直しを待たない）", !morningGreetingCardDue({ item: mItem, staffMessages: [{ text: greeted.text, createdAt: "2026-10-09T01:03:00Z" }], nowMs: at("10:05") }));
t("主のボタン: 前の日の行 → 出さない", !morningGreetingCardDue({ item: mItem, staffMessages: [], nowMs: Date.parse("2026-10-10T01:00:00Z") }));
t("主のボタン: ブレインの行（note なし）→ 対象外", !morningGreetingCardDue({ item: { created_at: mItem.created_at, resolution_note: null }, staffMessages: [], nowMs: at("10:05") }));
t("主のボタン: NEXT_PUBLIC_VIEWING_GREETING_MAIN_BUTTON=off", !morningGreetingCardDue({ item: mItem, staffMessages: [], nowMs: at("10:05"), off: true }));
t("カードの一行", morningGreetingCardNote(mItem.resolution_note) === "本日 16:00 のご内覧（クリエオーレ一津屋II 103号室）の前に内覧挨拶", morningGreetingCardNote(mItem.resolution_note));
t("カードの一行（時刻なし）", morningGreetingCardNote("rule:viewing_morning_greeting 10/9  ") === "本日のご内覧の前に内覧挨拶", morningGreetingCardNote("rule:viewing_morning_greeting 10/9  "));

console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
