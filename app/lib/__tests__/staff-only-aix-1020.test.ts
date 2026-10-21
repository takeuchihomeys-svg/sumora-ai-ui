// app/lib/__tests__/staff-only-aix-1020.test.ts — 2026-10-20 P0「AIX と返信の分け方」: 管理会社の返事待ちを確認の約束に読む（STAFF_ONLY_AIX_1020 mgmt_pending）
//   実行: npx tsx app/lib/__tests__/staff-only-aix-1020.test.ts（LLM なし・DB なし）
import { staffOnlyAix1020, findMgmtPendingSentence, stripPendingClause, reactionOnlyAfterMgmtPending } from "../staff-only-aix-1020";
import { buildActionLedger, classifyStaffTextFacts } from "../action-ledger";
import { resolveStaffPromiseAix } from "../aix-task-link";
import { negotiationPromisePending } from "../further-discount";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${info !== undefined ? `  → ${JSON.stringify(info)}` : ""}`); } };
const withEnv = <T>(v: string | undefined, fn: () => T): T => {
  const old = process.env.STAFF_ONLY_AIX_1020;
  // 10/21 から既定 on — このテストの「off（旧）」は明示の off で表す
  process.env.STAFF_ONLY_AIX_1020 = v === undefined ? "off" : v;
  try { return fn(); } finally { if (old === undefined) delete process.env.STAFF_ONLY_AIX_1020; else process.env.STAFF_ONLY_AIX_1020 = old; }
};
const split = (s: string) => s.split(/\n|(?<=[。！!？?])(?![。！!？?])/);
const kinds = (text: string) => classifyStaffTextFacts(text, "2026-10-08T10:22:00Z").map((e) => `${e.kind}/${e.status}`);

// 切り替え
t("既定は on（10/21）", staffOnlyAix1020("mgmt_pending", {}) === true && staffOnlyAix1020("mgmt_pending", { STAFF_ONLY_AIX_1020: "off" }) === false);
t("on で入る", staffOnlyAix1020("mgmt_pending", { STAFF_ONLY_AIX_1020: "on" }));
t("名指し", staffOnlyAix1020("mgmt_pending", { STAFF_ONLY_AIX_1020: "mgmt_pending" }));
t("on でも1つ止める", !staffOnlyAix1020("mgmt_pending", { STAFF_ONLY_AIX_1020: "on", STAFF_ONLY_AIX_1020_MGMT_PENDING: "off" }));

// 文の網（本番 30日のスタッフの文の形・名前は伏せた）
const PENDING = [
  "ただいま管理会社担当さんに子供のご入居が可能か確認いただいております！！",
  "現在駐輪場途中申請可能か管理会社確認中となります。",
  "こちら管理会社から連絡があり次第ご連絡させて頂きます！！",
  "駐車場、駐輪場が管理組合管轄となり、現在管理会社担当社さんに確認していただいております！！",
  "担当者よりご返答あり次第ご連絡させていただきます😊！！",
  "八尾市の南本町6丁目戸建ては現在担当者に確認中となります！！",
];
for (const s of PENDING) t(`返事待ち: ${s.slice(0, 24)}`, !!findMgmtPendingSentence([s]));
const NOT_PENDING = [
  "明日管理会社に、初回保証料の減額が可能か交渉させていただきます😊！！ 管理会社担当者よりご返事いただき次第ご連絡させていただきます",   // 交渉 → 交渉の約束の道
  "お送り頂け次第ご連絡させていただきます！！",                       // お客様の送付待ち
  "管理会社に確認させていただきましたところ、募集終了となっておりました！！",   // 報告
  "お部屋の募集状況確認させていただきます！！",                       // 普通の確認の約束（今までの網が拾う）
  "ご入力いただけましたら確認出来次第ご連絡させて頂きます",
];
for (const s of NOT_PENDING) t(`返事待ちではない: ${s.slice(0, 24)}`, !findMgmtPendingSentence(split(s)), findMgmtPendingSentence(split(s)));
t("交渉の文は交渉の約束の道が拾う（今まで通り）", negotiationPromisePending({ lastStaffText: NOT_PENDING[0], customerAckOnly: true, reportedAfter: false }));

// 報告の語に当てない（「よりご返答あり次第」）
t("待ちの句を除く（on）", withEnv("on", () => stripPendingClause("担当者よりご返答あり次第ご連絡させていただきます")) === "担当者");
t("off は文のまま", withEnv(undefined, () => stripPendingClause("担当者よりご返答あり次第ご連絡させていただきます")) === "担当者よりご返答あり次第ご連絡させていただきます");
const S1 = "Sさん お世話になっております！！\n管理会社担当者にお電話せていただきましたが不通でしたので、メッセージ残しております！！\n担当者よりご返答あり次第ご連絡させていただきます😊！！";
t("旧: 返事待ちを確認の報告（済み）に読んでいた", withEnv(undefined, () => kinds(S1)).includes("confirmation_reported/done"), withEnv(undefined, () => kinds(S1)));
t("on: 確認の約束（まだ）", withEnv("on", () => kinds(S1)).join() === "confirmation_promised/promised", withEnv("on", () => kinds(S1)));

// 同じ通に御見積書の送付（本番 2996・子供の入居可否）
const S2996 = "サンライトあべの8 202号ただいま管理会社担当さんに子供のご入居が可能か確認いただいております！！\n\n最大限割引しました御見積書同封させて頂きました！！\n\nお手隙の際にご査収ください！！";
t("旧: 見積書の送付だけ", withEnv(undefined, () => kinds(S2996)).join() === "estimate_sent/done", withEnv(undefined, () => kinds(S2996)));
t("on: 見積書の送付＋確認の約束", withEnv("on", () => kinds(S2996)).join() === "estimate_sent/done,confirmation_promised/promised", withEnv("on", () => kinds(S2996)));

// 台帳 → お客様のお礼の番に約束を果たす AIX（resolveStaffPromiseAix）
const conv = (staffText: string, ack: string) => [
  { sender: "customer", text: "サンライト阿倍野8の202は子ども不可ですか？", createdAt: "2026-10-08T10:00:00Z", isAix: false, lineMessageId: null },
  { sender: "staff", text: staffText, createdAt: "2026-10-08T10:22:00Z", isAix: false, lineMessageId: null },
  { sender: "customer", text: ack, createdAt: "2026-10-08T22:46:00Z", isAix: false, lineMessageId: null },
];
const route = (v: string | undefined, staffText: string, ack: string) => withEnv(v, () => {
  const m = conv(staffText, ack);
  const led = buildActionLedger({ recentAixRows: [], messages: m, lineTasks: [], lastAixHistory: null, lastCustomerAt: m[2].createdAt });
  const r = resolveStaffPromiseAix(led.facts, m, { customerAckAfter: true, propertyInPlay: true });
  return { r: r ? `${r.action}/${r.kind}${r.checkPattern ? `/${r.checkPattern}` : ""}` : null, last: led.facts.lastStaffEntry?.kind ?? null, open: led.facts.confirmationPromisedUnfulfilled };
});
const off2996 = route(undefined, S2996, "めちゃくちゃ安いですね！ありがとうございます！");
const on2996 = route("on", S2996, "めちゃくちゃ安いですね！ありがとうございます！");
t("2996 旧: 約束の AIX なし（返信）", off2996.r === null && off2996.open === false, off2996);
t("2996 on: 確認の約束が残り、お礼の番に約束を果たす AIX", on2996.open === true && on2996.last === "confirmation_promised" && !!on2996.r && on2996.r.startsWith("property_check_result/check"), on2996);
const SPARK = "現在駐輪場途中申請可能か管理会社確認中となります。\nこちら管理会社から連絡があり次第ご連絡させて頂きます！！\n何卒よろしくお願い致します。";
const onPark = route("on", SPARK, "ありがとうございます！");
t("駐輪場の返事待ち on: 確認した→駐車場について", onPark.r === "property_check_result/check/mgmt_parking", onPark);
t("駐輪場の返事待ち off: 何もしない", route(undefined, SPARK, "ありがとうございます！").r === null);

// 近所（変えない所）: ピックアップの約束の後のお礼（決定 C）・確認の報告の後のお礼・ふつうの確認の約束
const PICK = "かしこまりました！！\n十三周辺のエリア全域からオススメできるお部屋ピックアップさせていただきます！！";
t("ピックアップの約束は on でも同じ", JSON.stringify(route("on", PICK, "よろしくお願いします")) === JSON.stringify(route(undefined, PICK, "よろしくお願いします")));
const REP = "管理会社に確認させていただきましたところ、小学生以下のお子様のご入居は不可とのご返事でした！！";
t("確認の報告の後のお礼は on でも同じ（AIX なし）", route("on", REP, "わかりました！").r === null && route(undefined, REP, "わかりました！").r === null);
const CHK = "かしこまりました！！\nお部屋の募集状況確認させていただきます！！\n確認出来次第ご連絡させて頂きます！！";
t("ふつうの確認の約束は on でも同じ", JSON.stringify(route("on", CHK, "お願いします")) === JSON.stringify(route(undefined, CHK, "お願いします")));

// 返事待ちの約束の直後の反応だけの番（本番 2996）
const ON = { STAFF_ONLY_AIX_1020: "on" };
const rx = (text: string, pending = true, env: Record<string, string> = ON, img = false) => reactionOnlyAfterMgmtPending({ lastStaffMgmtPending: pending, customerText: text, hasImage: img, env });
t("反応だけ（on・返事待ちの後）", rx("めちゃくちゃ安いですね！\nありがとうございます！"));
t("off は当てない", !rx("めちゃくちゃ安いですね！ありがとうございます！", true, { STAFF_ONLY_AIX_1020: "off" }));
t("返事待ちでない約束の後は当てない", !rx("めちゃくちゃ安いですね！ありがとうございます！", false));
t("問いがあれば当てない", !rx("ありがとうございます！他にもありますか？"));
t("頼みがあれば当てない", !rx("ありがとうございます！内覧お願いできますか"));
t("画像があれば当てない", !rx("こちらも", true, ON, true));
t("長い文は当てない", !rx("ありがとうございます".repeat(8)));
// 反応だけの番を了承と同じに渡すと、2996 は約束を果たす AIX
const reac = withEnv("on", () => {
  const m = conv(S2996, "めちゃくちゃ安いですね！ありがとうございます！");
  const led = buildActionLedger({ recentAixRows: [], messages: m, lineTasks: [], lastAixHistory: null, lastCustomerAt: m[2].createdAt });
  const ack = rx(m[2].text, !!led.facts.lastStaffEntry?.detail?.mgmtPending);
  const r = resolveStaffPromiseAix(led.facts, m, { customerAckAfter: ack, propertyInPlay: true });
  return { ack, r: r ? `${r.action}/${r.kind}/${r.checkPattern ?? ""}` : null };
});
t("2996 on: 反応だけ → 約束を果たす AIX", reac.ack && !!reac.r?.startsWith("property_check_result/check"), reac);

// 本番の 2996 は【物件確認した】の AIX で送られていた（本文に返事待ち・送信時の記録は旧の分け方）→ AIX の行の本文から読む
const viaAix = (v: string | undefined) => withEnv(v, () => {
  const m = conv(S2996, "めちゃくちゃ安いですね！ありがとうございます！").map((x, i) => (i === 1 ? { ...x, isAix: true, lineMessageId: "L1" } : x));
  const row = { aix_type: "property_check_result", check_pattern: "available", created_at: "2026-10-08T10:22:51Z", sent_at: "2026-10-08T10:22:00Z", line_message_id: "L1", generated_text: S2996, property_names: null, estimate_sent: null, template_name: null };
  const led = buildActionLedger({ recentAixRows: [row] as never, messages: m, lineTasks: [], lastAixHistory: null, lastCustomerAt: m[2].createdAt });
  const ack = rx(m[2].text, !!led.facts.lastStaffEntry?.detail?.mgmtPending, v ? ON : {});
  const r = resolveStaffPromiseAix(led.facts, m, { customerAckAfter: ack, propertyInPlay: true });
  return { ack, last: led.facts.lastStaffEntry?.kind ?? null, r: r ? `${r.action}/${r.kind}/${r.checkPattern ?? ""}` : null };
});
const aOff = viaAix(undefined), aOn = viaAix("on");
t("2996（AIX で送った）off: 確認の報告だけ・AIX なし", aOff.last === "confirmation_reported" && aOff.r === null, aOff);
t("2996（AIX で送った）on: 返事待ちの約束 → 約束を果たす AIX", aOn.last === "confirmation_promised" && !!aOn.r?.startsWith("property_check_result/check"), aOn);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
