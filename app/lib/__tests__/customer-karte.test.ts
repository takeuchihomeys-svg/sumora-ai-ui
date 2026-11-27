// 2026-11-27 作業員L（台帳 #806 お客様のカルテ・既定 off）
// 実行: npx tsx app/lib/__tests__/customer-karte.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { karteOf, karteBlock, customerKarteOn } from "../customer-karte";
import { SWITCH_TARGET_MARK } from "../../../scripts/lib/exam-snapshot-need";

const now = "2026-11-27T03:00:00Z";
const msgs = [
  { sender: "staff", text: "物件をお送り致します", created_at: "2026-11-25T01:00:00Z" },
  { sender: "customer", text: "ありがとうございます、主人と相談します", created_at: "2026-11-25T01:20:00Z" },
  { sender: "staff", text: "承知致しました", created_at: "2026-11-25T02:00:00Z" },
  { sender: "customer", text: "初期費用はもう少し安くなりますか", created_at: "2026-11-25T02:10:00Z" },
  { sender: "customer", text: "主人に確認してまたご連絡します", created_at: "2026-11-25T05:00:00Z" },
];
assert.equal(customerKarteOn({}), false, "既定 off");
const k = karteOf({ pc: { desired_area: "本町", floor_plan: "1LDK", rent_max: 90000, ng_points: "1階は不可", initial_cost_limit: 300000 }, msgs, nowIso: now });
assert.equal(k.priorities, "本町・1LDK・家賃 9万まで");
assert.equal(k.noGo, "1階は不可");
assert.equal(k.decider, "主人と相談して決める（2回）");
assert.match(k.replySpeed ?? "", /すぐ返す（中央 \d+分）/);
assert.match(k.wording ?? "", /^丁寧/);
assert.match(k.cost ?? "", /初期費用は 30万まで・費用の話 1回/);
const b = karteBlock(k);
assert.match(b, /^【お客様のカルテ（記録と会話から・事実だけ）】\n- 優先する条件: /);
// 審査の事情の欄は落とす・個人情報は伏せる
const k2 = karteOf({ pc: { preferences: "去年出所しました", ng_points: "電話 090-1234-5678 まで" }, msgs: [], nowIso: now });
assert.equal(k2.priorities, null, "審査の事情は入れない");
assert.deepEqual(k2.dropped, ["優先する条件"]);
assert.ok(!String(k2.noGo).includes("090-1234-5678"), "電話は伏せる");
assert.equal(karteBlock(karteOf({ pc: null, msgs: [], nowIso: now })), "", "何も無ければ空");
assert.equal(SWITCH_TARGET_MARK.CUSTOMER_KARTE, "customer_karte", "印の決まり");
const core = readFileSync(join(__dirname, "../brain-core.ts"), "utf8");
assert.ok(/ck\.customerKarteOn\(\) && !isPostApplyStatus\(convStatus\)/.test(core) && core.includes("materialMarks.customer_karte = karteMarkLen"), "配線・申込以降は出さない・印");
console.log("customer-karte ok 15");
