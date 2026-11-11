// app/lib/__tests__/turn-application-gate.test.ts — 過去の番が申込の手前か（npx tsx で回す）
import { turnApplicationReason, type TurnApplicationRecords } from "../turn-application-gate";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
const base = (o: Partial<TurnApplicationRecords> = {}): TurnApplicationRecords => ({ status: "proposing", isPostApply: false, records: [], backAt: null, unreadable: false, ...o });
const rec = (kind: string, first: string, last = first) => ({ kind, first, last });

t("記録なし・申込前の status は残す", turnApplicationReason(base(), "2026-10-01T00:00:00Z") === null);
t("読めなければ外す", turnApplicationReason(base({ unreadable: true }), "2026-10-01T00:00:00Z") !== null && turnApplicationReason(null, "2026-10-01T00:00:00Z") !== null);
t("申込へ押下の後の番は外す", /申込へ押下/.test(turnApplicationReason(base({ records: [rec("申込へ押下", "2026-09-30T00:00:00Z")] }), "2026-10-01T00:00:00Z") ?? ""));
t("最初の記録より前の番は残す（今が申込中でも）", turnApplicationReason(base({ status: "applying", records: [rec("申込へ押下", "2026-10-05T00:00:00Z")] }), "2026-10-01T00:00:00Z") === null);
t("記録の時刻が無く今が申込以降は外す", turnApplicationReason(base({ status: "applying" }), "2026-10-01T00:00:00Z") !== null);
t("印だけで時刻が無い時も外す", turnApplicationReason(base({ isPostApply: true }), "2026-10-01T00:00:00Z") !== null);
const moved = base({ records: [rec("証明書類", "2026-09-20T00:00:00Z", "2026-09-22T00:00:00Z")], backAt: "2026-09-25T00:00:00Z" });
t("全部の記録の後に戻し、その後の番は残す（否決→物件提案中）", turnApplicationReason(moved, "2026-10-01T00:00:00Z") === null);
t("戻す前の番は外す", turnApplicationReason(moved, "2026-09-24T00:00:00Z") !== null);
t("戻した後にまた申込の記録があれば、その前の戻しでは残さない", turnApplicationReason(base({ records: [rec("申込へ押下", "2026-09-20T00:00:00Z", "2026-10-10T00:00:00Z")], backAt: "2026-09-25T00:00:00Z" }), "2026-10-01T00:00:00Z") !== null);
t("時刻が読めない記録は外す", turnApplicationReason(base({ records: [rec("申込へ押下", "x")] }), "2026-10-01T00:00:00Z") !== null);

t("記録が無く戻した印だけ: 戻す前の番は外す・後は残す（8590144d の形）", turnApplicationReason(base({ status: "proposing", backAt: "2026-09-26T08:04:57Z" }), "2026-09-22T13:12:39Z") !== null && turnApplicationReason(base({ status: "proposing", backAt: "2026-09-26T08:04:57Z" }), "2026-10-01T00:00:00Z") === null);
console.log(`turn-application-gate: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
