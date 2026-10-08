// app/lib/__tests__/viewing-morning-greeting.test.ts — 内覧当日の朝の挨拶の要対応（10/08 竹内さん「作る」）
// 実行: npx tsx app/lib/__tests__/viewing-morning-greeting.test.ts
import { morningViewingGreetingPlan, keepViewingGreetingItem, morningGreetingNoticeLine } from "../viewing-day-greeting";
import { staffTextFulfillsAixItem } from "../aix-item-cleanup";
import { buildActionLedger } from "../action-ledger";
import { aixButtonText } from "../aix-action-text";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };

const now = Date.parse("2026-10-09T00:15:00Z"); // JST 10/9（金）9:15＝cron の時刻
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
// 内覧後のお礼（済んだ）→ 台帳が null
t("申込以降 → 立てない", morningViewingGreetingPlan({ ...base(l1), postApply: true }).why === "post_apply");
t("内覧まで30分を切った → 立てない", morningViewingGreetingPlan({ ...base(l1), appointmentTime: "9:30" }).why === "too_late");
t("時刻なし → 時刻では止めない", morningViewingGreetingPlan({ ...base(l1), appointmentTime: null }).why === "due");
t("別の AIX要対応が未完了 → 上書きしない", morningViewingGreetingPlan(base(l1, { action: "estimate_sheet", check_pattern: null })).why === "other_pending");
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

console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
