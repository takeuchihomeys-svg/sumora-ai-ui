// 2026-09-27 竹内「ピックアップや物件オススメで送った物件は、送ったのが分かるバッジ」＋「送信済みも1件選んで物件オススメで送れるように」
// 実行: npx tsx app/lib/__tests__/pickup-sent-badge.test.ts
import { sentBadgesFor, jstMonthDay, type SentHistRowForBadge } from "../pickup-sent-badge";
import { planPickupAixSelection, pickupAixSelectionLabel, isPickupCheckable, buildPickupAixHref } from "../pickup-aix-handoff";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ""}`); }
}
const WJ = String.fromCharCode(0x2060);
const plain = (s: string) => s.split(WJ).join("");

// 実物（2026-09-27・野口さんのお客様・itandi のモノトーン難波 1002＝property_pickups 753）
const monotone = { id: 753, property_name: "モノトーン難波", room_no: "1002", status: "sent", sent_at: "2026-09-27T10:52:08.901+00:00" };
const histPickup: SentHistRowForBadge = { property_name: "モノトーン難波", room_no: "1002", channel: "pickup", delivery: "customer", source: "aix:property_send", sent_at: "2026-09-27T10:52:10.166+00:00", pickup_id: 753 };
const histShared: SentHistRowForBadge = { property_name: "モノトーン難波", room_no: "1002", channel: "extension_group", delivery: "shared", source: "line_group", sent_at: "2026-09-27T10:43:34.931896+00:00", pickup_id: null };

console.log("■ バッジ（出所は sent_properties）");
{
  const b = sentBadgesFor(monotone, [histPickup, histShared]);
  t("ピックアップで送った 9/27（共有の行はバッジにしない）", b.length === 1 && b[0].kind === "pickup" && b[0].label === "📤 ピックアップで送った 9/27", b);
}
{
  const b = sentBadgesFor(monotone, [histShared]);
  t("共有だけ＋送った印 → どの AIX か分からない「📨 送った 9/27」", b.length === 1 && b[0].kind === "other" && b[0].label === "📨 送った 9/27", b);
}
{
  // オススメは pickup_id が付かない（画像の読み取りが名前で書く・channel=recommendation・source=vision）
  const rec: SentHistRowForBadge = { property_name: "モノトーン難波", room_no: "1002", channel: "recommendation", delivery: "customer", source: "vision", sent_at: "2026-09-28T03:00:00+00:00", pickup_id: null };
  const b = sentBadgesFor(monotone, [rec, histPickup, histShared]);
  t("両方で送った → 両方（ピックアップ → オススメの順・日付はそれぞれ）", b.map((x) => x.label).join("｜") === "📤 ピックアップで送った 9/27｜🏠 オススメで送った 9/28", b);
}
{
  const pend = { ...monotone, id: 999, status: "pending", sent_at: null };
  t("別の回の同じ部屋（未送信の行）にも出す（名前＋号室で当てる）", sentBadgesFor(pend, [histPickup]).map((x) => x.kind).join() === "pickup");
  t("同じ建物の別の部屋には出さない", sentBadgesFor({ ...pend, room_no: "0801" }, [histPickup]).length === 0);
  t("別の建物には出さない", sentBadgesFor({ ...pend, property_name: "モノトーン心斎橋" }, [histPickup]).length === 0);
  t("号室の表記ゆれ（0602 と 602）は同じ部屋", sentBadgesFor({ ...pend, property_name: "メインステージ新大阪", room_no: "602" }, [{ ...histPickup, property_name: "メインステージ新大阪", room_no: "0602", pickup_id: null, source: "vision" }]).length === 1);
  t("未送信・表に無い → バッジなし", sentBadgesFor(pend, []).length === 0 && sentBadgesFor(pend, null).length === 0);
  t("見送り → バッジなし", sentBadgesFor({ ...pend, status: "skipped" }, [histShared]).length === 0);
}
{
  const old: SentHistRowForBadge = { ...histPickup, channel: null, source: "aix:property_recommendation", pickup_id: null };
  t("channel が NULL の古い行は source から（オススメ）", sentBadgesFor(monotone, [old]).map((x) => x.kind).join() === "recommendation");
  const two = sentBadgesFor(monotone, [{ ...histPickup, sent_at: "2026-09-25T01:00:00Z" }, histPickup]);
  t("同じ種類を2回 → 1つ・新しい日", two.length === 1 && two[0].label.endsWith("9/27"), two);
}
t("JST の日付（UTC 15:30 は翌日）", jstMonthDay("2026-09-27T15:30:00Z") === "9/28" && jstMonthDay(null) === "");

console.log("■ 送信済みを1件選んで物件オススメで送る");
const items = [{ id: 1, status: "pending" }, { id: 2, status: "pending" }, { id: 753, status: "sent" }, { id: 754, status: "sent" }, { id: 5, status: "skipped" }];
{
  const s = planPickupAixSelection(items, { 753: true });
  t("送信済み1件だけ → 物件オススメで送り直す", s.kind === "resend_recommendation" && s.id === 753, s);
  t("ボタン「🏠 この物件を AIX物件オススメで送る」", pickupAixSelectionLabel(s) === "🏠 この物件を AIX物件オススメで送る");
  t("渡る URL は aix=property_recommendation（1件）", buildPickupAixHref({ conversationId: "95019eb8-4dc3-4d90-9f5b-0b76b6a43ac0", pickupIds: [753], batchId: "b" }) === "/?conv=95019eb8-4dc3-4d90-9f5b-0b76b6a43ac0&aix=property_recommendation&pickup=753&batch=b");
}
{
  const s = planPickupAixSelection(items, { 1: true, 2: true, 753: true });
  t("ピックアップ（複数）に送信済みは混ぜない", s.kind === "send" && s.ids.join() === "1,2" && s.droppedSent === 1, s);
  t("ボタンは未送信の件数（2件）", s.kind === "send" && plain(pickupAixSelectionLabel(s)) === "📤 AIX物件ピックアップ（2件）");
  const s1 = planPickupAixSelection(items, { 1: true, 753: true });
  t("未送信1件＋送信済み1件 → 未送信の1件だけ（送信済みは落とす）", s1.kind === "send" && s1.ids.join() === "1", s1);
}
{
  const s = planPickupAixSelection(items, { 753: true, 754: true });
  t("送信済み2件 → 渡さない（オススメは1件だけ）", s.kind === "too_many_sent" && s.sent === 2, s);
  t("見送りはチェックされていても数えない", planPickupAixSelection(items, { 5: true }).kind === "none");
  t("何もなし → none", planPickupAixSelection(items, {}).kind === "none" && /チェック/.test(pickupAixSelectionLabel({ kind: "none" })));
}
t("チェック欄: 未送信・送信済みは押せる／見送りは押せない", isPickupCheckable("pending") && isPickupCheckable("sent") && !isPickupCheckable("skipped"));

console.log("■ 配線（画面）");
const src = readFileSync(join(__dirname, "../../components/PickupReview.tsx"), "utf8");
t("カードのバッジは sentBadgesFor(it, open?.sent_history)", src.includes("sentBadgesFor(it, open?.sent_history)"));
t("チェック欄は isPickupCheckable", src.includes("disabled={!isPickupCheckable(it.status)}"));
t("送る時は planPickupAixSelection（送信済みを混ぜない）", /const sel = only \? null : planPickupAixSelection\(b\.items, checked\)/.test(src));
t("小さな灰色の「送信済」はもう出さない", !src.includes(`"送信済" : "見送り"`));
t("既定のチェック・質の高い10件は未送信だけのまま（pickQualityTop・defaultAixChecks は触らない）", src.includes("defaultAixChecks(") && src.includes("pickQualityTop("));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
