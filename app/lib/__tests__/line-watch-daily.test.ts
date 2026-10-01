// LINE の見張り 2段目の毎日のまとめ（app/lib/line-watch-daily.ts）と SQL の一致
// 実行: npx tsx app/lib/__tests__/line-watch-daily.test.ts（自己完結ハーネス。全 PASS で exit 0）
// 材料: 本番の行の形（line_watch_turns の verdict_detail・final_check の小さな形・calendar_events・申込ツールの daily_tasks の列）
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  sceneStats, finalCheckStats, lateStats, screeningCalendarDiff, reviewStats, buildLineWatchDaily, dailyLines, sameCustomerName, jstDayStartMs, jstYmd,
  UNLOCK, type StatTurn,
} from "../line-watch-daily";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(actual: T, exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); }
const DAY = 86_400_000;
const now = Date.parse("2026-10-20T11:50:00Z"); // JST 20:50
const ago = (d: number, h = 0) => new Date(now - d * DAY - h * 3600_000).toISOString();
const turn = (d: number, verdict: StatTurn["verdict"], scene = "返信:条件提示", extra: Record<string, unknown> = {}): StatTurn =>
  ({ conversation_id: `c${d}-${Math.random()}`, customer_turn_at: ago(d, 1), scene_key: scene, verdict, verdict_detail: { v: "x", path: "返信", reason: "exact", final: true, ...extra } });

console.log("sceneStats（解禁の線・停止の線）");
it("28日に30番・全部一致、1週前の28日も満たす → 解禁の線", () => {
  const turns = Array.from({ length: 80 }, (_, i) => turn(i % 34, "same_meaning"));
  const s = sceneStats(turns, now)[0];
  eq([s.cur.n >= UNLOCK.minN, s.cur.rate, s.unlock], [true, 1, true]);
});
it("事実違いが1件あれば解禁しない（残りに出る）", () => {
  const turns = [...Array.from({ length: 80 }, (_, i) => turn(i % 34, "same")), turn(3, "different", "返信:条件提示", { fact_diff: true })];
  const s = sceneStats(turns, now)[0];
  eq(s.unlock, false);
  eq(s.remaining.some((r) => r.startsWith("事実違い")), true);
});
it("今だけ満たして1週前が足りない → まだ（待つ）", () => {
  const turns = Array.from({ length: 30 }, () => turn(1, "same"));
  const s = sceneStats(turns, now)[0];
  eq(s.unlock, false);
  eq(s.remaining.includes("1週前の28日も満たすのを待つ"), true);
});
it("直近7日 8番中6番一致（75%）→ 停止の線", () => {
  const turns = [...Array.from({ length: 6 }, () => turn(2, "same")), turn(3, "partial"), turn(4, "different")];
  eq(sceneStats(turns, now)[0].stop, true);
});
it("比べられない（na）・申込以降・場面なしは数えない", () => {
  const s = sceneStats([turn(1, "na"), turn(1, "same", "対象外:申込以降"), { ...turn(1, "same"), scene_key: null }], now);
  eq(s.length, 1);
  eq(s[0].cur.n, 0);
});
it("文の一致は text_verdict で別に数える（AIX の番で文を比べた物）", () => {
  const s = sceneStats([turn(1, "same", "AIX:property_send", { text_verdict: "same" }), turn(1, "different", "AIX:property_send", { text_verdict: "partial" })], now)[0];
  eq([s.cur.textN, s.cur.textAgree], [2, 1]);
});

console.log("finalCheckStats（トリガーの小さな形）");
it("場面×段×code・修正前・直した", () => {
  const fc = { ok: true, issues: [{ code: "NAME_MISMATCH", pass: "rule_check", severity: "warning", evidence: "x" }], pre: ["NAME_MISMATCH:warning", "EXCLAIM_OVERUSE_DET:warning"], revision_count: 1 };
  const r = finalCheckStats([{ scene_key: "返信:条件提示", customer_turn_at: ago(1), final_check: fc }, { scene_key: "返信:条件提示", customer_turn_at: ago(40), final_check: fc }], now);
  eq([r.turns, r.withIssues, r.revisedTurns], [1, 1, 1]);
  const name = r.rows.find((x) => x.code === "NAME_MISMATCH")!;
  eq([name.stage, name.final, name.pre, name.revised], ["ルール", 1, 1, 1]);
  eq(r.rows.find((x) => x.code === "EXCLAIM_OVERUSE_DET")!.stage, "決定論");
});

console.log("lateStats（営業時間で数える）");
it("JST 14:00 に来て 15:30 に返した＝90分で遅れ・まだ返していない 2時間＝遅れ", () => {
  const dayStart = jstDayStartMs(now);
  const at = (h: number, m = 0) => new Date(dayStart + h * 3600_000 + m * 60_000).toISOString();
  const r = lateStats([
    { conversation_id: "a", customer_turn_at: at(14), staff_first_at: at(15, 30) },
    { conversation_id: "b", customer_turn_at: at(18), staff_first_at: null },
    { conversation_id: "c", customer_turn_at: at(12), staff_first_at: at(12, 10) },
  ], dayStart, Date.parse(at(20, 50)));
  eq([r.turns, r.replied, r.late, r.unrepliedLate, r.medianMin], [3, 2, 1, 0, 90]);
});

console.log("screeningCalendarDiff（C7）");
const ev = (id: number, startJst: string, notes: string, name = "山田") => ({ id, conversation_id: `conv${id}`, customer_name: name, event_type: "viewing", start_at: new Date(`${startJst}+09:00`).toISOString(), notes, all_day: false, is_done: false });
const decided = "件数: 1件\n【1件目】エスリード難波 / 現地\n住所: 大阪市浪速区";
it("確定した内覧で申込ツールに行が無い → C7a", () => {
  eq(screeningCalendarDiff({ ours: [ev(501, "2026-10-22T13:00:00", decided)], tasks: [], todayYmd: "2026-10-20" }).map((f) => f.code), ["C7a"]);
});
it("鍵の行（dt_sumora_cal_501）の時刻が違う → C7b", () => {
  const f = screeningCalendarDiff({ ours: [ev(501, "2026-10-22T13:00:00", decided)], tasks: [{ id: "dt_sumora_cal_501", customer_name: "山田", content: "【内覧】", date: "2026-10-22", time: "14:00" }], todayYmd: "2026-10-20" });
  eq(f.map((x) => x.code), ["C7b"]);
});
it("鍵の無い旧の行（同じ日・同じお客様・内覧）があれば食い違いにしない", () => {
  eq(screeningCalendarDiff({ ours: [ev(501, "2026-10-22T13:00:00", decided, "山田 太郎")], tasks: [{ id: "dt_sumora_1727000000000", customer_name: "山田太郎", content: "🏠 内覧 — 山田太郎", date: "2026-10-22", time: "13:00" }], todayYmd: "2026-10-20" }).length, 0);
});
it("未確定・時間確保の予定は入れない決まり＝無くても C7a にしない", () => {
  eq(screeningCalendarDiff({ ours: [ev(502, "2026-10-22T13:00:00", "件数: 1件\n物件: （未確定）（現地）"), ev(503, "2026-10-23T13:00:00", "【時間確保】10/23 13:00〜15:00")], tasks: [], todayYmd: "2026-10-20" }).length, 0);
});
it("消した予定・未確定に戻した予定の鍵の行が残る → C7c", () => {
  const f = screeningCalendarDiff({
    ours: [ev(504, "2026-10-24T13:00:00", "件数: 1件\n物件: （未確定）（現地）")],
    tasks: [{ id: "dt_sumora_cal_999", customer_name: "佐藤", content: "【内覧】", date: "2026-10-25", time: "11:00" }, { id: "dt_sumora_cal_504", customer_name: "山田", content: "【内覧】", date: "2026-10-24", time: "13:00" }],
    todayYmd: "2026-10-20",
  });
  eq(f.map((x) => [x.code, x.eventId]), [["C7c", "504"], ["C7c", "999"]]);
});
it("過去の行・済みの行は見ない", () => {
  eq(screeningCalendarDiff({ ours: [], tasks: [{ id: "dt_sumora_cal_1", customer_name: "a", content: "", date: "2026-10-19", time: "" }, { id: "dt_sumora_cal_2", customer_name: "a", content: "", date: "2026-10-21", time: "", done: true }], todayYmd: "2026-10-20" }).length, 0);
});
it("名前の照らし（敬称・空白・絵文字）", () => {
  eq(sameCustomerName("YUMA", "yuma様"), true);
  eq(sameCustomerName("💋chibi💋", "chibi"), true);
  eq(sameCustomerName("山田", "佐藤"), false);
});

console.log("reviewStats・buildLineWatchDaily");
it("✋は「本当は」の判定と組で数える", () => {
  const r = reviewStats([
    { verdict: "partial", verdict_review: "disagree", verdict_review_verdict: "same_meaning", verdict_review_rule: "partial", verdict_detail: { reason: "wording_far" } },
    { verdict: "same", verdict_review: "agree", verdict_detail: { reason: "exact" } },
    { verdict: "same", verdict_review: null },
  ]);
  eq([r.reviewed, r.agree, r.disagree], [2, 1, 1]);
  eq(r.confusion.find((c) => c.rule === "partial")?.human, "same_meaning");
});
it("控えが24時間0番・C7 が測れない・事実違い・約束48時間超を知らせる", () => {
  const d = buildLineWatchDaily({
    date: jstYmd(now), scenes: [], prevScenes: null, fc: finalCheckStats([], now), late: lateStats([], jstDayStartMs(now), now),
    dayTurns: [{ ...turn(1, "different", "返信:質問", { fact_diff: true }), name: "Aさん" }],
    promises: [{ name: "B", kindJa: "確認の約束", hours: 50, customerActive: true }, { name: "C", kindJa: "確認の約束", hours: 60, customerActive: false }],
    calendar: [{ code: "C2" }], c7: { measured: false, reason: "鍵が無い", findings: [] }, search: [{ kind: "idle" }], aixPending: 3,
    reviews: reviewStats([]), capture: { enabled: true, turns24h: 0, tableReady: true },
  });
  const all = d.alerts.join("\n");
  for (const w of ["控えが1番も無い", "C7）は測れない: 鍵が無い", "事実（金額・日時・物件）が違った番（前日）1番: Aさん", "約束の未対応（48時間超・お客様は止まっていない）1件: B（確認の約束）", "カレンダー: C2 1件", "検索が要るのに動いていないお客様 1人"]) {
    if (!all.includes(w)) throw new Error(`知らせる事に「${w}」が無い:\n${all}`);
  }
  eq(dailyLines(d)[0].startsWith("LINE の見張り 2026-10-20"), true);
});
it("場面が解禁の線を新しく満たした・停止の線に当たった（前回のまとめと比べる）", () => {
  const turns = Array.from({ length: 80 }, (_, i) => turn(i % 34, "same"));
  const scenes = sceneStats(turns, now);
  const d = buildLineWatchDaily({
    date: "x", scenes, prevScenes: [{ scene: "返信:条件提示", unlock: false, stop: false }], fc: finalCheckStats([], now), late: lateStats([], 0, now), dayTurns: [],
    promises: [], calendar: [], c7: { measured: true, findings: [] }, search: [], aixPending: 0, reviews: reviewStats([]), capture: { enabled: true, turns24h: 5, tableReady: true },
  });
  eq(d.alerts.some((a) => a.includes("返信 条件提示 が解禁の線を満たした")), true);
});

console.log("SQL（scripts/line-watch-stage2-migration.sql と migrate-schema の節が同じ文）");
it("作成の文が全部 migrate-schema/route.ts に入っている", () => {
  const root = path.join(__dirname, "..", "..", "..");
  const sql = readFileSync(path.join(root, "scripts", "line-watch-stage2-migration.sql"), "utf8").replace(/\r\n/g, "\n");
  const route = readFileSync(path.join(root, "app", "api", "migrate-schema", "route.ts"), "utf8").replace(/\r\n/g, "\n");
  const stmts = sql.split("\n").filter((l) => /^(ALTER|CREATE)/.test(l));
  eq(stmts.length, 8);
  for (const s of stmts) if (!route.includes(s)) throw new Error(`migrate-schema に無い: ${s}`);
  // テンプレート文字列に貼るので使えない文字が無い
  if (/[\\`]|\$\{/.test(sql)) throw new Error("SQL にバックスラッシュ・バッククォート・${ がある");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
