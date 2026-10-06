// app/lib/__tests__/conversation-list-sync.test.ts — 会話一覧の読み込みを変わった所だけにする決まり（実行: npx tsx app/lib/__tests__/conversation-list-sync.test.ts）
import { lastCustomerTs, badgeMessages, pollPlan, deltaSinceIso, upsertConversationRows, FULL_REFRESH_EVERY_MS } from "../conversation-list-sync";
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

console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
