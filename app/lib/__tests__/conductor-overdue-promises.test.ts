// app/lib/__tests__/conductor-overdue-promises.test.ts — 期限を過ぎた約束の入口の統括の1行（2026-11-21 作業員N）
//   実行: npx tsx app/lib/__tests__/conductor-overdue-promises.test.ts
import { conductorOverduePromisesOn, overduePromisesLine } from "../conductor-overdue-promises";
import { overduePromisesOf } from "../promise-drop-watch";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

t("既定 on（11/21）・=off で止める", conductorOverduePromisesOn({}) && conductorOverduePromisesOn({ CONDUCTOR_OVERDUE_PROMISES: "on" }) && !conductorOverduePromisesOn({ CONDUCTOR_OVERDUE_PROMISES: "off" }));
t("無ければ空", overduePromisesLine([]) === "");

const line = overduePromisesLine([
  { kind: "pickup", promisedAt: "2026-11-06T10:59:00Z", dueAt: "2026-11-09T10:59:00Z", dueBy: "default72h", daysOver: 11 },
  { kind: "check", promisedAt: "2026-11-05T01:00:00Z", dueAt: "2026-11-05T15:00:00Z", dueBy: "words", daysOver: 0 },
]);
t("古い順", line.indexOf("募集状況") < line.indexOf("ピックアップ"));
t("JST の日付と期限の決まり", /11\/5に約束・期限 11\/6（約束の文の期限）・今日過ぎた/.test(line) && /11\/6に約束・期限 11\/9（72時間）・11日過ぎ/.test(line));
t("道の言葉を入れない", !/送る|謝|お詫び|すぐ|べき|ください/.test(line));
const many = overduePromisesLine(Array.from({ length: 5 }, (_, i) => ({ kind: "pickup" as const, promisedAt: `2026-11-0${i + 1}T00:00:00Z`, dueAt: `2026-11-0${i + 4}T00:00:00Z`, dueBy: "default72h" as const, daysOver: 3 })));
t("最大3つ", (many.match(/に約束/g) ?? []).length === 3);

// 作業員L の純関数とつないだ時（実物の形・名前は伏せた）: ピックアップを約束して、その後に物件も AIX も無い
const now = Date.parse("2026-11-21T00:00:00Z");
const od = overduePromisesOf({
  status: "proposing",
  msgs: [
    { sender: "staff", text: "かしこまりました！！ 若江岩田・八戸の里周辺も含めて、ペット2匹飼育可能なお部屋を新たにピックアップしてお送りさせて頂きます！！", created_at: "2026-11-06T10:59:00Z", is_aix_generated: false },
    { sender: "customer", text: "ありがとうございます😭", created_at: "2026-11-06T11:49:00Z" },
  ],
  aix: [], sent: [],
}, now);
t("L の関数の結果が1行になる", od.length === 1 && /物件のピックアップ（11\/6に約束・期限 11\/9（72時間）/.test(overduePromisesLine(od)));
// 条件の用紙の入力待ちは数えない（L の穴2の直し）
const wait = overduePromisesOf({
  status: "hearing",
  msgs: [{ sender: "staff", text: "ご希望のご条件お送り頂きますと、ご条件に合ったお部屋ピックアップさせて頂きます！！ お手隙の際にご入力ください😌！！", created_at: "2026-11-05T08:48:00Z", is_aix_generated: false }],
  aix: [], sent: [],
}, now);
t("条件つきの約束は出ない", overduePromisesLine(wait) === "");

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
