// app/lib/__tests__/two-choice-promise-or-now.test.ts — 「約束の返信／その場の AIX」の2択（TWO_CHOICE_PROMISE_OR_NOW）
import { resolvePromiseOrNow, twoChoicePromiseOrNowOn } from "../two-choice";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
const base = { finalAix: null, decisionSource: null, firstContact: false, postApply: false, alreadyTwo: false };
t("既定 on・off で戻る", twoChoicePromiseOrNowOn({}) === true && twoChoicePromiseOrNowOn({ TWO_CHOICE_PROMISE_OR_NOW: "off" }) === false && twoChoicePromiseOrNowOn({ TWO_CHOICE_PROMISE_OR_NOW: "on" }));
const a = resolvePromiseOrNow({ ...base, twoStageKind: "check", customerText: "堺筋本町 2LDK 7階\nhttps://suumo.jp/chintai/bc_1/\nby SUUMO\n空きありますか？" });
t("物件を送ってきた・確認の約束 → 左に物件確認した（募集中）", a?.aix === "property_check_result" && a?.checkPattern === "available" && a?.label === "確認の約束", a);
const b = resolvePromiseOrNow({ ...base, twoStageKind: "estimate", customerText: "初期費用いくらですか？" });
t("費用の質問・見積の約束 → 左に見積書送る", b?.aix === "estimate_sheet" && b?.label === "見積の約束", b);
t("ピックアップの約束は2択にしない（10/29・今は物件の AIX を送らない番）", resolvePromiseOrNow({ ...base, twoStageKind: "pickup", customerText: "他にもあれば送ってください" }) === null);
t("確認の約束でも、物件・費用・開いている約束が無い番は出さない", resolvePromiseOrNow({ ...base, twoStageKind: "check", customerText: "了解です" }) === null);
t("開いている確認の約束を果たす番は出す", resolvePromiseOrNow({ ...base, twoStageKind: "check", decisionSource: "promise:check", customerText: "お願いします" })?.aix === "property_check_result");
t("初回は出さない", resolvePromiseOrNow({ ...base, twoStageKind: "check", customerText: "https://suumo.jp/x", firstContact: true }) === null);
t("申込以降は出さない", resolvePromiseOrNow({ ...base, twoStageKind: "check", customerText: "https://suumo.jp/x", postApply: true }) === null);
t("既に別の2択なら出さない", resolvePromiseOrNow({ ...base, twoStageKind: "check", customerText: "https://suumo.jp/x", alreadyTwo: true }) === null);
t("その場の AIX の番は今は出さない（右の約束の下書きの道が無い）", resolvePromiseOrNow({ ...base, finalAix: "property_send", twoStageKind: null, customerText: "他にありますか" }) === null);
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
