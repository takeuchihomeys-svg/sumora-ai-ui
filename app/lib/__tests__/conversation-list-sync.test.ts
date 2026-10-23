// app/lib/__tests__/conversation-list-sync.test.ts — 会話一覧の読み込みを変わった所だけにする決まり（実行: npx tsx app/lib/__tests__/conversation-list-sync.test.ts）
import { lastCustomerTs, badgeMessages, pollPlan, deltaSinceIso, upsertConversationRows, FULL_REFRESH_EVERY_MS, deltaNeedsLastCustomerRefresh, listPollLeanEnabled, rtUpdatePlan, convUiFingerprint, convDraftSignature, rtLeanEnabled, CONV_UI_KEYS } from "../conversation-list-sync";
import { isAixListBadge } from "../aix-button-view";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };

const msgs = [
  { sender: "customer", rawCreatedAt: "2026-10-06T01:00:00Z" },
  { sender: "staff", rawCreatedAt: "2026-10-06T01:05:00Z" },
];
t("読み込んだメッセージのお客様の最後", lastCustomerTs(msgs, null) === "2026-10-06T01:00:00Z");
t("DB の集計の方が新しければそちら", lastCustomerTs(msgs, "2026-10-06T02:00:00Z") === "2026-10-06T02:00:00Z");
t("メッセージ未読み込みは DB の集計", lastCustomerTs([], "2026-10-05T00:00:00Z") === "2026-10-05T00:00:00Z");
t("どちらも無ければ null", lastCustomerTs([], null) === null);

t("鮮度用: 読み込んでいない会話は DB の時刻を1件の形で", JSON.stringify(badgeMessages([], "2026-10-06T02:00:00Z")) === JSON.stringify([{ sender: "customer", rawCreatedAt: "2026-10-06T02:00:00Z" }]));
t("鮮度用: 読み込んだメッセージが最新ならそのまま", badgeMessages(msgs, "2026-10-06T01:00:00Z") === msgs);
{
  // 旧（全メッセージを持っている時）と同じ判定になる: 分析より後にお客様の発言がある → バッジを出さない
  const meta = { action: "property_send", reply_mode: "aix", analyzed_msg_ts: "2026-10-06T01:00:00Z" };
  const full = [{ sender: "customer", rawCreatedAt: "2026-10-06T01:00:00Z" }, { sender: "customer", rawCreatedAt: "2026-10-06T03:00:00Z" }];
  const old = isAixListBadge({ meta: meta as never, lastSender: "customer", messages: full });
  const now = isAixListBadge({ meta: meta as never, lastSender: "customer", messages: badgeMessages([], "2026-10-06T03:00:00Z") as never });
  t("AIX バッジ: 全メッセージありの旧と、DB の時刻だけの新で同じ（古い判断は出さない）", old === now && now === false, JSON.stringify({ old, now }));
  const fresh = isAixListBadge({ meta: meta as never, lastSender: "customer", messages: badgeMessages([], "2026-10-06T01:00:00Z") as never });
  t("AIX バッジ: 最新の発言を見た判断は出す", fresh === true);
}

t("初回は丸ごと", pollPlan(1_000_000, null) === "full");
t("5分たつまでは差分", pollPlan(1_000_000 + FULL_REFRESH_EVERY_MS - 1, 1_000_000) === "delta");
t("5分たったら丸ごと", pollPlan(1_000_000 + FULL_REFRESH_EVERY_MS, 1_000_000) === "full");

t("差分の起点は一番新しい更新時刻の90秒前", deltaSinceIso([{ updatedAt: "2026-10-06T01:00:00Z" }, { updatedAt: "2026-10-06T02:00:00Z" }]) === "2026-10-06T01:58:30.000Z");
t("更新時刻が無ければ null（丸ごとに落とす）", deltaSinceIso([{ updatedAt: null }]) === null);

{
  type C = { id: string; updatedAt?: string; messages: string[]; name: string };
  const prev: C[] = [
    { id: "a", updatedAt: "2026-10-06T03:00:00Z", messages: ["m1", "m2"], name: "A" },
    { id: "b", updatedAt: "2026-10-06T02:00:00Z", messages: [], name: "B" },
  ];
  const rows = [{ id: "b", updated_at: "2026-10-06T04:00:00Z", name: "B2" }, { id: "c", updated_at: "2026-10-06T01:00:00Z", name: "C" }];
  const next = upsertConversationRows(prev, rows, (r) => r.id, (r, ex) => ({ id: r.id, updatedAt: r.updated_at, messages: ex?.messages ?? [], name: r.name }));
  t("変わった行だけ差し替え・新しい行は足す・新しい順", next.map((c) => c.id).join(",") === "b,a,c" && next[0].name === "B2", JSON.stringify(next));
  t("変わっていない行は同じ物（再描画しない）", next[1] === prev[0]);
  const keep = upsertConversationRows(prev, [{ id: "a", updated_at: "2026-10-06T05:00:00Z", name: "A2" }], (r) => r.id, (r, ex) => ({ id: r.id, updatedAt: r.updated_at, messages: ex?.messages ?? [], name: r.name }));
  t("読み込み済みのメッセージは残す", keep[0].messages.length === 2 && keep[0].name === "A2");
  t("行が無ければ同じ配列", upsertConversationRows(prev, [], (r: { id: string }) => r.id, () => prev[0]) === prev);
}

// 2026-10-23 差分で同じ行が毎回返る時は集計（RPC）を取り直さない
{
  const known = new Map<string, string | undefined>([["a", "2026-10-23T01:00:00Z"], ["b", "2026-10-23T01:00:00Z"]]);
  t("同じ行（更新時刻が手元と同じ）→ 取り直さない", !deltaNeedsLastCustomerRefresh(known, [{ id: "a", last_sender: "customer", updated_at: "2026-10-23T01:00:00Z" }]));
  t("お客様の行の更新時刻が新しい → 取り直す", deltaNeedsLastCustomerRefresh(known, [{ id: "a", last_sender: "customer", updated_at: "2026-10-23T01:05:00Z" }]));
  t("手元に無いお客様の行 → 取り直す", deltaNeedsLastCustomerRefresh(known, [{ id: "z", last_sender: "customer", updated_at: "2026-10-23T01:05:00Z" }]));
  t("スタッフの行だけ変わった → 取り直さない", !deltaNeedsLastCustomerRefresh(known, [{ id: "b", last_sender: "staff", updated_at: "2026-10-23T01:05:00Z" }]));
  t("NEXT_PUBLIC_LIST_POLL_LEAN=off で止まる", !listPollLeanEnabled("off") && listPollLeanEnabled(undefined));
}

{
  // 2026-10-23 RT_LEAN: 会話の行の Realtime の更新を画面に当てるかの判断
  const base: Record<string, unknown> = Object.fromEntries(CONV_UI_KEYS.map((k) => [k, null]));
  Object.assign(base, { id: 1, customer_name: "A", last_message: "こんにちは", updated_at: "2026-10-23T01:00:00Z", ai_draft: "下書き", brain_analyzed_at: "2026-10-23T01:00:00Z", last_brain_meta: { a: 1 } });
  const fp = convUiFingerprint(base)!; const ds = convDraftSignature(base)!;
  const bgOnly = { ...base, brain_analyzed_at: "2026-10-23T02:00:00Z", last_brain_meta: { a: 2 }, draft_attempted_at: "x", ai_draft_check: { big: true } };
  const p1 = rtUpdatePlan(fp, ds, null, bgOnly);
  t("裏の列だけ変わった更新（脳の分析・下書きの確認）→ 読み飛ばす", p1.skip && !p1.draftChanged);
  const p2 = rtUpdatePlan(fp, ds, null, { ...base, last_message: "次の文", updated_at: "2026-10-23T02:00:00Z" });
  t("一覧の列が変わった → 当てる（急がない＝まとめる）", !p2.skip && !p2.draftChanged && !p2.urgent);
  const p3 = rtUpdatePlan(fp, ds, null, { ...base, ai_draft: "新しい下書き" });
  t("下書きが変わった → すぐ当てて下書きの仕事もする", !p3.skip && p3.draftChanged && p3.urgent);
  const p4 = rtUpdatePlan(fp, ds, null, { ...base, suggested_aix_meta: { reply_mode: "aix" } });
  t("AIX の判断が変わった → すぐ", !p4.skip && p4.draftChanged && p4.urgent);
  const p5 = rtUpdatePlan(fp, ds, null, { ...base, call_tapped_at: "2026-10-23T02:00:00Z" });
  t("電話の印 → すぐ（下書きの仕事はしない）", !p5.skip && p5.urgent && !p5.draftChanged);
  const partial = { ...base }; delete partial.has_viewed;
  t("列が欠けた行（分からない）→ 必ず当てる", !rtUpdatePlan(fp, ds, null, partial).skip && convUiFingerprint(partial) === null);
  const p6 = rtUpdatePlan(undefined, undefined, undefined, bgOnly);
  t("手元に記録が無い会話 → 当てて下書きの仕事もする（旧と同じ）", !p6.skip && p6.draftChanged);
  t("is_flagged だけ変わっても当てる", !rtUpdatePlan(fp, ds, null, { ...base, is_flagged: true }).skip);
  t("NEXT_PUBLIC_RT_LEAN=off で止まる", !rtLeanEnabled("off") && rtLeanEnabled(undefined) && rtLeanEnabled("on"));
}

console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
