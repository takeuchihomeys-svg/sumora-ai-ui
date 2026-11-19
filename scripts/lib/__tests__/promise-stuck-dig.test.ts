// npx tsx scripts/lib/__tests__/promise-stuck-dig.test.ts
// 2026-11-19 作業員L: 誘導の穴 #414 の掘りの分け（作った会話・本物の文は使わない）
import assert from "node:assert/strict";
import { promiseStuckRowsOf, promiseKindOf, digSummary } from "../promise-stuck-dig";
import type { GMsg, GAix, GDecision } from "../guide-measure";

const T = (h: number) => new Date(Date.UTC(2026, 10, 1, 0, 0) + h * 36e5).toISOString();
const cust = (h: number, text: string): GMsg => ({ sender: "customer", text, created_at: T(h) });
const tk = (h: number, text: string): GMsg => ({ sender: "staff", text, created_at: T(h), staff_writer: "takeuchi", is_aix_generated: false });
const dec = (h: number, sg: string): GDecision => ({ created_at: T(h), stage: sg });

assert.equal(promiseKindOf("ご条件でピックアップさせて頂きます"), "pickup");
assert.equal(promiseKindOf("新着で出次第お送りさせて頂きます"), "new_arrival");
assert.equal(promiseKindOf("管理会社に確認させて頂きます"), "check");

// A: 約束 → お礼（果たす前）→ 5時間後に物件の AIX → 次の返事で内覧へ（測り直しで進んだ）
const msgsA: GMsg[] = [cust(0, "他にもありますか"), tk(1, "ご条件でピックアップさせて頂きます！！"), cust(2, "ありがとうございます"), cust(8, "ここ内覧したいです"), tk(9, "ご内覧のご案内させて頂きます")];
const aixA: GAix[] = [{ aix_type: "property_send", sent_at: T(6), created_at: T(6) }];
const decA = [dec(0.5, "proposing"), dec(2.5, "proposing"), dec(8.5, "viewing_arranging")];
const a = promiseStuckRowsOf("convA-xxxx", msgsA, aixA, decA, [], []);
assert.equal(a.length, 1);
assert.equal(a[0].kind, "pickup");
assert.equal(a[0].replyBeforeFulfil, "thanks");
assert.equal(a[0].fulfilHours, 5);
assert.equal(a[0].fulfilBy, "aix:property_send");
assert.equal(a[0].remeasured, "advanced");
assert.equal(a[0].bucket, "④約束待ちのお礼で窓が閉じた");

// B: 約束の時に送れる候補があった（2時間前の pending）→ ③
const b = promiseStuckRowsOf("convB-xxxx", msgsA, aixA, decA, [], [{ created_at: T(-1), expired_at: null, sent_at: null, status: "pending" }]);
assert.equal(b[0].pendingAtPromise, 1);
assert.equal(b[0].bucket, "③候補があったのに約束");

// C: 約束を果たさない（AIX も送付も無い）→ 約束を果たさず止まった
const msgsC: GMsg[] = [cust(0, "他にもありますか"), tk(1, "管理会社に確認させて頂きます！！"), cust(3, "了解です、何時頃分かりますか")];
const c = promiseStuckRowsOf("convC-xxxx", msgsC, [], [dec(0.5, "proposing"), dec(3.5, "proposing")], [], []);
assert.equal(c[0].remeasured, "not_fulfilled");
assert.equal(c[0].bucket, "約束を果たさず止まった");

// D: 前の駅が proposing でない番・同じ番に AIX がある番は数えない
assert.equal(promiseStuckRowsOf("convD", msgsA, aixA, [dec(0.5, "interested")], [], []).length, 0);
assert.equal(promiseStuckRowsOf("convE", msgsA, [{ aix_type: "property_send", sent_at: T(1.5), created_at: T(1.5) }], decA, [], []).length, 0);

const s = digSummary([...a, ...b, ...c]);
assert.equal(s.byBucket["③候補があったのに約束"], 1);
assert.equal(s.medianFulfilH, 5);
console.log("promise-stuck-dig: ok");
