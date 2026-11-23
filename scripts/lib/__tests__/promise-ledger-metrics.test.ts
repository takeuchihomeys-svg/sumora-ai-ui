// npx tsx scripts/lib/__tests__/promise-ledger-metrics.test.ts
// 2026-11-23 作業員L（台帳 #519）: 行動台帳の約束の開いている数・期日超え・72時間で閉じた割合
import assert from "node:assert/strict";
import { promiseStatesOf, summarizePromises, promiseMetricRows, widenPromiseStates, wideCloseOf, type PromiseState } from "../promise-ledger-metrics";

const now = Date.parse("2026-11-23T00:00:00Z");
const iso = (hAgo: number) => new Date(now - hAgo * 36e5).toISOString();
const rows = [
  // 100時間前の確認の約束 → 10時間後に報告（72時間の内に閉じた）
  { conversation_id: "a", kind: "confirmation_promised", status: "promised", sent_at: iso(100), evidence: "募集状況確認させて頂きます" },
  { conversation_id: "a", kind: "confirmation_reported", status: "done", sent_at: iso(90) },
  // 120時間前のピックアップの約束 → まだ（開いている・72時間を過ぎた＝期日超え）
  { conversation_id: "b", kind: "pickup_declared", status: "promised", sent_at: iso(120), evidence: "ピックアップしてお送りさせて頂きます" },
  // 10時間前の見積の約束 → closed_by の印（閉じた）
  { conversation_id: "c", kind: "estimate_declared", status: "promised", sent_at: iso(10), evidence: "御見積書お送りさせて頂きます", detail: { closed_by: "x" } },
  // 5時間前の確認の約束 → まだ（開いている・期日前）
  { conversation_id: "d", kind: "confirmation_promised", status: "promised", sent_at: iso(5), evidence: "確認させて頂きます" },
];
const s = summarizePromises(promiseStatesOf(rows), now);
assert.deepEqual(s, { open: 2, overdue: 1, madeWindow: 2, keptWindow: 1 });
const m = promiseMetricRows(s);
assert.deepEqual(m.map((r) => `${r.metric}=${r.value}/${r.n}`), ["foundation:promise:open=2/2", "foundation:promise:overdue_rate=50/2", "foundation:promise:kept_72h=50/2"]);
console.log("promise-ledger-metrics: ok");

// ─── --wide-close（2026-11-23 作業員L・統括役が承認した②の直し）。本番の番の形を伏せて使う ───
const st = (conv: string, kind: string, hAgo: number, text: string): PromiseState => ({ conv, kind, at: iso(hAgo), closedAt: null, deadlineMs: now - (hAgo - 72) * 36e5, text });
const msg = (sender: string, hAgo: number, text: string, aix = false) => ({ sender, text, created_at: iso(hAgo), is_aix_generated: aix });
const ev = (msgs: ReturnType<typeof msg>[], o: { status?: string | null; sent?: string[] } = {}) => ({ status: o.status ?? "proposing", msgs, sent: (o.sent ?? []).map((x) => ({ sent_at: x })) });
// 手書きの報告「お待たせいたしました…確認が出来ましたので」（d88bc551 の形）→ 確認の約束を閉じる
assert.equal(wideCloseOf(st("w1", "confirmation_promised", 200, "床色確認させて頂きます"), ev([msg("customer", 199, "ありがとうございます"), msg("staff", 190, "〇〇さん お待たせいたしました！！ 2件の床色の確認が出来ましたのでお送りさせて頂きます")]))?.reason, "check_report");
// 「代表から特別に許可をいただき追加で割引」（37677382 の形）
assert.equal(wideCloseOf(st("w2", "confirmation_promised", 150, "代表に確認させて頂きます"), ev([msg("staff", 140, "〇〇さん 代表から特別に許可をいただき追加で割引ができました")]))?.reason, "check_report");
// 経過の報告「管理会社担当者にお電話が繋がらない状況」（110b3053 の形）
assert.equal(wideCloseOf(st("w3", "confirmation_promised", 150, "管理会社に確認させて頂き、確認出来次第ご連絡"), ev([msg("staff", 140, "〇〇さん 未だ管理会社担当者にお電話が繋がらない状況となります")]))?.reason, "check_report");
// 約束の文そのもの（同じ時刻）は数えない・お客様の発言も数えない
assert.equal(wideCloseOf(st("w4", "confirmation_promised", 100, "お待たせ致しました！確認させて頂きます"), ev([msg("staff", 100, "お待たせ致しました！確認させて頂きます"), msg("customer", 90, "確認出来ましたか？")])), null);
// ピックアップ: お客様に届いた送付（sent_properties）で閉じる・約束より前の送付は数えない
assert.equal(wideCloseOf(st("w5", "pickup_declared", 150, "ピックアップさせていただきます"), ev([], { sent: [iso(120)] }))?.reason, "watch");
assert.equal(wideCloseOf(st("w5b", "pickup_declared", 150, "ピックアップさせていただきます"), ev([], { sent: [iso(160)] })), null);
// 見積: 確認の結果が「現在募集に出ていないお部屋」（AIX の文・ea847738 の形）
assert.equal(wideCloseOf(st("w6", "estimate_declared", 200, "御見積書を作成しお送りさせて頂きます"), ev([msg("staff", 190, "お送り頂きました物件3件につきまして募集状況確認させて頂きましたところ、現在募集に出ていないお部屋となっております", true)]))?.reason, "not_listed");
// ピックアップの約束は「募集に出ていない」で閉じない
assert.equal(wideCloseOf(st("w6b", "pickup_declared", 200, "ピックアップしてお送りさせて頂きます"), ev([msg("staff", 190, "現在募集に出ていないお部屋となっております", true)])), null);
// 会話が閉じた（お客様が他社で決めた）→ 数から外す
assert.equal(wideCloseOf(st("w7", "pickup_declared", 200, "ピックアップしてお送りさせて頂きます"), ev([msg("customer", 150, "別の不動産会社で決まりました")]))?.reason, "closed_conv");
// 「新着で募集で次第お送り」は期日の無い約束。「ピックアップ出来次第お送り」は期日あり（閉じない）
assert.equal(wideCloseOf(st("w8", "pickup_declared", 200, "オススメできるお部屋新着で募集で次第お送りさせていただきます"), ev([]))?.reason, "open_ended");
assert.equal(wideCloseOf(st("w9", "pickup_declared", 200, "オススメできるお部屋のピックアップ出来次第お送りさせて頂きます"), ev([msg("customer", 190, "お願いします")])), null);
// 台帳の文（detail.sentence）が100字で切れて「…新着で募集で」で終わる時は evidence の方で見る（fff5b6a3 の形）
assert.equal(wideCloseOf({ ...st("w9b", "pickup_declared", 200, "〇〇周辺全域から1LDK・13万円以内でオススメできるお部屋を新着で募集で"), evidence: "オススメできるお部屋を新着で募集で次第お送りさせていただきます" }, ev([]))?.reason, "open_ended");
// 本当に未履行（お客様のお礼だけ）は開いたまま
assert.equal(wideCloseOf(st("w10", "pickup_declared", 100, "ピックアップしてお送りさせて頂きます"), ev([msg("customer", 99, "宜しくお願い致します。")])), null);
{
  const ps = [st("w1", "confirmation_promised", 100, "確認させて頂きます"), st("w7", "pickup_declared", 100, "ピックアップしてお送りさせて頂きます"), st("w8", "pickup_declared", 100, "新着で募集出次第お送りさせて頂きます"), st("w10", "pickup_declared", 100, "ピックアップしてお送りさせて頂きます")];
  const evs: Record<string, ReturnType<typeof ev>> = { w1: ev([msg("staff", 90, "お待たせ致しました！確認出来ました")]), w7: ev([], { status: "applying" }), w8: ev([]), w10: ev([]) };
  assert.deepEqual(summarizePromises(ps, now), { open: 4, overdue: 4, madeWindow: 4, keptWindow: 0 });
  const w = widenPromiseStates(ps, (c) => evs[c]);
  assert.deepEqual(w.byReason, { watch: 0, check_report: 1, not_listed: 0, closed_conv: 1, open_ended: 1 });
  // 開いている: w8（期日なし）・w10 の2・期日超え w10 の1。閉じた会話 w7 は母数から外す（3）・72時間の内に閉じた w1 の1
  assert.deepEqual(summarizePromises(w.states, now), { open: 2, overdue: 1, madeWindow: 3, keptWindow: 1 });
}
console.log("promise-ledger-metrics wide-close: ok");
