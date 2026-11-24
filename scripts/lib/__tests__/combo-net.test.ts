// 返信と AIX の組の本当の一致（scripts/lib/combo-net.ts）
// 実行: npx tsx scripts/lib/__tests__/combo-net.test.ts（全 PASS で exit 0）
import { comboNetOf, comboNetMarkOf, type ComboNetTurn , comboRealKindOf } from "../combo-net";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };
const T = (o: Partial<ComboNetTurn>): ComboNetTurn => ({ conv: "c0000000", at: "2026-11-09T07:36:00Z", matched: true, brain: "reply_only", takeuchi: "reply_only", device: true, ...o });

// 11/23 の 14日の外れ 5番の形（12一致＋外れ5）
const turns: ComboNetTurn[] = [
  ...Array.from({ length: 12 }, (_, i) => T({ conv: `ok${i}` })),
  T({ conv: "6c9dd6b7", matched: false, brain: "promise_then_aix_later", takeuchi: "reply_only" }), // 2段の一致
  T({ conv: "b37b3859", matched: false, brain: "promise_then_aix_later", takeuchi: "reply_only" }), // 2段の一致
  T({ conv: "2d7548d5", matched: false, brain: "promise_then_aix_later", takeuchi: "aix_then_reply", mark: "split" }),
  T({ conv: "0330a81a", matched: false, brain: "reply_only", takeuchi: "aix_then_reply", mark: "decided" }),
  T({ conv: "615499ba", matched: false, brain: "aix_only", takeuchi: "reply_only" }), // 本当の外れ
];
const r = comboNetOf(turns);
ok("11/23 の形: 本当の一致 14/15（2段の一致 2 を一致に・割れと決定を分母から外す）", r.same === 14 && r.n === 15 && r.rate === 93.3 && r.twoStageFirst === 2, r);
ok("外した数", r.excluded.split === 1 && r.excluded.decided === 1 && r.excluded.writer === 0 && r.excluded.timed === 0);
ok("本当の外れは 615499ba だけ", r.real.length === 1 && r.real[0].conv === "615499ba");
ok("端末で竹内さん本人でない番は分母から外す", comboNetOf([T({ device: false }), T({})]).n === 1 && comboNetOf([T({ device: false })]).excluded.writer === 1);
ok("時刻で送る物（竹内さんの最初の AIX が当日のご挨拶）の外れは分母から外す", comboNetOf([T({ matched: false, brain: "reply_only", takeuchi: "aix_only", firstAixKind: "greeting_viewing/before" })]).excluded.timed === 1);
ok("当日のご挨拶でも一致の番はそのまま一致", comboNetOf([T({ matched: true, firstAixKind: "greeting_viewing" })]).same === 1);
ok("逆向きの2段（ブレインは返信だけ・竹内さんは2段）は一致にしない", comboNetOf([T({ matched: false, brain: "reply_only", takeuchi: "promise_then_aix_later" })]).real.length === 1);
ok("空は rate null", comboNetOf([]).rate === null);
// 印の当て方
const spec = [{ conv: "0330a81a-6aa0", at: "2026-11-09T10:28:56.000Z", why: "11/21 竹内さんの決定（統括役が q439 を見せた）" }, { conv: "aaaaaaaa-1", at: "2026-11-09T10:28:56.000Z", why: "実送信" }];
ok("決定で改めた番（±2分）", comboNetMarkOf({ conv: "0330a81a", at: "2026-11-09T10:29:30Z" }, spec) === "decided");
ok("why に決定が無い問題は印なし", comboNetMarkOf({ conv: "aaaaaaaa", at: "2026-11-09T10:28:56Z" }, spec) === null);
ok("2分より離れた番は印なし", comboNetMarkOf({ conv: "0330a81a", at: "2026-11-09T10:40:00Z" }, spec) === null);
ok("割れ・少数側は地図の印から（分単位の時刻も読む）", comboNetMarkOf({ conv: "2d7548d5", at: "2026-11-09T07:52:30Z" }, [], [{ conv: "2d7548d5", at: "2026-11-09T07:52", side: "split" }]) === "split"
  && comboNetMarkOf({ conv: "2d7548d5", at: "2026-11-09T07:52:30Z" }, [], [{ conv: "2d7548d5", at: "2026-11-09T07:52", side: "n_short" }]) === null);

// 2026-11-24 作業員A: 本当の外れの分け
if (comboRealKindOf("aix_then_reply", "reply_then_aix_quick") !== "order") throw new Error("並び");
if (comboRealKindOf("reply_only", "aix_only") !== "order" && comboRealKindOf("reply_only", "aix_then_reply") !== "shape") throw new Error("組の形");
if (comboRealKindOf("promise_then_aix_later", "reply_then_aix_quick") !== "counting" || comboRealKindOf(null, "reply_only") !== "counting") throw new Error("数え方");
console.log(`combo-net: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
