// 2026-11-25 作業員A（台帳 #688）: AIX ごとの状態の札（app/lib/aix-state-card.ts）
// 実行: npx tsx app/lib/__tests__/aix-state-card.test.ts
import { buildAixStateCard, aixStateCardLine, cardGaps, aixStateCardMode } from "../aix-state-card";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };
const now = Date.parse("2026-11-20T03:00:00Z"); // JST 12:00
const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
const card = buildAixStateCard({
  messages: [{ sender: "customer", text: "x", createdAt: iso(200) }, { sender: "customer", text: "y", createdAt: iso(10) }],
  aixRows: [
    { aix_type: "property_send", created_at: iso(30), sent_at: iso(30) },
    { aix_type: "viewing_invite", created_at: iso(300) },
    { aix_type: "property_check_result", check_pattern: "available", created_at: iso(500) },
    { aix_type: "estimate_sheet", created_at: iso(400) },
    { aix_type: "property_check_result", check_pattern: "mgmt_pet", created_at: iso(100) },
    { aix_type: "greeting_viewing", created_at: iso(20) },
    { aix_type: "meeting_place", created_at: iso(5000) }, // 候補日より前の待ち合わせ＝今の日時は未定
  ],
  viewingHistory: [{ scheduled_date: "2026-11-22", scheduled_time: "14:00", status: "scheduled" }],
  lineTasks: [{ task_type: "property_check", status: "pending", created_at: iso(60) }],
}, now);
ok("束: 回数・最後からの分・その後のお客様の返事", card.bundle.count === 1 && card.bundle.lastMinAgo === 30 && card.bundle.replyAfter === true, card.bundle);
ok("内覧: 予定があれば日時は決まった・何日後（JST の日）", card.viewing.decided && card.viewing.daysTo === 2, card.viewing);
ok("内覧: 候補日より前の待ち合わせは今の待ち合わせに数えない・今日の挨拶", !card.viewing.meetingSent && card.viewing.greetingToday);
ok("見積・空室: 空室の確認が見積書より先・結果", card.estimate.checkedBeforeEstimate === true && card.estimate.checkResult === "available", card.estimate);
ok("管理会社: 開いている確認のタスク・最後の答え", card.mgmt.openCheckTasks === 1 && card.mgmt.lastMgmtPattern === "mgmt_pet" && card.mgmt.lastMgmtAnswerMinAgo === 100);
ok("番の時刻より後の記録は入れない", buildAixStateCard({ messages: [], aixRows: [{ aix_type: "property_send", created_at: new Date(now + 60_000).toISOString() }], viewingHistory: [], lineTasks: [] }, now).bundle.count === 0);
ok("札の1行", aixStateCardLine(card).includes("束 1回（最後 30分前・その後の返事 あり）") && aixStateCardLine(card).includes("日時 決まった（2日後）"), aixStateCardLine(card));
const gaps = cardGaps([
  { key: "a", when: "束を送った直後（1時間以内）", lines: "資料にある時は返信" },
  { key: "b", when: "退去予定の部屋の内覧" },
]);
ok("土台の欠け: 札の欄に当たらない条件の言葉だけ（11/25 に資料・退去予定を足した後は 0）", gaps.length === 0, gaps);
ok("札は既定 shadow（記録だけ）・=off で止まる", aixStateCardMode({}) === "shadow" && aixStateCardMode({ AIX_STATE_CARD: "off" }) === "off" && aixStateCardMode({ AIX_STATE_CARD: "on" }) === "on");
// 11/25 土台の欠けを足した欄
const c2 = buildAixStateCard({ messages: [], aixRows: [{ aix_type: "property_send", created_at: iso(120), prop_statuses: ["vacating", "available"] } as never], viewingHistory: [], lineTasks: [], pickups: [{ created_at: iso(200), status: "pending" }, { created_at: iso(30), status: "pending" }, { created_at: iso(10), status: "sent" }] }, now);
ok("送れる候補の数・最後の束より後の候補", c2.candidates.pending === 2 && c2.candidates.newSinceBundle === 1, c2.candidates);
ok("退去予定の部屋", c2.vacating.rooms === 1);
ok("ピックアップを渡さない時は候補は null", card.candidates.pending === null);
ok("欠けの表: 新着・退去予定は札の欄に当たる", cardGaps([{ key: "x", when: "前に送った後の新着", lines: "退去予定（入居中）の部屋" }]).length === 0);
// 11/25 資料にある（aix-state-doc）
const c3 = buildAixStateCard({ messages: [], aixRows: [], viewingHistory: [], lineTasks: [], docPickups: [
  { property_name: "A", created_at: iso(60), terms: { deposit: 0, keyMoney: 1 } as never, pdf_text: "礼金 1ヶ月\n敷金 なし\n駐車場 なし\n保証会社 加入必須（全保連）", image_lines: [] },
  { property_name: "B", created_at: iso(55), terms: { deposit: 1, keyMoney: 0 } as never, pdf_text: "礼金 なし\n敷金 1ヶ月", image_lines: [] },
  { property_name: "Old", created_at: iso(5000), terms: null, pdf_text: "", image_lines: [] },
] }, now);
ok("資料: 最後の束（30分以内）の物件だけ・礼金は全件・駐車場は1件", !!c3.doc && c3.doc.properties === 2 && c3.doc.topics.key_money?.material === 2 && (c3.doc.topics.parking?.material ?? 0) === 1, c3.doc);
ok("資料の1行", aixStateCardLine(c3).includes("最後の束 2件の資料"), aixStateCardLine(c3));
ok("資料を渡さない時は null", card.doc === null);
ok("欠けの表: 資料にあるは札の欄に当たる", cardGaps([{ key: "x", when: "資料にある時は返信" }]).length === 0);
// 11/25 残りの欠け4つ
const c4 = buildAixStateCard({ messages: [{ sender: "customer", text: "前の", createdAt: iso(300) }, { sender: "staff", text: "お送りしました", createdAt: iso(200) }, { sender: "customer", text: "同じマンションの別の部屋は空いてますか？室内の写真ありますか？家賃もう少し下がりませんか", createdAt: iso(5) }],
  aixRows: [{ aix_type: "property_send", check_pattern: "widen", created_at: iso(200) } as never], viewingHistory: [], lineTasks: [],
  docPickups: [{ property_name: "A", room_no: "101", created_at: iso(200), terms: { newBuild: true } as never }, { property_name: "A", room_no: "202", created_at: iso(3000) }] }, now);
ok("頼み: 別の部屋・写真・値下げ（こちらの最後の通の後だけ）", c4.asks.otherRoom && c4.asks.photo && c4.asks.rentNego && !c4.asks.widen, c4.asks);
ok("記録: 最後の束の種類・新築・同じ建物で2部屋", c4.record.lastBundlePattern === "widen" && c4.record.newBuildInBundle === 1 && c4.record.sameBuildingMulti === 1, c4.record);
ok("こちらの最後の通より前の頼みは数えない", !buildAixStateCard({ messages: [{ sender: "customer", text: "家賃下がりますか", createdAt: iso(300) }, { sender: "staff", text: "確認します", createdAt: iso(200) }], aixRows: [], viewingHistory: [], lineTasks: [] }, now).asks.rentNego);
ok("欠けの表: 残り4つも札の欄に当たる", cardGaps([{ key: "x", when: "同じ建物の別の部屋・条件を広げた・手元に無い・頼まれて" }]).length === 0);
console.log(`aix-state-card: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
