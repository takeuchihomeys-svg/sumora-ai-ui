// app/lib/__tests__/search-audit-timing.test.ts
// 検索の点検の「操作ごとの時刻」の並べ方（search-audit-timing.ts・2026-09-27 v2.5.31）。
// 実行: npx tsx app/lib/__tests__/search-audit-timing.test.ts
// 材料: 点検 22 の実際の段（begin → page:fill_start → page:location → fill_done → result）に、v2.5.31 で足す段（dl:*）を並べた形
import { auditTimeline, summarizeOps, humanGaps } from "../search-audit-timing";

let pass = 0, fail = 0;
const t = (name: string, cond: boolean, extra = "") => { if (cond) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); } };

// 点検 22 の実物の段（届いた順＝ページの段は fill_done の後ろに積まれている）
const S22 = [
  { d: "web_brain", k: "begin", at: 1790473324502 },
  { d: "ok", k: "fill_done", at: 1790473331265 },
  { d: "ward", k: "page:fill_start", at: 1790473328454 },
  { d: "area", k: "page:location", at: 1790473329516 },
  { d: "rows=48 sent=34", k: "result", at: 1790473434724 },
  { d: "ok", k: "finish", at: 1790473434726 },
];
{
  const tl = auditTimeline(S22);
  t("時刻の順に並べ直す（ページの段が fill_done の前に来る）", tl.map((r) => r.k).join() === "begin,page:fill_start,page:location,fill_done,result,finish", tl.map((r) => r.k).join());
  t("始まりからの経過（fill_start 3.952秒）", tl[1].sinceBeginMs === 3952);
  t("前の段との間（location → fill_done 1.749秒）", tl[3].gapMs === 1749);
  t("段が無ければ空", auditTimeline(null).length === 0 && auditTimeline([{ k: "x" }]).length === 0);
}
{
  const base = 1790473331265;
  const steps = [...S22,
    { k: "page:search", at: base - 200 },
    { k: "dl:armed", at: base + 10 }, { k: "dl:results", at: base + 2100 }, { k: "dl:start", at: base + 3000, d: "unsorted" },
    { k: "dl:sort_wait", at: base + 3001, d: "1023" }, { k: "dl:sort_go", at: base + 4030 },
    { k: "dl:page", at: base + 6100, d: "P1" }, { k: "dl:send", at: base + 6101, d: "P1 1/3 n=10" }, { k: "dl:sent", at: base + 21000 },
    { k: "dl:send", at: base + 21001, d: "P1 2/3 n=10" }, { k: "dl:sent", at: base + 35000 }, { k: "dl:next", at: base + 35900 }, { k: "dl:page", at: base + 38000, d: "P2" },
  ];
  const g = humanGaps(auditTimeline(steps));
  t("並び替えの前: 予定 1023ms・実際 1029ms", g["並び替えの前（予定）"]?.[0] === 1023 && g["並び替えの前（実際）"]?.[0] === 1029, JSON.stringify(g));
  t("資料の束の往復（14.9秒・14.0秒）", g["資料の束の送信（往復）"]?.join() === "14899,13999", JSON.stringify(g));
  t("束と束の間（1ms＝続けて送っている）", g["資料の束の間"]?.[0] === 1, JSON.stringify(g));
  t("最後の束 → 次のページ・次のページの読み込み", g["最後の束 → 次のページ"]?.[0] === 900 && g["次のページへ → 読み込み"]?.[0] === 2100);
  t("入力の始め → 検索を押す", g["入力の始め → 検索を押す"]?.[0] === base - 200 - 1790473328454);
}
{
  const s = summarizeOps([{ t: 100, k: "sel:rental_cost2=80000", p: 120, w: 131 }, { t: 260, k: "city_code[]:27111", p: 90, w: 95 }, { t: 60400, k: "city_code[]:27109", p: 110, w: 60110 }]);
  t("列のまとめ: 件数・間の幅・通り数", s.count === 3 && s.waitMin === 95 && s.waitMax === 60110 && s.distinctWaits === 3);
  t("遅れの最大（60秒）と1秒超の回数（1）", s.lateMax === 60000 && s.lateOver1s === 1);
  t("列が無ければ 0件", summarizeOps(null).count === 0);
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
