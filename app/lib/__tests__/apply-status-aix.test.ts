// app/lib/__tests__/apply-status-aix.test.ts — 竹内さんの指摘 #13（勇気 10/27）
//   実行: npx tsx app/lib/__tests__/apply-status-aix.test.ts
import { aixApplyStatusOn, shouldPromoteOnApplyAix, manualDraftPostApplyOn, manualDraftAllowedPostApply } from "../apply-status-aix";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

t("画面のスイッチ既定 off", !aixApplyStatusOn(undefined) && !aixApplyStatusOn("") && aixApplyStatusOn("on"));
t("申込書（フォーマット）を送った・物件提案中 → 上げる", shouldPromoteOnApplyAix("format", "proposing"));
t("申込確定・書類依頼も上げる", shouldPromoteOnApplyAix("confirm", "viewing") && shouldPromoteOnApplyAix("docs_request", "estimate_request"));
t("申込誘導（後押し）は上げない", !shouldPromoteOnApplyAix("push", "proposing"));
t("もう申込・審査中・成約は触らない", !shouldPromoteOnApplyAix("format", "applying") && !shouldPromoteOnApplyAix("format", "closed_won") && !shouldPromoteOnApplyAix("format", "closed_lost"));
t("選びが無い・状態が無いは上げない", !shouldPromoteOnApplyAix(null, "proposing") && !shouldPromoteOnApplyAix("format", null));

t("サーバのスイッチ既定 off", !manualDraftPostApplyOn({}) && manualDraftPostApplyOn({ MANUAL_DRAFT_POST_APPLY: "on" }));
t("off は手で押しても作らない", !manualDraftAllowedPostApply({ on: false, caller: "manual", state: "applying" }));
t("申込・審査中で手で押した → 作る", manualDraftAllowedPostApply({ on: true, caller: "manual", state: "applying" }) && manualDraftAllowedPostApply({ on: true, caller: "manual_hint", state: "screening" }));
t("自動（bg-async・cron）は作らない", !manualDraftAllowedPostApply({ on: true, caller: "auto", state: "applying" }) && !manualDraftAllowedPostApply({ on: true, caller: "bg_async_direct", state: "applying" }));
t("契約・成約・失注は手でも作らない", !manualDraftAllowedPostApply({ on: true, caller: "manual", state: "contract" }) && !manualDraftAllowedPostApply({ on: true, caller: "manual", state: "closed_won" }) && !manualDraftAllowedPostApply({ on: true, caller: "manual", state: "closed_lost" }));
t("申込より前の状態で申込以降と判定（申込へ押下）→ 手で押せば作る", manualDraftAllowedPostApply({ on: true, caller: "manual", state: "proposing" }));

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
