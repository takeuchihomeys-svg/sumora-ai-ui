// app/lib/__tests__/conversation-order.test.ts
// 一覧の並び順（app/lib/conversation-order.ts）。
// 2026-09-18 竹内「メッセージがきているお客さんで時間最近の方が上。この必ずはメッセージが来ていない中なら
//   メッセージ来ていない中で上、メッセージ来ているならメッセージ来ている中で上にする」
// 実行: npx tsx app/lib/__tests__/conversation-order.test.ts
import { compareConversationOrder, hasIncomingMessage, sortMsOf, type ConversationOrderKey } from "../conversation-order";
import { oldestPromiseAtMs } from "../promise-calendar";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

const NOW = Date.parse("2026-09-18T18:00:00+09:00");
/** days 日前の約束 */
const p = (days: number) => [{ start_at: new Date(NOW - days * 86_400_000).toISOString() }];

function row(o: { id: string; incoming: boolean; promiseDays?: number | null; at: string }) {
  return {
    id: o.id,
    hasIncoming: o.incoming,
    promiseAt: o.promiseDays == null ? null : oldestPromiseAtMs(p(o.promiseDays)),
    updatedAtMs: sortMsOf(o.at),
  };
}
const order = (rows: Array<ConversationOrderKey & { id: string }>) =>
  [...rows].sort(compareConversationOrder).map((r) => r.id).join(" > ");

console.log("── ① メッセージが来ているお客様が常に上");
{
  const incomingOld = row({ id: "来てる(3日前)", incoming: true, at: "2026-09-15T10:00:00+09:00" });
  const noneNew = row({ id: "来てない(さっき)", incoming: false, at: "2026-09-18T17:59:00+09:00" });
  t("返事待ちは、やり取りが古くても上", compareConversationOrder(incomingOld, noneNew) < 0);

  // ★ 同日中の最初の実装はここが逆だった（【必ず】が一覧全体の先頭に出て、返事待ちを押し下げていた）
  const nonePromise = row({ id: "来てない+必ず", incoming: false, promiseDays: 3, at: "2026-09-15T10:00:00+09:00" });
  const incomingPlain = row({ id: "来てる", incoming: true, at: "2026-09-18T17:00:00+09:00" });
  t("【必ず】でも、メッセージが来ている人を飛び越えない",
    compareConversationOrder(incomingPlain, nonePromise) < 0);
}

console.log("── ② 【必ず】は「その組の中」で上");
{
  const rows = [
    row({ id: "来てる+必ず", incoming: true, promiseDays: 2, at: "2026-09-16T10:00:00+09:00" }),
    row({ id: "来てる(最新)", incoming: true, at: "2026-09-18T17:59:00+09:00" }),
    row({ id: "来てない+必ず", incoming: false, promiseDays: 3, at: "2026-09-15T10:00:00+09:00" }),
    row({ id: "来てない(最新)", incoming: false, at: "2026-09-18T17:50:00+09:00" }),
  ];
  t("来てる+必ず > 来てる > 来てない+必ず > 来てない",
    order(rows) === "来てる+必ず > 来てる(最新) > 来てない+必ず > 来てない(最新)", order(rows));
}

console.log("── ③ 【必ず】どうしは放置が長い（約束が古い）順");
{
  const rows = [
    row({ id: "必ず1日", incoming: true, promiseDays: 1, at: "2026-09-18T17:00:00+09:00" }),
    row({ id: "必ず3日", incoming: true, promiseDays: 3, at: "2026-09-16T09:00:00+09:00" }),
    row({ id: "必ず2日", incoming: true, promiseDays: 2, at: "2026-09-17T09:00:00+09:00" }),
  ];
  t("古い約束ほど上", order(rows) === "必ず3日 > 必ず2日 > 必ず1日", order(rows));
}

console.log("── ④ 残りは直近やり取り順（従来どおり）");
{
  const rows = [
    row({ id: "16:00", incoming: true, at: "2026-09-18T16:00:00+09:00" }),
    row({ id: "17:30", incoming: true, at: "2026-09-18T17:30:00+09:00" }),
    row({ id: "12:00", incoming: true, at: "2026-09-18T12:00:00+09:00" }),
  ];
  t("新しい方が上", order(rows) === "17:30 > 16:00 > 12:00", order(rows));
}

console.log("── メッセージが来ているかの判定");
{
  t("最後の発言がお客様", hasIncomingMessage({ lastSender: "customer" }));
  t("最後の発言がスタッフ", !hasIncomingMessage({ lastSender: "staff" }));
  t("lastSender が無ければ最後のメッセージで見る",
    hasIncomingMessage({ lastSender: null, messages: [{ sender: "staff" }, { sender: "customer" }] }));
  t("メッセージも無ければ来ていない扱い", !hasIncomingMessage({ lastSender: null, messages: [] }));
}

console.log("── 読めない日付で並びを壊さない");
{
  t("読めない日付は 0", sortMsOf("not-a-date") === 0 && sortMsOf(null) === 0 && sortMsOf(undefined) === 0);
  const ok = row({ id: "ok", incoming: true, at: "2026-09-18T17:00:00+09:00" });
  const broken = { id: "broken", hasIncoming: true, promiseAt: null, updatedAtMs: sortMsOf(undefined) };
  t("読めない日付の会話は下に", compareConversationOrder(ok, broken) < 0);
}

console.log("── 実データの並び（9/18 の本番の顔ぶれ）");
{
  const rows = [
    row({ id: "鈴木 祥平(来てる 17:34)", incoming: true, at: "2026-09-18T17:34:00+09:00" }),
    row({ id: "名無しの権兵衛(来てない+必ず2日)", incoming: false, promiseDays: 2, at: "2026-09-15T20:45:00+09:00" }),
    row({ id: "𝒮❦(来てる+必ず2日)", incoming: true, promiseDays: 2, at: "2026-09-18T11:27:00+09:00" }),
    row({ id: "慶次(来てない+必ず2日と少し)", incoming: false, promiseDays: 2.2, at: "2026-09-17T21:31:00+09:00" }),
    row({ id: "まりあ(来てる 17:37)", incoming: true, at: "2026-09-18T17:37:00+09:00" }),
  ];
  t("返事待ちが先・その中で必ず・来ていない組でも必ずが先",
    order(rows) === "𝒮❦(来てる+必ず2日) > まりあ(来てる 17:37) > 鈴木 祥平(来てる 17:34) > 慶次(来てない+必ず2日と少し) > 名無しの権兵衛(来てない+必ず2日)",
    order(rows));
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
