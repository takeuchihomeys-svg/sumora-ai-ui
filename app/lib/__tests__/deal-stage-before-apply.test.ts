// 台帳 #742（作業員L 11/25）: 申込の後に付いた段の時刻のずれを直す（DEAL_STAGE_BEFORE_APPLY・既定 off）
import assert from "node:assert/strict";
import { resolveDealOutcomes, stageBeforeApplyEnabled, type DealInput } from "../deal-outcome";

const J = (s: string) => new Date(`${s}+09:00`).toISOString();
const base = (o: Partial<DealInput>): DealInput => ({
  conversationId: "c1", nowMs: Date.parse(J("2026-10-20T12:00:00")), status: "applying", lineStatus: "active", createdAt: J("2026-10-01T10:00:00"), updatedAt: J("2026-10-10T10:00:00"),
  statusManualBackAt: null, isPostApply: true, screeningLastStatus: null, messages: [], firstMessageAt: J("2026-10-01T10:00:00"), viewings: [], clues: [],
  stageHistory: [{ from_status: "proposing", to_status: "applying", changed_at: J("2026-10-05T15:00:00"), trigger: "manual" }],
  propertySentAts: [J("2026-10-08T10:00:00")], conditionAts: [J("2026-10-05T15:05:00"), J("2026-10-28T10:00:00")], ...o,
});
assert.equal(stageBeforeApplyEnabled({}), true);
assert.equal(stageBeforeApplyEnabled({ DEAL_STAGE_BEFORE_APPLY: "off" }), false);
assert.equal(stageBeforeApplyEnabled({ DEAL_STAGE_BEFORE_APPLY: "on" }), true);

// off: 今と同じ（申込の後の物件送り・条件が段の時刻になる）
const off = resolveDealOutcomes(base({}))[0];
assert.equal(off.stageAt.applied, J("2026-10-05T15:00:00"));
assert.equal(off.stageAt.property_sent, J("2026-10-08T10:00:00"));
assert.equal(off.stageAt.condition, J("2026-10-05T15:05:00"));
assert.equal(off.postApplyStageAt, undefined);

// on: ① 申込の後の物件送り・条件は段にせず postApplyStageAt へ ② 申込の前後10分の条件は数えない
const on = resolveDealOutcomes(base({ stageBeforeApply: true }))[0];
assert.equal(on.stageAt.property_sent, undefined);
assert.equal(on.stageAt.condition, undefined);
assert.equal(on.postApplyStageAt?.property_sent, J("2026-10-08T10:00:00"));
assert.equal(on.postApplyStageAt?.condition, J("2026-10-05T15:05:00"));
// 申込の前の条件・物件送りはそのまま
const on2 = resolveDealOutcomes(base({ stageBeforeApply: true, conditionAts: [J("2026-10-02T10:00:00")], propertySentAts: [J("2026-10-03T10:00:00"), J("2026-10-08T10:00:00")] }))[0];
assert.equal(on2.stageAt.condition, J("2026-10-02T10:00:00"));
assert.equal(on2.stageAt.property_sent, J("2026-10-03T10:00:00"));
// ③ 同じ日に内覧して申込（内覧の 20:00 の仮の時刻が申込より後）→ 内覧した は申込の1分前
const v = resolveDealOutcomes(base({ stageBeforeApply: true, viewings: [{ ymd: "2026-10-05", status: "done", thankedAt: null, name: null }] }))[0];
assert.equal(v.stageAt.viewing_held, J("2026-10-05T14:59:00"));
assert.ok(Date.parse(v.stageAt.viewing!) <= Date.parse(v.stageAt.viewing_held!));
// ④ 申込の1日以上後の内覧（先行申込）はそのまま
const late = resolveDealOutcomes(base({ stageBeforeApply: true, viewings: [{ ymd: "2026-10-09", status: "done", thankedAt: null, name: null }] }))[0];
assert.equal(late.stageAt.viewing_held, J("2026-10-09T20:00:00"));
console.log("deal-stage-before-apply ok 16");
