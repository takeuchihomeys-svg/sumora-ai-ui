// 試験の入力の固定（scripts/lib/exam-frozen-input.ts）の単体テスト（LLM も DB も使わない・fetch は偽物）
// 実行: npx tsx scripts/lib/__tests__/exam-frozen-input.test.ts（全 PASS で exit 0）
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frozenSceneNow, snapshotDay, snapshotTarget, snapshotKey, installDbSnapshot, keyedTarget, keyedKey, reduceKeyedBody, nearestSummaryOf, afterCutoff } from "../exam-frozen-input";
import { existsSync, writeFileSync } from "node:fs";
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

// ─── ③ 鍵が要る読みの欄の絞り（本文・要約を残さない） ───
ok("鍵の要る読みの対象", keyedTarget(base + "rpc/match_conductor_focus", "POST") === "match_conductor_focus" && keyedTarget(base + "takeuchi_compose_examples?select=message_id", "GET") === "takeuchi_compose_examples" && keyedTarget(base + "rpc/match_templates", "POST") === null && keyedTarget(base + "messages?x=1", "GET") === null);
{
  const red = JSON.parse(reduceKeyedBody("match_conductor_focus", JSON.stringify([{ source_key: "msg:1", scene: "S1", focus: "answer", distance: 0.12, turn_at: "2026-10-01T00:00:00Z", actual: { aix: "property_check_result", route: "aix", shape: "x", picker: "空いてる", text: "本文" }, situation: "お客様: 本文" }, { source_key: "msg:2", actual: { picker: "mgmt_equipment" } }])));
  ok("近い番: 決めた欄だけ（本文・要約を落とす・ピッカーは決まった名前だけ）", red.length === 2 && red[0].source_key === "msg:1" && red[0].actual.aix === "property_check_result" && !("situation" in red[0]) && red[0].actual.picker === null && red[1].actual.picker === "mgmt_equipment" && !("text" in red[0].actual));
  const k2 = JSON.parse(reduceKeyedBody("takeuchi_compose_examples", JSON.stringify([{ message_id: "m1", keep: true, anatomy: { body: "本文" } }, { message_id: "m2", keep: "x" }])));
  ok("keep: 真偽だけ（分からないは null）", k2[0].keep === true && k2[1].keep === null && !("anatomy" in k2[0]));
  const v = JSON.parse(reduceKeyedBody("conductor_turn_vectors", JSON.stringify([{ source_key: "msg:1", turn_at: "t", situation: "お客様: 本文" }])));
  ok("番のベクトルの表: 要約を落とす（渡されない番）", v[0].source_key === "msg:1" && v[0].situation === null);
  const v2 = JSON.parse(reduceKeyedBody("conductor_turn_vectors", JSON.stringify([{ source_key: "msg:1", situation: "x" }, { source_key: "msg:2", situation: "y" }]), { "msg:1": "伏せた要約" }));
  ok("番のベクトルの表: 台本が渡した番（一番近い番）だけ要約を残す", v2[0].situation === "伏せた要約" && v2[1].situation === null);
  ok("分からない形は空", reduceKeyedBody("match_conductor_focus", "not json") === "[]");
  // 一番近い番の要約: お客様の行だけ・60字まで・PII の伏せ・申込の書類以降は入れない
  const sum = nearestSummaryOf("場面: S1\n段階: x\n直前のこちら: なし\nお客様: 090-1234-5678 に電話ください" + "あ".repeat(80));
  ok("要約: お客様の行・電話番号を伏せる・60字まで", !!sum && !sum.includes("090-1234-5678") && sum.length <= 60 && !sum.includes("場面"), String(sum));
  ok("要約: お客様の行が無ければ入れない", nearestSummaryOf("場面: S1") === null && nearestSummaryOf(null) === null);
  ok("申込の書類以降は入れない（線が読めない時も入れない・申込の記録が無ければ入れる）", afterCutoff("2026-11-02T00:00:00Z", "2026-11-01T00:00:00Z") && !afterCutoff("2026-10-30T00:00:00Z", "2026-11-01T00:00:00Z") && afterCutoff("2026-10-30T00:00:00Z", null) && !afterCutoff("2026-10-30T00:00:00Z", Number.NEGATIVE_INFINITY));
}

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
    // ③ 鍵が要る読み（11/07 統括役の決め B）: 試験では控えず頼みを残す・夜の台本が絞って書いた控えを返す・レーンの会話 id は鍵で伏せる
    const before = calls;
    const body1 = JSON.stringify({ query_embedding: "[0.1,0.2]", p_exclude_conv: conv, match_count: 30 });
    const r1 = await fetch(base + "rpc/match_conductor_focus", { method: "POST", body: body1 });
    ok("鍵の要る読み: 控えが無い時は公開キーの答えをそのまま返し・頼みを残す", r1.ok && calls === before + 1 && existsSync(join(dir, "2026-11-05", "pending", `k-${keyedKey(base + "rpc/match_conductor_focus", "POST", body1, [conv])}.json`)));
    const k = keyedKey(base + "rpc/match_conductor_focus", "POST", body1, [conv]);
    writeFileSync(join(dir, "2026-11-05", `k-${k}.json`), JSON.stringify({ status: 200, contentType: "application/json", contentRange: null, body: JSON.stringify([{ source_key: "msg:1", focus: "answer", distance: 0.1 }]), at: "x", table: "match_conductor_focus" }));
    const r2 = await (await fetch(base + "rpc/match_conductor_focus", { method: "POST", body: body1 })).json() as Array<{ source_key: string }>;
    ok("鍵の要る読み: 夜の台本の控えを返す（呼ばない）", r2[0].source_key === "msg:1" && calls === before + 1);
    ok("鍵の要る読み: 別のレーンの会話 id でも同じ鍵", keyedKey(base + "rpc/match_conductor_focus", "POST", body1.replace(conv, "other-lane"), ["other-lane"]) === k);
  } finally { globalThis.fetch = orig; rmSync(dir, { recursive: true, force: true }); }
  console.log(`${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
