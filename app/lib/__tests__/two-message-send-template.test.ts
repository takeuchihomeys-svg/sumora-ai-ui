// 物件を送る AIX の続きの通（TWO_MESSAGE_SEND_TEMPLATE・既定 off・作業員M 2026-11-18・組の表 AIX → 返信）
// 実行: npx tsx app/lib/__tests__/two-message-send-template.test.ts
import { planMessages, twoMessageSendTemplateOn, afterAixTemplateShape, afterAixReplyBrief, afterAixDraftHint } from "../two-message-plan";
let passed = 0, failed = 0;
const t = (name: string, ok: boolean, extra?: unknown) => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`, extra ?? ""); } };
const withEnv = <T>(v: string | undefined, f: () => T): T => { const o = process.env.TWO_MESSAGE_SEND_TEMPLATE; if (v === undefined) delete process.env.TWO_MESSAGE_SEND_TEMPLATE; else process.env.TWO_MESSAGE_SEND_TEMPLATE = v; try { return f(); } finally { if (o === undefined) delete process.env.TWO_MESSAGE_SEND_TEMPLATE; else process.env.TWO_MESSAGE_SEND_TEMPLATE = o; } };

t("既定 off", twoMessageSendTemplateOn({}) === false && twoMessageSendTemplateOn({ TWO_MESSAGE_SEND_TEMPLATE: "on" }) === true);
const asks = [{ quote: "ミナミ周辺で探してほしい", route: "aix", aix: "property_send", about: "search_condition", kind: "request" }];
const off = withEnv(undefined, () => planMessages({ asks, finalAix: "property_send" }));
t("off: 物件を送る AIX は1通（今と同じ）", off.shape === "A", off.shape);
const on = withEnv("on", () => planMessages({ asks, finalAix: "property_send" }));
t("on: AIX の続きの席（AT）", on.shape === "AT" && on.messages[1].slot === "aix_template" && on.messages[1].aix === "property_send", on.messages);
t("形: 物件を送る＝一押し1件と案内", /お部屋の中でも/.test(afterAixTemplateShape("property_send/x") ?? "") && /ご案内/.test(afterAixTemplateShape("property_send") ?? ""));
t("形: 見積書＝最大限割引とご査収（保証会社は言わない）", /最大限割引/.test(afterAixTemplateShape("estimate_sheet") ?? "") && /ご査収/.test(afterAixTemplateShape("estimate_sheet") ?? "") && !/保証会社/.test(afterAixTemplateShape("estimate_sheet") ?? ""));
t("形: 分からない種類は null", afterAixTemplateShape("viewing_invite") === null);
// 下書きの指示: テンプレートの席の下書き（TWO_MESSAGE_AFTER_AIX_T_DRAFT=on）で、on の時は種類ごとの形
const brief = afterAixReplyBrief(on, "property_send", asks, { TWO_MESSAGE_AFTER_AIX_T_DRAFT: "on" });
t("続きの通の下書きの席がある", !!brief && brief.template === true, brief);
const hOn = withEnv("on", () => afterAixDraftHint(brief, "property_send"));
const hOff = withEnv(undefined, () => afterAixDraftHint(brief, "property_send"));
t("on: 指示は物件を送る形", /お部屋の中でも特に/.test(hOn) && /何件も送った時だけ/.test(hOn), hOn);
t("off: 指示は今と同じ（見積の形も並ぶ）", /御見積書となります/.test(hOff) && !/何件も送った時だけ/.test(hOff), hOff);
console.log(`\ntwo-message-send-template: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
