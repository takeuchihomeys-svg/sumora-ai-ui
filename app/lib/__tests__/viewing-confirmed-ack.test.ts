// 内覧が決まった後の締め＋スタンプ・了承だけ（2026-10-28 竹内さん #2 咲・#16 かずき）
// 実行: npx tsx app/lib/__tests__/viewing-confirmed-ack.test.ts
import { viewingConfirmedAckWaitEnabled, isViewingConfirmedAck, viewingConfirmedAckMaterialLine } from "../viewing-confirmed-ack";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
const CLOSE_2 = "はい😊！！\nそれでは10/24日12:00より何卒よろしくお願い致します！！";
const base = { viewingConfirmed: true, customerTurnText: "[スタンプ]", customerAckOnly: false, lastStaffText: CLOSE_2 };

it("既定 off・on で入る", () => { eq(viewingConfirmedAckWaitEnabled({}), false); eq(viewingConfirmedAckWaitEnabled({ VIEWING_CONFIRMED_ACK_WAIT: "on" }), true); });
it("#2 咲: 内覧が決まった締め → スタンプだけ ＝ この番", () => eq(isViewingConfirmedAck(base), true));
it("#16 かずき: 待ち合わせ場所の後の「よろしくお願いします🙇」（了承だけ）＝ この番", () => eq(isViewingConfirmedAck({ ...base, customerTurnText: "よろしくお願いします🙇", customerAckOnly: true, lastStaffText: "11/2(月)15:00にふぁみ〜ゆ寝屋川 現地エントランスお待ち合わせで何卒よろしくお願い致します！！" }), true));
it("内覧が決まっていない・質問がある・こちらの最後が質問・了承でない ＝ 違う", () => {
  eq(isViewingConfirmedAck({ ...base, viewingConfirmed: false }), false);
  eq(isViewingConfirmedAck({ ...base, customerTurnText: "駐車場はありますか？", customerAckOnly: false }), false);
  eq(isViewingConfirmedAck({ ...base, lastStaffText: "ご都合よろしいお時間如何でしょうか？" }), false);
  eq(isViewingConfirmedAck({ ...base, customerTurnText: "審査が不安です", customerAckOnly: false }), false);
});
it("材料の行: 締まっている・当日の挨拶まで待つ・下書きを作らない・聞かれていない話を足さない", () => {
  const t = viewingConfirmedAckMaterialLine(CLOSE_2);
  ok(/会話は締まっている/.test(t) && /当日の内覧の挨拶（AIX）まで待つ/.test(t) && /reply_mode=aix/.test(t) && /聞かれていない話を足さない/.test(t), t);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
