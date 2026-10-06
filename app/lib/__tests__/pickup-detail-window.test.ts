// app/lib/__tests__/pickup-detail-window.test.ts — 売上サポの詳細を直近24時間の回から読む（実行: npx tsx app/lib/__tests__/pickup-detail-window.test.ts）
// 2026-10-06 ⑫ 竹内「詳細で開くときは24時間以内に限定して最初読み取るのはどうか」
import { chooseDetailRowIds } from "../pickup-detail-window";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };
const now = Date.parse("2026-10-06T08:00:00Z");
const row = (id: number, at: string, batch: string, status = "pending") => ({ id, created_at: at, batch_id: batch, status, site: "realpro" });

{
  // 3日前・2日前・今日の朝・今日の昼の4回
  const rows = [
    row(1, "2026-10-03T01:00:00Z", "b1", "sent"), row(2, "2026-10-03T01:00:01Z", "b1"),
    row(3, "2026-10-04T01:00:00Z", "b2", "skipped"),
    row(4, "2026-10-06T00:00:00Z", "b3"), row(5, "2026-10-06T00:00:01Z", "b3"),
    row(6, "2026-10-06T06:00:00Z", "b4"),
  ];
  const r = chooseDetailRowIds(rows, new Map(), { nowMs: now, hours: 24, maxRounds: 3 });
  t("24時間以内の回（今日の2回）の行だけ重い列を読む", JSON.stringify(r.ids.sort()) === JSON.stringify([4, 5, 6]), JSON.stringify(r));
  t("もっと前の回がある", r.hasMore === true && r.rounds === 2);
  t("未確認の数は全部の行で数える", r.pending === 4);
}
{
  // yasuki の形: 24時間以内の回が無い → 一番新しい1回だけ
  const rows = [row(1, "2026-09-28T05:00:00Z", "a"), row(2, "2026-09-30T05:00:00Z", "b"), row(3, "2026-10-02T05:00:00Z", "c"), row(4, "2026-10-02T05:00:02Z", "c")];
  const r = chooseDetailRowIds(rows, new Map(), { nowMs: now, hours: 24 });
  t("24時間以内が無い → 一番新しい1回（何も出ないにしない）", JSON.stringify(r.ids.sort()) === JSON.stringify([3, 4]) && r.hasMore === true, JSON.stringify(r));
}
{
  // まとめの回（同じ complete_group_id）は1つとして数える＝片方だけ出さない
  const rows = [row(1, "2026-10-05T07:00:00Z", "r1"), row(2, "2026-10-06T07:30:00Z", "i1")];
  const roundOf = new Map([["r1", "G"], ["i1", "G"]]);
  const r = chooseDetailRowIds(rows, roundOf, { nowMs: now, hours: 24 });
  t("まとめの回は丸ごと（24時間より前に始まった半分も出す）", JSON.stringify(r.ids.sort()) === JSON.stringify([1, 2]) && r.hasMore === false, JSON.stringify(r));
}
t("行が無い → 空", chooseDetailRowIds([], new Map(), { nowMs: now }).ids.length === 0);
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
