// 試験の入力の固定（scripts/lib/exam-frozen-input.ts）の単体テスト（LLM も DB も使わない・fetch は偽物）
// 実行: npx tsx scripts/lib/__tests__/exam-frozen-input.test.ts（全 PASS で exit 0）
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frozenSceneNow, snapshotDay, snapshotTarget, snapshotKey, installDbSnapshot } from "../exam-frozen-input";
import { maskVolatile } from "../llm-cassette";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }
const DAY = 86_400_000;

// ─── 時計 ───
{
  const at = Date.parse("2026-10-21T13:05:00Z"); // 水曜 22:05 JST
  const r1 = frozenSceneNow(at, Date.parse("2026-11-05T03:00:00Z")); // 木曜の昼
  ok("時計: 7日の倍数", r1.shiftDays === 14 && r1.nowMs === at + 14 * DAY, JSON.stringify(r1));
  ok("時計: 曜日と時刻が元と同じ", new Date(r1.nowMs).getUTCDay() === new Date(at).getUTCDay() && new Date(r1.nowMs).getUTCHours() === 13);
  ok("時計: 今より後にならない", r1.nowMs <= Date.parse("2026-11-05T03:00:00Z"));
  const r2 = frozenSceneNow(at, Date.parse("2026-11-06T03:00:00Z"));
  ok("時計: 次の日に走らせても同じ（入力が毎日変わらない）", r2.nowMs === r1.nowMs);
  const r3 = frozenSceneNow(at, at - 1000);
  ok("時計: 元が未来なら動かさない", r3.shiftDays === 0 && r3.nowMs === at);
}

// ─── 写しの日・対象・鍵 ───
ok("日: JST 4時で区切る（3:59 は前の日）", snapshotDay(Date.parse("2026-11-04T18:59:00Z")) === "2026-11-04" && snapshotDay(Date.parse("2026-11-04T19:01:00Z")) === "2026-11-05");
const base = "https://x.supabase.co/rest/v1/";
const conv = "d040f80a-4fae-4fd0-abca-66eb2630906f";
ok("対象: 学習の表の GET", snapshotTarget(base + "ai_reply_examples?select=*&order=won_count.desc", "GET", "", [conv]) === "ai_reply_examples");
ok("対象: 会話の表は控えない", snapshotTarget(base + "messages?conversation_id=eq." + conv, "GET", "", [conv]) === null);
ok("対象: 会話の id を含む問い合わせは控えない", snapshotTarget(base + "line_watch_turns?conversation_id=eq." + conv, "GET", "", [conv]) === null);
ok("対象: 書き込みは控えない", snapshotTarget(base + "ai_reply_examples", "POST", "{}", []) === null);
ok("対象: RAG の rpc", snapshotTarget(base + "rpc/match_reply_knowledge", "POST", "{\"q\":1}", [conv]) === "match_reply_knowledge");
ok("対象: 知らない rpc は控えない", snapshotTarget(base + "rpc/other_fn", "POST", "{}", []) === null);
ok("鍵: 同じ日の時刻の違いは同じ鍵",
  snapshotKey(base + "aix_transition_stats?created_at=gte.2026-10-06T03:12:44.123Z", "GET", "") === snapshotKey(base + "aix_transition_stats?created_at=gte.2026-10-06T09:59:01.000Z", "GET", ""));
ok("鍵: 別の日は別の鍵",
  snapshotKey(base + "aix_transition_stats?created_at=gte.2026-10-06T03:12:44Z", "GET", "") !== snapshotKey(base + "aix_transition_stats?created_at=gte.2026-10-07T03:12:44Z", "GET", ""));
ok("鍵: 中身が違えば別の鍵", snapshotKey(base + "rpc/match_templates", "POST", "{\"a\":1}") !== snapshotKey(base + "rpc/match_templates", "POST", "{\"a\":2}"));

// ─── 録音の鍵の時差の伏せ（llm-cassette の maskVolatile・11/05 q179 の帳面） ───
ok("鍵の伏せ: +00 と +0 と +00:00 が同じ", maskVolatile("estimate_sheet@2026-11-05T03:57:06.12345+00）", {}) === maskVolatile("estimate_sheet@2026-11-05T03:57:06.1234+0）", {})
  && maskVolatile("a 2026-11-05 03:57:06+00:00 b", {}) === "a <ts> b");
ok("鍵の伏せ: 時刻の後の金額は伏せない", maskVolatile("2026-11-05T03:57 -5万", {}).endsWith(" -5万"));

// ─── 包み（偽物の fetch） ───
(async () => {
  const dir = mkdtempSync(join(tmpdir(), "exam-snap-"));
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => { calls++; return new Response(JSON.stringify([{ n: calls, u: String(input) }]), { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch;
  try {
    const now = Date.parse("2026-11-05T03:00:00Z");
    const st = installDbSnapshot({ dir, excludeIds: () => [conv], nowMs: () => now });
    const a = await (await fetch(base + "ai_reply_examples?select=*")).json() as Array<{ n: number }>;
    const b = await (await fetch(base + "ai_reply_examples?select=*")).json() as Array<{ n: number }>;
    ok("包み: 2回目は控えを返す（呼ばない）", a[0].n === 1 && b[0].n === 1 && calls === 1 && st.hit === 1 && st.miss === 1, JSON.stringify({ a, b, calls, st }));
    await fetch(base + "messages?conversation_id=eq." + conv); await fetch(base + "messages?conversation_id=eq." + conv);
    ok("包み: 会話の表は毎回呼ぶ", calls === 3);
    ok("包み: 日ごとの置き場", readdirSync(dir).join(",") === "2026-11-05");
  } finally { globalThis.fetch = orig; rmSync(dir, { recursive: true, force: true }); }
  console.log(`${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
