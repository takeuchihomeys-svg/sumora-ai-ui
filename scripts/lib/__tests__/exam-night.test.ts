// 夜の試験の段取り（scripts/lib/exam-night.ts）の単体テスト（LLM も DB も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-night.test.ts（全 PASS で exit 0）
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunksOf, splitByPlan, chunkGate, budgetMsOf, estimateRunUsd, orderQueue, backupOwnerOf, staleVerdict, staleNameOf, sweepStaleBackups, itemHardMs, queueTotalMs, supersededWarms, supersededNameOf, supersedeQueueFile, type QItem } from "../exam-night";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

// ─── ① 差分だけ ───
ok("塊: 15問ずつ", JSON.stringify(chunksOf([1, 2, 3, 4, 5], 2)) === "[[1,2],[3,4],[5]]");
ok("塊: 0 や変な数は1", chunksOf([1, 2], 0).length === 2);
{
  const rows = [
    { id: "q1", rep: 1, inputSame: true }, { id: "q1", rep: 2, inputSame: true },
    { id: "q2", rep: 1, inputSame: true }, // 2回欲しいのに1回だけ（2回目は控えが無い）
    { id: "q4", rep: 1, inputSame: true, error: "x" },
    { id: "q5", rep: 1, inputSame: true },
  ];
  const r = splitByPlan(["q1", "q2", "q3", "q4", "q5"], rows, (id) => (id === "q5" ? 1 : 2));
  ok("下見: 全部の回が同じ問題だけ same", JSON.stringify(r.same) === '["q1","q5"]', JSON.stringify(r));
  ok("下見: 回が足りない・答案が無い・失敗は changed", JSON.stringify(r.changed) === '["q2","q3","q4"]', JSON.stringify(r));
}
{
  const rows = [{ id: "a", rep: 1, inputSame: true }, { id: "b", rep: 1, inputSame: true }];
  const items = { "a#1": { same: true, firstChanged: null, pinned: 3 }, "a#2": { same: false, firstChanged: null, pinned: 0, why: "main の控えなし" },
    "b#1": { same: true, firstChanged: null, pinned: 3 }, "b#2": { same: false, firstChanged: "brain_full", pinned: 0 }, "c#1": { same: false, firstChanged: "brain_fresh", pinned: 1 } };
  const r = splitByPlan(["a", "b", "c"], rows, () => 2, items);
  ok("下見（控えつき）: 控えの無い回は足さない＝同じ回だけで same", JSON.stringify(r) === '{"same":["a"],"changed":["b","c"]}', JSON.stringify(r));
}
ok("関所: 予算の内は進む", chunkGate({ startMs: 0, nowMs: 10 * 60_000, budgetMs: 90 * 60_000, limitLeft: 5, mainMoved: null }).go);
ok("関所: 予算を使い切ったら止める", chunkGate({ startMs: 0, nowMs: 91 * 60_000, budgetMs: 90 * 60_000, limitLeft: 5, mainMoved: null }).why === "budget");
ok("関所: 上限に届いたら止める", chunkGate({ startMs: 0, nowMs: 0, budgetMs: null, limitLeft: 0, mainMoved: null }).why === "limit");
ok("関所: main が進んだら一番先に止める", chunkGate({ startMs: 0, nowMs: 0, budgetMs: null, limitLeft: 0, mainMoved: "a→b" }).why === "main-moved");
ok("関所: 予算も上限も無ければ進む", chunkGate({ startMs: 0, nowMs: 1e12, budgetMs: null, limitLeft: null, mainMoved: null }).go);
ok("予算: 90→90分・空/off/0 は無し", budgetMsOf("90") === 90 * 60_000 && budgetMsOf("") === null && budgetMsOf("off") === null && budgetMsOf("0") === null && budgetMsOf(undefined) === null);
{
  const usd = estimateRunUsd(["a", "b"], { prevCost: (id) => (id === "a" ? { usd: 0.06, reps: 2 } : null), reps: (id) => (id === "a" ? 1 : 2), unitUsd: 0.03 });
  ok("見込み: 前の費用÷前の回数×回す回数・無ければ1問1回 unit", Math.abs(usd - (0.03 + 0.06)) < 1e-9, String(usd));
}

// ─── ⑤ 予約の順 ───
const qi = (label: string, argv: string[], createdAt: string): QItem => ({ label, argv, createdAt, at: createdAt, estUsd: 0, cwd: "/w", file: `/q/${label}.json` });
{
  const due = [
    qi("warm-auto-aaa", ["--warm-main", "--when=now", "--warm-vk=aaa"], "2026-10-21T01:00:00Z"),
    qi("cmp-2", ["--conv=YUMA4", "--label=cmp-2"], "2026-10-21T03:00:00Z"),
    qi("warm-auto-bbb", ["--warm-main", "--when=now", "--warm-vk=bbb"], "2026-10-21T02:00:00Z"),
    qi("cmp-1", ["--conv=YUMA4", "--label=cmp-1"], "2026-10-21T02:30:00Z"),
    qi("warm-10-22", ["--warm-main", "--when=now"], "2026-10-21T00:30:00Z"),
    qi("warm-types", ["--warm-main", "--types=出し切り"], "2026-10-21T00:10:00Z"),
  ];
  const r = orderQueue(due, { currentVk: "aaa" });
  ok("順: 比べを先（作った順）→ 型を絞った取り置き → 全部の取り置きは1本だけ（今の版）", r.run.map((x) => x.label).join(",") === "cmp-1,cmp-2,warm-types,warm-auto-aaa", r.run.map((x) => x.label).join(","));
  ok("順: 古い版・重なりの取り置きは捨てる（理由つき）", r.drop.map((d) => d.item.label).sort().join(",") === "warm-10-22,warm-auto-bbb" && r.drop.find((d) => d.item.label === "warm-auto-bbb")!.why.includes("古い main の版"), JSON.stringify(r.drop.map((d) => [d.item.label, d.why])));
  const r2 = orderQueue(due.filter((x) => x.label !== "warm-auto-aaa"), { currentVk: "zzz" });
  ok("順: 今の版の物が無ければ一番新しい取り置きを1本", r2.run.at(-1)!.label === "warm-auto-bbb" && r2.drop.length === 1, r2.run.map((x) => x.label).join(","));
  ok("順: 取り置きが無くても比べはそのまま", orderQueue([due[1]], { currentVk: null }).run.length === 1);
}
{
  // 10/23 取り置きの予約をまとめる: 新しい版を予約したら、他の版の全部の取り置きだけ脇へ（型を絞った物・比べ・同じ版には触らない）
  const q = [
    qi("warm-auto-aaa", ["--warm-main", "--when=now", "--warm-vk=aaa"], "2026-10-23T01:00:00Z"),
    qi("warm-auto-bbb", ["--warm-main", "--when=now", "--warm-vk=bbb"], "2026-10-23T02:00:00Z"),
    qi("warm-auto-ccc", ["--warm-main", "--when=now"], "2026-10-23T00:00:00Z"), // 版は label から
    qi("warm-types", ["--warm-main", "--types=x", "--warm-vk=aaa"], "2026-10-23T01:30:00Z"),
    qi("cmp-1", ["--select=x"], "2026-10-23T01:40:00Z"),
  ];
  const s = supersededWarms(q, "bbb");
  ok("まとめ: 他の版の全部の取り置きだけ脇へ", s.map((x) => x.item.label).sort().join(",") === "warm-auto-aaa,warm-auto-ccc", JSON.stringify(s.map((x) => x.item.label)));
  ok("まとめ: 理由に新旧の版", s.find((x) => x.item.label === "warm-auto-aaa")!.why.includes("bbb") && s.find((x) => x.item.label === "warm-auto-aaa")!.why.includes("aaa"));
  ok("まとめ: 同じ版だけなら何もしない", supersededWarms(q.filter((x) => x.label !== "warm-auto-aaa" && x.label !== "warm-auto-ccc"), "bbb").length === 0);
  ok("まとめ: 脇の名前は .json で終わらない", supersededNameOf("/q/warm-auto-aaa.json", new Date("2026-10-23T03:04:00Z")) === "/q/warm-auto-aaa.json.superseded-202610231204");
  const d = mkdtempSync(join(tmpdir(), "exam-night-q-"));
  const f = join(d, "warm-auto-aaa.json"); writeFileSync(f, "{}");
  const to = supersedeQueueFile(f, new Date("2026-10-23T03:04:00Z"));
  ok("まとめ: 消さずに名前を変える", !!to && !existsSync(f) && existsSync(to!) && readdirSync(d).length === 1);
  ok("まとめ: 無いファイルは null", supersedeQueueFile(join(d, "none.json")) === null);
  rmSync(d, { recursive: true, force: true });
}
ok("上限: 1本 240分・1回 300分・off で無し", itemHardMs({}) === 240 * 60_000 && queueTotalMs({}) === 300 * 60_000 && itemHardMs({ EXAM_QUEUE_ITEM_MAX_MIN: "off" }) === null);

// ─── ⑤ 古い控え ───
ok("控え: label と pid を読む", JSON.stringify(backupOwnerOf(".brain-exam-main-c5c3bbb-a4a80f4832-rmvdeqc7i-yuma-pc-backup.json", '{"id":"x","row":{},"pid":123}')) === '{"label":"main-c5c3bbb-a4a80f4832-rmvdeqc7i","pid":123}');
ok("控え: 会話つき・pid なしの古い形", JSON.stringify(backupOwnerOf(".brain-exam-fs1022-yuma4-pc-backup.json", '{"id":"x","row":{}}')) === '{"label":"fs1022","pid":null}');
{
  const H = 3600_000, now = 100 * H, base = { size: 10, nowMs: now, maxAgeMs: 6 * H, pidAlive: (p: number) => p === 7, labelLive: false };
  ok("古い: 空は見ない", !staleVerdict({ ...base, size: 0, mtimeMs: 0, pid: null }).stale);
  ok("古い: 持ち主が動いていれば古くない", !staleVerdict({ ...base, mtimeMs: 0, pid: 7 }).stale);
  ok("古い: 持ち主が止まって10分より前なら古い", staleVerdict({ ...base, mtimeMs: now - 11 * 60_000, pid: 8 }).stale);
  ok("古い: 持ち主が止まっても10分以内は見送る", !staleVerdict({ ...base, mtimeMs: now - 5 * 60_000, pid: 8 }).stale);
  ok("古い: pid なし・6時間より古い・同じ label が動いていない＝古い", staleVerdict({ ...base, mtimeMs: now - 7 * H, pid: null }).stale);
  ok("古い: pid なしでも同じ label が動いていれば古くない", !staleVerdict({ ...base, mtimeMs: now - 70 * H, pid: null, labelLive: true }).stale);
  ok("古い: pid なしで6時間以内は古くない", !staleVerdict({ ...base, mtimeMs: now - 2 * H, pid: null }).stale);
}
ok("脇の名前: .stale-<JST の年月日時分>", staleNameOf("/a/b.json", new Date("2026-10-22T03:04:00Z")) === "/a/b.json.stale-202610221204");
{
  const d = mkdtempSync(join(tmpdir(), "exam-night-"));
  const old = Date.now() / 1000 - 8 * 3600;
  writeFileSync(join(d, ".brain-exam-dead-yuma-pc-backup.json"), '{"id":"x","row":{"a":1}}'); utimesSync(join(d, ".brain-exam-dead-yuma-pc-backup.json"), old, old);
  writeFileSync(join(d, ".brain-exam-live-yuma2-pc-backup.json"), '{"id":"x","row":{}}'); utimesSync(join(d, ".brain-exam-live-yuma2-pc-backup.json"), old, old);
  writeFileSync(join(d, ".brain-exam-empty-yuma-pc-backup.json"), "");
  writeFileSync(join(d, ".brain-exam-pid-yuma3-pc-backup.json"), '{"id":"x","row":{},"pid":424242}'); utimesSync(join(d, ".brain-exam-pid-yuma3-pc-backup.json"), old, old);
  const logs: string[] = [];
  const moved = sweepStaleBackups([d], { live: new Set(["live"]), alive: () => false, log: (s) => logs.push(s) });
  const names = readdirSync(d);
  ok("見回り: 止まった控え2つを脇へ（消さない）", moved.length === 2 && names.filter((n) => n.includes(".stale-")).length === 2, names.join(" "));
  ok("見回り: 動いている label・空の控えは残す", existsSync(join(d, ".brain-exam-live-yuma2-pc-backup.json")) && existsSync(join(d, ".brain-exam-empty-yuma-pc-backup.json")));
  ok("見回り: 1件ごとに理由を出す", logs.length === 2 && logs.every((l) => l.includes("脇へ寄せた")));
  const moved2 = sweepStaleBackups([d], { live: null, alive: () => false, log: () => {} });
  ok("見回り: 動いている物が読めない時は pid の無い控えを寄せない（安全側）", moved2.length === 0 && existsSync(join(d, ".brain-exam-live-yuma2-pc-backup.json")));
  rmSync(d, { recursive: true, force: true });
}

console.log(`exam-night: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
