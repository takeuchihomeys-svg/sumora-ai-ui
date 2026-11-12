// app/lib/__tests__/time-facts.test.ts — 時間の事実（実行: npx tsx app/lib/__tests__/time-facts.test.ts）
import { computeTimeFacts, timeFactsLine, timeFactsEnabled, elapsedLabel, TIME_LINES_IN_USE, TIME_FACTS_FORBIDDEN_RE, MGMT_OPEN_HOUR } from "../time-facts";
import { PHONE_LAST_HOUR as PHONE_BC, MGMT_CLOSE_HOUR as CLOSE_BC } from "../business-clock";
import { PHONE_LAST_HOUR as PHONE_PC } from "../phone-call";
import { MGMT_CLOSE_HOUR as CLOSE_AH, MGMT_OPEN_HOUR as OPEN_AH } from "../after-hours";
import { COMPANY_CLOSE_HOUR } from "../mgmt-hours-split";

let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
const at = (iso: string) => Date.parse(iso);

t("既定は off", !timeFactsEnabled({}) && timeFactsEnabled({ TIME_FACTS: "on" }));
// 同じ事を2か所で持つ線の一致（食い違いの見張り）
t("電話の線は business-clock と phone-call で同じ 19", PHONE_BC === 19 && PHONE_PC === 19);
t("管理会社の閉は business-clock と after-hours で同じ 18・開は 9", CLOSE_BC === 18 && CLOSE_AH === 18 && OPEN_AH === 9 && MGMT_OPEN_HOUR === 9);
t("弊社の終わりは 21", COMPANY_CLOSE_HOUR === 21);
t("線の一覧に竹内さんの決定の id がある", TIME_LINES_IN_USE.length >= 10 && TIME_LINES_IN_USE.every((x) => x.where && x.kb && x.value));

// 木曜 13:38（11/12）
const f1 = computeTimeFacts({ nowMs: at("2026-11-12T04:38:00Z") });
t("木 13:38: 電話可・弊社営業中・管理会社営業中・次は無し", f1.now.dow === "木" && f1.now.md === "11/12" && f1.phoneOpen && f1.companyOpen && f1.mgmtOpen && f1.mgmtNextOpen === null, f1);
// 木曜 18:30
const f2 = computeTimeFacts({ nowMs: at("2026-11-12T09:30:00Z") });
t("木 18:30: 電話可・管理会社は時間外・次は金 9:00", f2.phoneOpen && !f2.mgmtOpen && f2.mgmtNextOpen?.day.md === "11/13" && f2.mgmtNextOpen?.day.dow === "金" && !f2.mgmtNextOpen?.sameDay && (f2.mgmtNextOpen?.hoursUntil ?? 0) >= 14 && (f2.mgmtNextOpen?.hoursUntil ?? 99) <= 15, f2.mgmtNextOpen);
// 木曜 19:30（電話終わり・弊社はまだ）と 21:10
const f3 = computeTimeFacts({ nowMs: at("2026-11-12T10:30:00Z") });
t("木 19:30: 電話終わり・弊社営業中", !f3.phoneOpen && f3.companyOpen);
const f4 = computeTimeFacts({ nowMs: at("2026-11-12T12:10:00Z") });
t("木 21:10: 弊社終わり", !f4.companyOpen);
// 金曜 21:10 → 次は月曜（土日を飛ばす）
const f5 = computeTimeFacts({ nowMs: at("2026-11-13T12:10:00Z") });
t("金 21:10: 次に開くのは月 11/16", f5.mgmtNextOpen?.day.md === "11/16" && f5.mgmtNextOpen?.day.dow === "月", f5.mgmtNextOpen);
// 土曜 10:00
const f6 = computeTimeFacts({ nowMs: at("2026-11-14T01:00:00Z") });
t("土 10:00: 土日・管理会社は休みの扱い・次は月", f6.now.weekend && !f6.mgmtOpen && f6.mgmtNextOpen?.day.md === "11/16");
// 祝日を飛ばす（11/21 土 → 11/23 祝 → 11/24 火）
const f7 = computeTimeFacts({ nowMs: at("2026-11-21T09:00:00Z") });
t("土 18:00（11/21）: 次は祝日 11/23 を飛ばして 11/24（火）", f7.mgmtNextOpen?.day.md === "11/24" && f7.mgmtNextOpen?.day.dow === "火", f7.mgmtNextOpen);
const f8 = computeTimeFacts({ nowMs: at("2026-11-23T03:00:00Z") });
t("祝日 12:00（11/23）: 祝日の名前・管理会社は休みの扱い", f8.now.holiday === "勤労感謝の日" && !f8.mgmtOpen);
// 朝（開く前）
const f9 = computeTimeFacts({ nowMs: at("2026-11-11T22:00:00Z") }); // JST 11/12 7:00
t("木 7:00: 今日 9:00 に開く（2時間後）", f9.mgmtNextOpen?.sameDay === true && f9.mgmtNextOpen?.hoursUntil === 2, f9.mgmtNextOpen);
// 時計の上書き（テストの時計）
t("hour 上書き: 19 なら電話終わり", !computeTimeFacts({ nowMs: at("2026-11-12T04:38:00Z"), hour: 19 }).phoneOpen);

// 経過
const f10 = computeTimeFacts({ nowMs: at("2026-11-12T04:38:00Z"), lastCustomerAtIso: "2026-11-12T02:00:00Z", lastStaffAtIso: "2026-11-11T05:00:00Z" });
t("お客様 2時間38分前は同じ日（11:00 JST）", f10.sinceCustomer?.sameDay === true && f10.sinceCustomer?.label === "2時間" && f10.sinceCustomer?.whenLabel === "今日", f10.sinceCustomer);
t("こちら 23時間前（昨日 14:00 JST）は24時間未満でも日をまたぐ", f10.sinceStaff?.sameDay === false && f10.sinceStaff?.whenLabel === "昨日" && f10.sinceStaff?.label === "23時間", f10.sinceStaff);
t("日をまたぐ判定は24時間ではなく暦の日（23:50→0:10 は別の日）", (() => { const x = computeTimeFacts({ nowMs: at("2026-11-12T15:10:00Z"), lastStaffAtIso: "2026-11-12T14:50:00Z" }); return x.sinceStaff?.minutes === 20 && x.sinceStaff?.sameDay === false && x.sinceStaff?.whenLabel === "昨日"; })());
t("未来の時刻・壊れた値は null", computeTimeFacts({ nowMs: at("2026-11-12T04:38:00Z"), lastCustomerAtIso: "2026-11-13T00:00:00Z", lastStaffAtIso: "x" }).sinceCustomer === null);
t("経過の言い方", elapsedLabel(0.2) === "1分未満" && elapsedLabel(45) === "45分" && elapsedLabel(150) === "2時間" && elapsedLabel(24 * 60) === "1日" && elapsedLabel(27 * 60) === "1日と3時間");

// 約束の期限・入居希望日
const f11 = computeTimeFacts({ nowMs: at("2026-11-12T04:38:00Z"), promises: [{ label: "連絡日", ymd: "2026-11-12" }, { label: "ピックアップ", ymd: "2026-11-13" }, { label: "確認", ymd: "2026-11-10" }, { label: "先の連絡", ymd: "2026-12-01" }, { label: "壊れ", ymd: "x" }], moveInYmd: "2027-01-01" });
t("約束の期限: 今日・明日・過ぎている・先", f11.promises.map((p) => p.state).join(",") === "today,tomorrow,overdue,future" && f11.promises[2].daysUntil === -2 && f11.promises[3].daysUntil === 19, f11.promises);
t("入居希望日までの日数（50日・約1.6ヶ月）", f11.moveIn?.daysUntil === 50 && /あと50日（約1.6ヶ月）/.test(f11.moveIn?.label ?? ""), f11.moveIn);
t("入居希望日が過ぎている", /過ぎている/.test(computeTimeFacts({ nowMs: at("2026-11-12T04:38:00Z"), moveInYmd: "2026-11-01" }).moveIn?.label ?? ""));

// 行（実物）
const line = timeFactsLine(f2);
const lineFull = timeFactsLine(computeTimeFacts({ nowMs: at("2026-11-12T09:30:00Z"), lastCustomerAtIso: "2026-11-12T08:00:00Z", lastStaffAtIso: "2026-11-11T05:00:00Z", promises: [{ label: "連絡日", ymd: "2026-11-13" }], moveInYmd: "2027-01-01" }));
t("行: 今・電話・弊社・管理会社", /今 11\/12（木）18:30/.test(line) && /電話は19時まで（今は可）/.test(line) && /弊社の営業は21時まで（今は営業中）/.test(line) && /次に開くのは11\/13（金） 9:00/.test(line), line);
t("行: 経過・期限・入居希望日が入る", /お客様が最後に送ってから 1時間30分/.test(lineFull) || /お客様が最後に送ってから 1時間/.test(lineFull), lineFull);
t("行: こちらの経過・期限・入居希望日", /こちらが最後に送ってから 1日と/.test(lineFull) && /連絡日の期限 11\/13（明日）/.test(lineFull) && /入居希望日まで あと50日/.test(lineFull), lineFull);
t("行に道の言葉が入っていない", !TIME_FACTS_FORBIDDEN_RE.test(line) && !TIME_FACTS_FORBIDDEN_RE.test(lineFull), lineFull);

// ブレインの user プロンプトへの配線（実物のソース）: off の時は空文字・on の時だけ【時間情報】の次に入る
import { readFileSync } from "node:fs";
const src = readFileSync(__dirname + "/../brain-core.ts", "utf8");
t("brain-core: TIME_FACTS が off なら空文字の式", src.includes("const timeFactsText = timeFactsEnabled() ? ") && src.includes('})() : "";'));
t("brain-core: 2か所の user プロンプトの【時間情報】の次に入る", src.split("${timingText}${timeFactsText}").length - 1 === 2);

console.log(`pass ${pass} / fail ${fail}`);
process.exit(fail ? 1 : 0);
