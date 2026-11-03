// app/lib/__tests__/staff-reason.test.ts — スタッフの理由のワンタップを出す番
//   実行: npx tsx app/lib/__tests__/staff-reason.test.ts
import { shouldAskStaffReason, isStaffReasonKey, staffReasonTapOn, STAFF_REASONS } from "../staff-reason";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
t("下書きを直して送った時は聞く", shouldAskStaffReason({ outcome: "draft_modified", originalDraft: "x" }));
t("下書きのまま送った時は聞かない", !shouldAskStaffReason({ outcome: "draft_followed", originalDraft: "x" }));
t("下書きがあったのに手で打った時は聞く", shouldAskStaffReason({ outcome: "manual", originalDraft: "下書き" }));
t("下書きが無い手打ちは聞かない", !shouldAskStaffReason({ outcome: "manual", originalDraft: " " }));
t("結果が無い時は聞かない", !shouldAskStaffReason({ outcome: null, originalDraft: "x" }));
t("選択肢は4つ・P0 の3つ＋言い回し", STAFF_REASONS.map((r) => r.key).join(",") === "staff_only,material,scene,wording");
t("鍵の確かめ", isStaffReasonKey("scene") && !isStaffReasonKey("other"));
t("既定 off", !staffReasonTapOn(undefined) && staffReasonTapOn("on"));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
