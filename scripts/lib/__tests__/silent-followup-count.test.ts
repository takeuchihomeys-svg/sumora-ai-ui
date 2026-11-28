// scripts/lib/silent-followup-count.ts（#805 の追いの行の数え）
// 実行: npx tsx scripts/lib/__tests__/silent-followup-count.test.ts
import assert from "node:assert/strict";
import { silentEpisodesOf } from "../silent-followup-count";

const H = 3600_000;
const T0 = Date.parse("2026-11-20T00:00:00Z");
const at = (h: number) => new Date(T0 + h * H).toISOString();
const C = (h: number, text = "ありがとうございます") => ({ sender: "customer", text, created_at: at(h) });
const S = (h: number, text = "こちらのお部屋如何でしょうか！！", w: string | null = "employee", aix = false) => ({ sender: "staff", text, created_at: at(h), staff_writer: w, is_aix_generated: aix });

// 行が出ている間に竹内さんが AIX で追い、お客様が戻った
let e = silentEpisodesOf([C(0), S(1), S(30, "🌟新着", "takeuchi", true), C(40)], T0 + 100 * H);
assert.equal(e.length, 1);
assert.equal(e[0].outcome, "followed_in_window");
assert.equal(e[0].followWriter, "takeuchi");
assert.equal(e[0].backAfterFollow, true);
// 24時間の内に次の通がある＝その通からは行は出ない（止まりは最後の S(10) から数える）
e = silentEpisodesOf([C(0), S(1), S(10)], T0 + 100 * H);
assert.equal(e.length, 1);
assert.equal(e[0].lastOursAt, at(10));
// 前のこちらの通が約束＝行は出ない（約束を果たすのはお約束の行）
assert.equal(silentEpisodesOf([C(0), S(1, "確認出来次第ご連絡させて頂きます！！")], T0 + 100 * H).length, 0);
// 窓（49時間）にお客様の通が無い＝ずっと前から止まっている
assert.equal(silentEpisodesOf([C(0), S(30)], T0 + 100 * H).length, 0);
// 追いの前にお客様が戻った・48時間より後に追った・誰も送らなかった・まだ窓の中
assert.equal(silentEpisodesOf([C(0), S(1), C(30)], T0 + 100 * H)[0].outcome, "customer_back_first");
assert.equal(silentEpisodesOf([C(0), S(1), S(60)], T0 + 100 * H)[0].outcome, "followed_late");
assert.equal(silentEpisodesOf([C(0), S(1)], T0 + 100 * H)[0].outcome, "none_after_window");
assert.equal(silentEpisodesOf([C(0), S(1)], T0 + 30 * H)[0].outcome, "open_in_window");
// まだ24時間たっていない
assert.equal(silentEpisodesOf([C(0), S(1)], T0 + 10 * H).length, 0);
console.log("silent-followup-count: PASS");
