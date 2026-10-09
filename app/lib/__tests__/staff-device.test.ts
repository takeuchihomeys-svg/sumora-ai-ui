// 2026-10-08 竹内さんの決定11「管理者とスタッフにする」: 端末の印の表示と、印を選ぶ欄を出すかどうか
// 実行: npx tsx app/lib/__tests__/staff-device.test.ts（全 PASS で exit 0）
import { deviceWriterLabel, parseDeviceWriter, shouldAskDeviceWriter, DEVICE_WRITER_JA } from "../staff-device";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

it("表示は 管理者（竹内さん）／スタッフ（従業員）・中の値は takeuchi／employee のまま", () => {
  eq(DEVICE_WRITER_JA.takeuchi, "管理者（竹内さん）");
  eq(DEVICE_WRITER_JA.employee, "スタッフ（従業員）");
  eq(deviceWriterLabel("takeuchi"), "管理者（竹内さん）");
  eq(deviceWriterLabel(null), "未設定");
  eq(parseDeviceWriter("admin"), null);
});
const now = Date.parse("2026-10-08T10:00:00Z");
it("印が無い端末だけ聞く", () => {
  eq(shouldAskDeviceWriter({ deviceId: "abcdefgh12", writer: null, nowMs: now }), true);
  eq(shouldAskDeviceWriter({ deviceId: "abcdefgh12", writer: "employee", nowMs: now }), false);
  eq(shouldAskDeviceWriter({ deviceId: null, writer: null, nowMs: now }), false);
});
it("「後で」は12時間出さない・戻すスイッチ", () => {
  eq(shouldAskDeviceWriter({ deviceId: "abcdefgh12", writer: null, dismissedAt: "2026-10-08T01:00:00Z", nowMs: now }), false);
  eq(shouldAskDeviceWriter({ deviceId: "abcdefgh12", writer: null, dismissedAt: "2026-10-07T20:00:00Z", nowMs: now }), true);
  eq(shouldAskDeviceWriter({ deviceId: "abcdefgh12", writer: null, nowMs: now, envFlag: "off" }), false);
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
