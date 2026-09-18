// app/lib/__tests__/conversation-order.test.ts
// 一覧の並び順（app/lib/conversation-order.ts）。
// 2026-09-18 竹内「LINE時間系列バラバラになっているので、読みにくい。本来のLINEのように時間最新順に戻す」
// 実行: npx tsx app/lib/__tests__/conversation-order.test.ts
import { compareConversationOrder, sortMsOf, type ConversationOrderKey } from "../conversation-order";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

const row = (id: string, at: string) => ({ id, updatedAtMs: sortMsOf(at) });
const order = (rows: Array<ConversationOrderKey & { id: string }>) =>
  [...rows].sort(compareConversationOrder).map((r) => r.id).join(" > ");

console.log("── 直近やり取り順（新しい方が上）だけ");
{
  const rows = [
    row("17:37", "2026-09-18T17:37:00+09:00"),
    row("20:19", "2026-09-18T20:19:00+09:00"),
    row("18:08", "2026-09-18T18:08:00+09:00"),
    row("19:37", "2026-09-18T19:37:00+09:00"),
  ];
  t("上から新しい順", order(rows) === "20:19 > 19:37 > 18:08 > 17:37", order(rows));
}

console.log("── 竹内さんが「読みにくい」と言った画面（時刻が前後していた）");
{
  // 旧: 【必ず】を組の中で上げていたため 19:37 → 17:37 → 20:19 → 18:08 と行ったり来たりした
  const rows = [
    row("YUYA(必ず・19:37)", "2026-09-18T19:37:00+09:00"),
    row("まりあ(必ず・17:37)", "2026-09-18T17:37:00+09:00"),
    row("chibi(必ず・20:19)", "2026-09-18T20:19:00+09:00"),
    row("じゅにあ(18:08)", "2026-09-18T18:08:00+09:00"),
    row("𝒮(17:48)", "2026-09-18T17:48:00+09:00"),
  ];
  t("【必ず】があっても順番を飛び越えない",
    order(rows) === "chibi(必ず・20:19) > YUYA(必ず・19:37) > じゅにあ(18:08) > 𝒮(17:48) > まりあ(必ず・17:37)",
    order(rows));
}

console.log("── 読めない日付で並びを壊さない");
{
  t("読めない日付は 0", sortMsOf("not-a-date") === 0 && sortMsOf(null) === 0 && sortMsOf(undefined) === 0);
  const ok = row("ok", "2026-09-18T17:00:00+09:00");
  const broken = { updatedAtMs: sortMsOf(undefined) };
  t("読めない日付の会話は一番下", compareConversationOrder(ok, broken) < 0);
  t("同じ時刻なら順番を入れ替えない（安定）", compareConversationOrder(ok, { updatedAtMs: ok.updatedAtMs }) === 0);
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
