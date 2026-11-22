// npx tsx scripts/lib/__tests__/field-uptake.test.ts
// 2026-11-21 作業員L（台帳 #466）: 欄ごとの 届いた・下書きに入った の数え／記録の欄（handoffCarried・composePlanWatchOf の carried）
import assert from "node:assert/strict";
import { tallyFieldUptake, formatFieldUptake } from "../field-uptake";
import { handoffCarried, valueTokens } from "../../../app/lib/compose-sentence-plan";
import { composePlanWatchOf } from "../../../app/lib/compose-plan-watch";

assert.deepEqual(valueTokens("礼金1ヶ月・家賃71,000円"), ["1ヶ月", "71000円"]);
assert.deepEqual(valueTokens("審査の通りやすい保証会社"), ["審査", "保証会社"]);

const turns = [
  { carried: [{ key: "conductor_focus", n: 1, missing: 0, toks: ["約束"] }, { key: "our_side_note", n: 2, missing: 1, toks: ["募集状況"] }], draft: "かしこまりました！！ お送り頂きました物件の募集状況確認させて頂きます！！" },
  { carried: [{ key: "conductor_focus", n: 1, missing: 0, toks: [] }], draft: "はい！！" },
  { carried: [{ key: "conductor_focus", n: 1, missing: 1, toks: ["内覧"] }], draft: "ご都合よろしいお日にちにお部屋ご案内させて頂きます" },
];
const t = tallyFieldUptake(turns);
const f = t.find((r) => r.key === "conductor_focus")!;
assert.deepEqual({ turns: f.turns, delivered: f.delivered, inDraft: f.inDraft, measurable: f.measurable }, { turns: 3, delivered: 2, inDraft: 0, measurable: 2 });
const o = t.find((r) => r.key === "our_side_note")!;
assert.deepEqual({ turns: o.turns, delivered: o.delivered, inDraft: o.inDraft, measurable: o.measurable }, { turns: 1, delivered: 0, inDraft: 1, measurable: 1 });
assert.ok(formatFieldUptake(t, 3).includes("conductor_focus"));

// 記録の欄: 設計図が運ぶ欄の値がある時だけ・注記に無い値の数・語だけ（文は写さない）
const meta = { conductor_focus: { focus: "promise_keep" }, customer_emotion: "安心したい" };
const c = handoffCarried(meta, "【文の設計図】重点: promise_keep");
const cf = c.find((x) => x.key === "conductor_focus");
assert.ok(cf && cf.n === 1 && cf.missing === 0, JSON.stringify(c));
const ce = c.find((x) => x.key === "customer_emotion");
assert.ok(ce && ce.missing === 1 && ce.toks.includes("安心"), JSON.stringify(ce));
assert.deepEqual(handoffCarried({}, "x"), []);
const w = composePlanWatchOf({ carried: c });
assert.equal(w.carried?.length, c.length);
assert.equal(composePlanWatchOf({}).carried, undefined);
console.log("field-uptake: ok");
