// npx tsx scripts/lib/__tests__/foundation-holes-345.test.ts
// 2026-11-21 作業員N2（台帳 #505・穴の型③〜⑤）: 読む窓・数え方を照らした日・主な道の外 の決め
import assert from "node:assert/strict";
import { windowMissOf, isWindowGap, READ_WINDOWS, type WinCase } from "../read-windows";
import { unitOf, unitsOf, unverifiedOf, familyOf, countGapsForLedger } from "../count-verified";
import { liveOwnerOf } from "../found-gap-ledger";
import { eventsWithoutRecord, isOffPathGap, isConfirmedViewingEvent } from "../../check-off-path";

const DAY = 86_400_000;
const now = Date.parse("2026-11-21T03:00:00Z");
const base = (over: Partial<WinCase>): WinCase => ({ conv: "abcdef0123456789", atMs: now, msgs: [], total: 0, cpAt: null, sentProps: 0, sharedProps: 0, calendar60: 0, pickupsOld: 0, pickups60: 0, estimates: 0, ...over });
const o = { brainWindow: 20, timelineWide: false, sentPropsLimit: 20 };

// ③ 窓: 20通の窓より前に「12月1日」（まだ先）・窓の中は店の発言だけ
const staff = Array.from({ length: 20 }, (_, i) => ({ sender: "staff", text: "了解です", atMs: now - i * 60_000 }));
const old = { sender: "customer", text: "入居は12月1日でお願いします", atMs: now - 14 * DAY };
const past = { sender: "customer", text: "11月1日に見ました", atMs: now - 20 * DAY };
const c1 = base({ msgs: [...staff, old], total: 21, cpAt: 21 });
const c2 = base({ conv: "zzzzzzzz99", msgs: [...staff, past], total: 21, cpAt: null, sentProps: 25 });
const m = windowMissOf([c1, c2], o);
const tl = m.find((x) => x.id === "timeline.customer")!;
assert.equal(tl.outside, 1, "まだ先の言葉が窓の外にある会話だけ");
assert.deepEqual(tl.convs, ["abcdef01"], "会話は頭8字だけ");
// WIDE=on なら40通の中なので窓の外ではない
assert.equal(windowMissOf([c1], { ...o, timelineWide: true }).find((x) => x.id === "timeline.customer")!.outside, 0);
// ブレインの窓: セーブの位置から窓までのこぼれ（c1 はセーブ 21＝こぼれ無し・c2 はセーブ無し 21通＞20）
const bm = m.find((x) => x.id === "brain.msg")!;
assert.equal(bm.outside, 1);
assert.equal(m.find((x) => x.id === "sent_props")!.outside, 1);
assert.equal(m.find((x) => x.id === "sent_props")!.rate, 50);
assert.equal(windowMissOf([c2], { brainWindow: 20, timelineWide: false }).find((x) => x.id === "sent_props")!.outside, 0, "既定（SENT_PROPS_FULL=count）は80件まで読む");
assert.equal(isWindowGap(tl), false, "1会話だけは穴にしない（2会話以上）");
assert.equal(isWindowGap({ ...tl, outside: 2, rate: 10 }), true);
assert.equal(READ_WINDOWS.length, new Set(READ_WINDOWS.map((w) => w.id)).size, "窓の id は重ならない");

// ④ 数え方を照らした日
assert.equal(familyOf("core:window_miss:brain.msg"), "core:window_miss");
assert.equal(unitOf("core:window_miss:brain.msg", "scripts/self-improve.ts --only=core")!.key, "scripts/check-windows.ts");
assert.equal(unitOf("reply_match", "scripts/self-improve.ts")!.key, "scripts/self-improve.ts#reply_match");
assert.equal(unitOf("reply_match", "line-watch-eval")!.key, "app/api/cron/line-watch-eval/route.ts");
assert.equal(unitOf("found:scene_rule_gap", "scripts/self-improve.ts")!.key, "scripts/foundation-fill.ts");
assert.equal(unitOf("check_gaps:unread", "scripts/self-improve.ts")!.key, "scripts/owner-feedback-check.ts");
assert.equal(unitOf("image_fill:sent:check:rent", "scripts/image-field-fill-daily.ts")!.owner, "作業員G");
const units = unitsOf([{ metric: "image_fill:a", source: "scripts/image-field-fill-daily.ts" }, { metric: "image_fill:b", source: "scripts/image-field-fill-daily.ts" }, { metric: "reply_match", source: "scripts/self-improve.ts" }, { metric: "count_verified", source: "x" }], [{ script: "scripts/audit-x.ts", owner: "作業員L", metric: "x:y" }]);
assert.equal(units.length, 3, "count_verified の行は単位にしない");
assert.equal(units.find((u) => u.key === "scripts/image-field-fill-daily.ts")!.metrics.length, 2);
const lc = (s: string) => (s === "scripts/image-field-fill-daily.ts" ? "2026-11-21" : "2026-11-01");
const uv = unverifiedOf(units, [
  { scope: "scripts/image-field-fill-daily.ts", day: "2026-11-20", value: 1 }, // 照らした後に台本が変わった
  { scope: "scripts/audit-x.ts", day: "2026-11-10", value: 1 }, { scope: "scripts/audit-x.ts", day: "2026-11-15", value: 0 }, // 最後はズレ
  { scope: "scripts/self-improve.ts#reply_match", day: "2026-10-01", value: 1 }, // 30日を超えた
], lc, "2026-11-21");
assert.deepEqual(Object.fromEntries(uv.map((u) => [u.key, u.kind])), { "scripts/audit-x.ts": "mismatch", "scripts/image-field-fill-daily.ts": "changed", "scripts/self-improve.ts#reply_match": "old" });
assert.equal(unverifiedOf(units, [{ scope: "scripts/audit-x.ts", day: "2026-11-02", value: 1 }], lc, "2026-11-21").find((u) => u.key === "scripts/audit-x.ts"), undefined, "変わる前より後に照らした＝穴でない");
assert.equal(unverifiedOf(units, [], lc, "2026-11-21").every((u) => u.kind === "never"), true);

const lg = countGapsForLedger([...unverifiedOf(units, [], lc, "2026-11-21"), ...uv]);
assert.equal(lg.filter((x) => x.title.endsWith("の数えの台本")).length, 3, "一度も照らしていない物は持ち主ごとに1行（G・N・L）");
assert.equal(lg.find((x) => x.title.endsWith("scripts/audit-x.ts"))!.priority, 10, "ズレは先に");

// ⑤ 主な道の外
const ev = [{ conversation_id: "a", start_at: "2026-11-10T01:00:00Z" }, { conversation_id: "b", start_at: "2026-11-10T01:00:00Z" }];
const rec = [{ conversation_id: "a", created_at: "2026-11-09T05:00:00Z" }, { conversation_id: "b", created_at: "2026-11-01T05:00:00Z" }];
assert.deepEqual(eventsWithoutRecord(ev, rec, 3 * DAY, DAY).map((e) => e.conversation_id), ["b"], "幅の外の記録は数えない");
assert.equal(isOffPathGap({ id: "x", label: "x", owner: "x", n: 100, off: 2, rate: 2, why: "", convs: [] }), false);
assert.equal(isOffPathGap({ id: "x", label: "x", owner: "x", n: 20, off: 3, rate: 15, why: "", convs: [] }), true);

// 内覧: ブレインの内覧調整のタスクと時間確保の候補は内覧に数えない（台帳 #579）
assert.equal(isConfirmedViewingEvent({ all_day: true, title: "山田 内覧調整", notes: "件数: 1件\n物件: （未確定）（現地）" }), false);
assert.equal(isConfirmedViewingEvent({ all_day: false, title: "【確保】内覧", notes: "【時間確保】\n候補: 明日 15:30" }), false);
assert.equal(isConfirmedViewingEvent({ all_day: false, title: "山田 内覧 物件A", notes: "住所: x" }), true);

// 持ち主
assert.equal(liveOwnerOf("read"), "作業員L");
assert.equal(liveOwnerOf("tool_rank"), "作業員P"); // 2026-11-23 4人体制（K2→P）
assert.equal(liveOwnerOf("作業員K・作業員L"), "作業員P");
assert.equal(liveOwnerOf("作業員Z"), "統括役");
console.log("foundation-holes-345: ok");
