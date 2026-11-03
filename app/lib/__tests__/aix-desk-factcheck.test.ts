// app/lib/__tests__/aix-desk-factcheck.test.ts — 下の役の答えを事実と照らす・読み直しの口の形（2026-11-03）
//   実行: npx tsx app/lib/__tests__/aix-desk-factcheck.test.ts
import { deskFactConflict, recheckFromDesk, recheckFromConsult, recheckDigest } from "../aix-commander";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, v?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, JSON.stringify(v)); } };
const none = { sentProperties: 0, needCheck: false, confirmed: false, viewingStage: null };
t("見積書なのに物件の記録が無い", !!deskFactConflict("estimate_sheet/single", none));
t("見積書・持ち込みがあれば合う", deskFactConflict("estimate_sheet/single", { ...none, needCheck: true }) === null);
t("待ち合わせなのに日が決まっていない", !!deskFactConflict("meeting_place", { ...none, sentProperties: 3, viewingStage: "proposing" }));
t("待ち合わせ・日にち決定なら合う", deskFactConflict("meeting_place", { ...none, viewingStage: "date_agreed" }) === null);
t("物件確認した・確かめる物件が無い", !!deskFactConflict("property_check_result/available", none));
t("物件確認した（条件のピッカー）は物件の数を見ない", deskFactConflict("property_check_result/mgmt_parking", none) === null);
const base = { pick: "viewing_invite/通常", sb: null, changed: true, why: "日時なし", brain: "meeting_place" };
t("ブレインと違う → aix の読み直し", JSON.stringify(recheckFromDesk(base)) === '{"from":"aix_desk","kind":"aix","key":"viewing_invite/通常","why":"日時なし","firstAix":"meeting_place"}', recheckFromDesk(base));
t("差し戻し promise", recheckFromDesk({ ...base, sb: "promise", changed: false })?.kind === "promise");
t("事実と合わない → reread", recheckFromDesk({ ...base, conflict: "日が決まっていない" })?.kind === "reread");
t("同じなら読み直さない", recheckFromDesk({ ...base, changed: false }) === null);
t("相談 keep は読み直さない", recheckFromConsult({ answer: "keep", key: null, note: "" }) === null && recheckDigest(null, "keep") === "keep");
t("相談 aix", recheckFromConsult({ answer: "aix", key: "estimate_sheet/single", note: "x" })?.from === "aix_consult" && recheckDigest(recheckFromConsult({ answer: "aix", key: "estimate_sheet/single", note: "x" })) === "aix:estimate_sheet/single");
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
