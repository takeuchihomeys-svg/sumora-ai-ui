// LINE の見張り 1段目の決まり（app/lib/line-watch-turn.ts）
// 実行: npx tsx app/lib/__tests__/line-watch-turn.test.ts（自己完結ハーネス。全 PASS で exit 0）
// 材料は本番の行の形そのまま（2026-10-01 に読むだけで引いた conversations.ai_draft_check・suggested_aix_meta・calendar_events・sent_facts。名前は伏せた）
import {
  sceneKeyOf, compactFinalCheck, finalCheckLine, businessMinutesBetween, calendarChecks, openPromises, draftVsStaff,
  searchWatch, searchNeedReason, type WatchCalEvent,
} from "../line-watch-turn";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(actual: T, exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); }
const jst = (ymd: string, hm: string) => new Date(`${ymd}T${hm}:00+09:00`).toISOString();

console.log("sceneKeyOf（本番の suggested_aix_meta の action × reply_mode の組）");
it("property_send × aix → AIX:property_send", () => eq(sceneKeyOf({ brainAction: "property_send", brainReplyMode: "aix" }).key, "AIX:property_send"));
it("acknowledge_check × aix → property_check_result に寄せる", () => eq(sceneKeyOf({ brainAction: "acknowledge_check", brainReplyMode: "aix" }).key, "AIX:property_check_result"));
it("空の action × auto_reply → 返信（tpo の場面）", () => eq(sceneKeyOf({ brainAction: "", brainReplyMode: "auto_reply", tpoLabel: "感謝返し（短い了承・感謝メッセージ。開口語「はい😊！！」一択）" }).key, "返信:短い了承・お礼"));
it("空の action × aix → AIX:種類なし", () => eq(sceneKeyOf({ brainAction: "", brainReplyMode: "aix" }).key, "AIX:種類なし"));
it("reply_mode なしの follow_up（AIX の種類の形）→ AIX", () => eq(sceneKeyOf({ brainAction: "follow_up", brainReplyMode: null }).key, "AIX:follow_up"));
it("古い行の自由文の action は AIX にしない", () => eq(sceneKeyOf({ brainAction: "涼雅さんに見積書の感触を確認し内覧または申込の意思を確認する", brainReplyMode: null, tpoLabel: "質問回答（往復: その他 → 質問（対象: 駐車場）｜台帳: 物件送付2件）" }).key, "返信:質問"));
it("文字の null は空と同じ", () => eq(sceneKeyOf({ brainAction: "null", brainReplyMode: null }).key, "返信:その他"));
it("条件変更の tpo → 条件提示", () => eq(sceneKeyOf({ brainReplyMode: "auto_reply", tpoLabel: "条件変更（物件送付後）（往復: 物件送付 → 条件変更＋質問（対象: 家賃）｜台帳: 物件送付6件）" }).key, "返信:条件提示"));
it("tpo で決まらなければ意図", () => eq(sceneKeyOf({ brainReplyMode: "auto_reply", tpoLabel: "", intent: "雑談" }).key, "返信:意図:雑談"));
it("申込以降（screening）は対象外", () => eq(sceneKeyOf({ brainAction: "property_send", brainReplyMode: "aix", convStatus: "screening" }).path, "対象外"));
it("審査落ちで戻した会話（状態は proposing）は対象", () => eq(sceneKeyOf({ brainAction: "property_send", brainReplyMode: "aix", convStatus: "proposing" }).path, "AIX"));

console.log("compactFinalCheck（本番の ai_draft_check の実物）");
const CHECK_RAW = {
  ok: true,
  issues: [
    { code: "MISSED_QUESTION", pass: "context_check", message: "顧客が新規物件『ヴィレ堺湊2階』のURLを提示し…", evidence: "こちら新しく出ていたのですが空いていますか？", severity: "warning", suggestion: "…" },
    { code: "STAFF_REQUEST_OMITTED", pass: "context_check", message: "…", evidence: "ご本人確認書類として運転免許証またはマイナンバーカードの裏表の写真をお送りください", severity: "warning", suggestion: "…" },
    { code: "NAME_MISMATCH", pass: "rule_check", message: "確定名以外の名前（入居者）があります", evidence: "入居者", severity: "warning", suggestion: "…" },
  ],
  pre_revision_issues: ["NAME_MISMATCH:warning", "WE_DO_MISSING_DET:info", "MISSED_QUESTION:warning", "STAFF_REQUEST_OMITTED:warning"],
  passes_completed: ["rule_check", "anomaly_scan", "context_check"],
  revision_count: 0,
  tpo_debug: { revisionOutcome: "ok" },
};
it("生の形: 段ごとの件数（文脈2・ルール1）", () => eq(compactFinalCheck(CHECK_RAW)?.byStage, { "文脈": 2, "ルール": 1 }));
it("修正前の指摘: 同じ code は最後の段・_DET は決定論", () => eq(compactFinalCheck(CHECK_RAW)?.pre.map((p) => `${p.code}:${p.stage}`), ["NAME_MISMATCH:ルール", "WE_DO_MISSING_DET:決定論", "MISSED_QUESTION:文脈", "STAFF_REQUEST_OMITTED:文脈"]));
it("修正の結果は tpo_debug から", () => eq(compactFinalCheck(CHECK_RAW)?.revisionOutcome, "ok"));
it("トリガーの小さな形も読める（直し切れた後で指摘0・修正前5件）", () => {
  const c = compactFinalCheck({ ok: true, issues: [], pre: ["RULE_VIOLATION:warning", "FABRICATED_PROPERTY:warning", "FABRICATED_PROPERTY:warning", "FABRICATED_AVAILABILITY:warning", "DOUBLE_DECLARATION:warning"], revision_count: 1, revision_outcome: "ok", passes: ["rule_check"] });
  eq([c?.final.length, c?.pre.length, c?.pre[0].stage, c?.revisionCount], [0, 5, "不明", 1]);
});
it("block を数える", () => eq(compactFinalCheck({ issues: [{ code: "COMPANY_FACT_CONTRADICTION", pass: "anomaly_scan", severity: "block", evidence: "x" }] })?.blocks, 1));
it("壊れた形は null／配列でない issues は空", () => { eq(compactFinalCheck("x"), null); eq(compactFinalCheck([1]), null); eq(compactFinalCheck({ issues: "壊れた" })?.final.length, 0); });
it("画面の1行", () => eq(finalCheckLine(compactFinalCheck(CHECK_RAW)), "文脈 MISSED_QUESTION・文脈 STAFF_REQUEST_OMITTED・ルール NAME_MISMATCH（修正前 4件）"));

console.log("businessMinutesBetween（日本時間 10〜19時）");
it("同じ日の営業時間の中", () => eq(businessMinutesBetween(jst("2026-10-01", "13:00"), jst("2026-10-01", "14:17")), 77));
it("夜に来た発言は翌朝10時から数える", () => eq(businessMinutesBetween(jst("2026-09-30", "22:30"), jst("2026-10-01", "10:45")), 45));
it("営業時間前に来て開店後に返した", () => eq(businessMinutesBetween(jst("2026-10-01", "08:00"), jst("2026-10-01", "10:30")), 30));
it("日をまたぐ（18:00 → 翌11:00 ＝ 60＋60）", () => eq(businessMinutesBetween(jst("2026-09-30", "18:00"), jst("2026-10-01", "11:00")), 120));
it("逆向き・読めない時は0", () => { eq(businessMinutesBetween(jst("2026-10-01", "12:00"), jst("2026-10-01", "11:00")), 0); eq(businessMinutesBetween("x", "y"), 0); });

console.log("calendarChecks（本番の calendar_events の形）");
const CONV_A = "95019eb8-4dc3-4d90-9f5b-0b76b6a43ac0";
const CONV_B = "84434172-f7ab-4298-8d2b-2d013288fc1d";
const EV: WatchCalEvent[] = [
  // 待ち合わせの後に自動で作った予定（10/2 11:00 大阪難波Noah）と、内覧調整の未確定の予定が残っている（id 930）
  { id: 932, conversation_id: CONV_A, event_type: "viewing", title: "野口 内覧", start_at: "2026-10-02T02:00:00+00:00", end_at: null, all_day: false, is_done: false, notes: "【物件】大阪難波Noah 203号室 / 内覧方法: 未入力\n住所: 大阪府大阪市浪速区稲荷1丁目10番24号", created_at: "2026-09-30T05:00:00Z" },
  { id: 930, conversation_id: CONV_A, event_type: "viewing", title: "野口 お部屋ご案内 10/4(日) 13:30〜15:30", start_at: "2026-10-04T04:30:00+00:00", end_at: null, all_day: false, is_done: false, notes: "件数: 1件\n物件: （未確定）（現地）", created_at: "2026-09-30T04:00:00Z" },
  // 同じ日の2件（重複の疑い）
  { id: 894, conversation_id: CONV_A, event_type: "viewing", start_at: "2026-09-29T02:00:00+00:00", end_at: null, all_day: false, is_done: true, notes: "【物件】大阪難波Noah 203号室 / 内覧方法: AL\n住所: 大阪府大阪市浪速区稲荷1丁目10番24号" },
  { id: 895, conversation_id: CONV_A, event_type: "viewing", start_at: "2026-09-29T05:00:00+00:00", end_at: null, all_day: false, is_done: true, notes: "【物件】大阪難波Noah 203 / 現地" },
  // 時間確保 18:00〜20:00（枠の外・id 831）
  { id: 831, conversation_id: "9b9b81ba", event_type: "viewing", start_at: "2026-09-28T09:00:00+00:00", end_at: "2026-09-28T11:00:00+00:00", all_day: false, is_done: true, notes: "【時間確保】\n候補: 9/28(月) 18:00〜20:00" },
  // 10/5 15:00 住之江区（id 934）の前に 14:00 松原市の内覧（区が違うのに1時間）
  { id: 877, conversation_id: "110b3053", event_type: "viewing", start_at: "2026-10-05T05:00:00+00:00", end_at: null, all_day: false, is_done: false, notes: "【物件】TC天美南 / 内覧方法: 未入力\n住所: 大阪府松原市天美南5丁目12-10" },
  { id: 934, conversation_id: CONV_B, event_type: "viewing", start_at: "2026-10-05T06:00:00+00:00", end_at: null, all_day: false, is_done: false, notes: "【物件】安立荘（アンリュウソウ） 203号室 / 内覧方法: 未入力\n住所: 大阪府大阪市住之江区安立2丁目7-29", created_at: "2026-09-30T10:00:00Z" },
  // 【必ず】の連絡は内覧の予定として数えない（id 587）
  { id: 587, conversation_id: "d3a56a97", event_type: "viewing", start_at: "2026-09-30T01:00:00+00:00", end_at: null, all_day: false, is_done: true, notes: "【必ず】申込連絡" },
];
const NOW = Date.parse("2026-10-01T03:00:00Z");
const found = calendarChecks({
  events: EV,
  meetings: [{ conversation_id: CONV_A, sent_at: "2026-09-30T05:00:00Z" }, { conversation_id: "no-event-conv", sent_at: "2026-09-30T06:00:00Z" }],
  cancelRequests: [{ conversation_id: CONV_B, at: "2026-10-01T01:00:00Z", text: "すみません内覧キャンセルでお願いします" }],
  nowMs: NOW,
});
const codes = (c: string) => found.filter((f) => f.code === c);
it("C1: 待ち合わせを送ったのに予定が無い会話だけ", () => eq(codes("C1").map((f) => f.conversation_id), ["no-event-conv"]));
it("C2: 待ち合わせの後も未確定の予定（930）", () => eq(codes("C2").map((f) => f.event_ids), [[930]]));
it("C3: 同じ日に2件（894・895）", () => eq(codes("C3").map((f) => f.event_ids), [[894, 895]]));
it("C4: 時間確保 18:00〜20:00 が枠の外", () => eq(codes("C4").map((f) => f.event_ids[0]), [831]));
it("C5: 松原市 14:00 → 住之江区 15:00（間 30分）", () => eq(codes("C5").map((f) => f.detail), ["14:00 松原市 → 15:00 大阪市住之江区（間 30分）"]));
it("C6: 取りやめの発言の後も 10/5 の予定が残る", () => eq(codes("C6").map((f) => f.event_ids), [[934]]));
it("重い順（C6 が先頭）", () => eq(found[0].code, "C6"));
it("取りやめの後に作り直した予定は C6 にしない", () => {
  const f = calendarChecks({ events: [{ ...EV[6], created_at: "2026-10-01T02:00:00Z" }], cancelRequests: [{ conversation_id: CONV_B, at: "2026-10-01T01:00:00Z" }], nowMs: NOW });
  eq(f.filter((x) => x.code === "C6").length, 0);
});

console.log("openPromises（sent_facts の形）");
const FACTS = [
  { conversation_id: "a", kind: "confirmation_promised", status: "promised", sent_at: "2026-09-29T01:00:00Z", evidence: "管理会社に確認させて頂きます" },
  { conversation_id: "a", kind: "confirmation_reported", status: "done", sent_at: "2026-09-29T05:00:00Z" },
  { conversation_id: "b", kind: "pickup_declared", status: "promised", sent_at: "2026-09-28T01:00:00Z", evidence: "ピックアップしてお送りさせて頂きます" },
  { conversation_id: "c", kind: "estimate_declared", status: "promised", sent_at: "2026-09-30T23:00:00Z", evidence: "御見積書を作成しお送りさせて頂きます" },
  { conversation_id: "c", kind: "estimate_sent", status: "done", sent_at: "2026-09-20T00:00:00Z" },
];
const op = openPromises({ facts: FACTS, lastCustomerAt: new Map([["b", "2026-09-28T00:00:00Z"]]), nowMs: NOW });
it("果たした約束（a）は出ない・前の送付では果たしていない（c）", () => eq(op.map((p) => p.conversation_id), ["b", "c"]));
it("時間の長い順・止まったお客様の印", () => eq(op.map((p) => [p.hours, p.customerActive]), [[74, false], [4, true]]));

console.log("draftVsStaff（edit-diff の物差し）");
it("完全一致", () => eq(draftVsStaff("はい😊！！\nお手隙の際にご査収ください😌！！", "はい😊！！\nお手隙の際にご査収ください😌！！").kind, "same"));
it("手直しあり（似ている度つき）", () => { const r = draftVsStaff("YUMAさん\n\n空室状況確認させて頂きます😊！！", "YUMAさん\n\n募集状況確認させて頂きます😊！！"); eq([r.kind, (r.sim ?? 0) > 0.5], ["edited", true]); });
it("下書きなし（手打ち）・印だけ・まだ返していない", () => { eq(draftVsStaff("", "送った").kind, "no_draft"); eq(draftVsStaff(null, "送った", "[AIX誘導中]").kind, "sentinel"); eq(draftVsStaff("案", "").kind, "no_staff"); });

console.log("searchWatch");
it("条件そのもの・今回だけ・種類", () => { eq(searchNeedReason({ change_scope: "permanent" }), "条件そのものの言い直し"); eq(searchNeedReason({ change_scope: "temporary" }), "今回だけの条件の調整"); eq(searchNeedReason({ change_type: "none" }), null); eq(searchNeedReason(null), null); });
const sw = searchWatch({
  needs: [
    { conversation_id: "x", property_customer_id: "p1", at: "2026-10-01T00:00:00Z", reason: "今回だけの条件の調整" },
    { conversation_id: "y", property_customer_id: "p2", at: "2026-10-01T00:00:00Z", reason: "条件そのものの言い直し" },
    { conversation_id: "z", property_customer_id: "p3", at: "2026-10-01T02:50:00Z", reason: "条件そのものの言い直し" },
  ],
  audits: [
    { property_customer_id: "p1", created_at: "2026-09-30T00:00:00Z", status: "finished", result: { sendable_rows: 3 } },
    { property_customer_id: "p2", created_at: "2026-10-01T01:00:00Z", status: "finished", result: { sendable_rows: 0 }, site: "itandi" },
    { property_customer_id: "p2", created_at: "2026-09-30T01:00:00Z", status: "finished", result: { sendable_rows: 10 } },
    { property_customer_id: "p4", created_at: "2026-10-01T01:00:00Z", status: "finished", result: { sendable_rows: null, sent_count: 4 } },
  ],
  pickups: [
    { conversation_id: "x", created_at: "2026-09-30T16:00:00Z", status: "pending", complete_group_id: "g1" },
    { conversation_id: "x", created_at: "2026-09-30T16:01:00Z", status: "pending", complete_group_id: "g1" },
    { conversation_id: "x", created_at: "2026-09-30T16:02:00Z", status: "sent", complete_group_id: "g1", sent_at: "2026-09-30T17:00:00Z" },
    { conversation_id: "w", created_at: "2026-09-30T16:00:00Z", status: "pending", complete_group_id: null },
    // v: 前のまとめ（g0）は送った・新しいまとめ（g2）はまだ1件も送っていない → g2 の2件
    { conversation_id: "v", created_at: "2026-09-29T10:00:00Z", status: "sent", complete_group_id: "g0", sent_at: "2026-09-29T11:00:00Z" },
    { conversation_id: "v", created_at: "2026-09-30T10:00:00Z", status: "pending", complete_group_id: "g2" },
    { conversation_id: "v", created_at: "2026-09-30T10:01:00Z", status: "pending", complete_group_id: "g2" },
    { conversation_id: "v", created_at: "2026-09-30T10:02:00Z", status: "pending", complete_group_id: "g2", expired_at: "2026-09-30T12:00:00Z" },
  ],
  nowMs: NOW,
});
it("検索が要るのに動いていない（x）・待つ間（z）は出さない", () => eq(sw.idle.map((n) => [n.conversation_id, n.lastSearchAt]), [["x", "2026-09-30T00:00:00Z"]]));
it("最新の検索で送れる物件0（p2）・読めない（null）は数えない", () => eq(sw.empty.map((e) => e.property_customer_id), ["p2"]));
it("送れる資料: 1件でも送ったまとめ（x）は数えない・新しい未送付のまとめ（v）だけ・期限切れは除く", () => eq(sw.ready, [{ conversation_id: "v", count: 2, latestAt: "2026-09-30T10:02:00Z" }]));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
