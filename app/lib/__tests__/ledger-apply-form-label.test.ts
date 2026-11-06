import { ledgerKindJa, APPLY_FORM_TEXT_RE } from "../action-ledger";

let fail = 0;
const ok = (c: boolean, m: string) => { if (!c) { fail++; console.error("NG", m); } else console.log("ok", m); };
const e = { kind: "application_guided" as const, detail: { applyForm: true } };
delete process.env.LEDGER_APPLY_FORM_LABEL;
ok(ledgerKindJa(e) === "申込打診", "既定 off は今の名前のまま");
process.env.LEDGER_APPLY_FORM_LABEL = "on";
ok(ledgerKindJa(e) === "申込のフォーマット送付（記入のお願い）", "on でフォーマット送付の名前");
ok(ledgerKindJa({ kind: "application_guided", detail: {} }) === "申込打診", "on でもフォーマットでない申込の勧めは今の名前");
ok(APPLY_FORM_TEXT_RE.test("【お申込者様記入欄】\n・入居希望日"), "記入欄の本文を当てる");
delete process.env.LEDGER_APPLY_FORM_LABEL;
if (fail) { console.error(`${fail} 件 NG`); process.exit(1); }
console.log("ledger-apply-form-label: 全部 ok");
