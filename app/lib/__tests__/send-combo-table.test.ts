// app/lib/__tests__/send-combo-table.test.ts — 返信と AIX の組と順番の型（SEND_COMBO_TABLE）
//   実行: npx tsx app/lib/__tests__/send-combo-table.test.ts
import { pickSendCombo, routeOfMeta, sendComboRecord, sendComboMode, sendComboDigest, SEND_COMBO_ROWS } from "../send-combo-table";

let pass = 0, fail = 0;
const t = (n: string, ok: boolean) => { if (ok) pass++; else { fail++; console.error(`NG ${n}`); } };

t("既定 off は何も足さない", sendComboMode({}) === "off" && sendComboRecord({ reply_mode: "aix", action: "condition_hearing" }, { firstContact: true }, {}) === null);
t("shadow で記録", sendComboMode({ SEND_COMBO_TABLE: "shadow" }) === "shadow");
// 道は meta から読むだけ
t("道: AIX", routeOfMeta({ reply_mode: "aix", action: "estimate_sheet" }) === "aix");
t("道: 2段", routeOfMeta({ reply_mode: "auto_reply", two_stage: "check" }) === "two_stage");
t("道: 返信", routeOfMeta({ reply_mode: "auto_reply" }) === "reply" && routeOfMeta(null) === "reply");
// 型ごと
t("初回の AIX の番＝返信→数秒後の AIX（12306 の型）", pickSendCombo({ type: "T11_first_contact_hearing", route: "aix", cues: { firstContact: true } })?.combo === "reply_then_aix_quick");
t("結果が手元・悪い知らせ＝AIX→返信（代わりの物件は後）", pickSendCombo({ type: "T10_result_ready", route: "aix", cues: { resultReady: true, badNews: true } })?.order.includes("代わりの物件") === true);
t("2段＝約束の返信→後で AIX", pickSendCombo({ type: "T3_question_staff_only", route: "two_stage", cues: {} })?.combo === "promise_then_aix_later");
t("話題が2つの返信＝返信→返信", pickSendCombo({ type: "T2_question_fact", route: "reply", cues: { multiTopics: true } })?.combo === "reply_reply");
t("ふだんの返信＝1通", pickSendCombo({ type: "T6_considering", route: "reply", cues: {} })?.combo === "reply_only");
t("型の無い AIX＝AIX 1通", pickSendCombo({ type: null, route: "aix", cues: {} })?.combo === "aix_only");
// 道を決め直さない＝選んだ組は必ず道と同じ側
t("どの行も道と組の側がそろう", SEND_COMBO_ROWS.every((r) => (r.route === "reply" ? /^reply/.test(r.combo) : r.route === "two_stage" ? r.combo === "promise_then_aix_later" : /aix/.test(r.combo))));
t("どの行にもなぜと数", SEND_COMBO_ROWS.every((r) => r.why.length > 10 && r.count.length > 0));
t("どの行にも目的・足りない情報・押さえる要点", SEND_COMBO_ROWS.every((r) => r.purpose.length > 0 && r.missing.length > 0 && r.keyPoint.length > 0));
t("初回の目的と要点（竹内さんの例どおり）", pickSendCombo({ type: "T11_first_contact_hearing", route: "aix", cues: { firstContact: true } })?.purpose === "信頼を作ってから聞く" && /機械的に見せず/.test(pickSendCombo({ type: "T11_first_contact_hearing", route: "aix", cues: { firstContact: true } })?.keyPoint ?? ""));
// 記録
const rec = sendComboRecord({ reply_mode: "aix", action: "condition_hearing", check_order_type: "T11_first_contact_hearing" }, { firstContact: true }, { SEND_COMBO_TABLE: "shadow" });
t("記録: digest", rec?.digest === "rq|T11");
t("digest が無い時は null", sendComboDigest(null, "T1") === null);

// 2026-11-13 作業員7b: 場面×状態の細分（条件ヒアリングは初回でなくても・約束2つの果たしの順・持ち込みの未確認は約束）
t("条件ヒアリングは初回でなくても 返信→AIX（→案内）", pickSendCombo({ type: null, route: "aix", cues: { hearing: true } })?.combo === "reply_then_aix_quick" && /フォームの案内/.test(pickSendCombo({ type: null, route: "aix", cues: { hearing: true } })?.order ?? ""));
t("約束2つ・結果が手元 → AIX→AIX（確認の結果が先）", pickSendCombo({ type: null, route: "aix", cues: { twoOpenPromises: true, resultReady: true } })?.combo === "aix_then_aix");
t("約束が1つなら AIX→AIX にしない", pickSendCombo({ type: null, route: "aix", cues: { resultReady: true } })?.combo !== "aix_then_aix");
t("持ち込みの未確認 → 約束→後で AIX（0f475703）", /0f475703/.test(pickSendCombo({ type: null, route: "two_stage", cues: { broughtUnchecked: true } })?.why ?? ""));
t("手がかりが無ければ今まで通り", pickSendCombo({ type: null, route: "aix", cues: {} })?.combo === "aix_only" && pickSendCombo({ type: null, route: "two_stage", cues: {} })?.combo === "promise_then_aix_later");
console.log(`send-combo-table: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
