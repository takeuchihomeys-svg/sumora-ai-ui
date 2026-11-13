// app/lib/__tests__/customer-fact-ledger-three.test.ts — 帳面の事情・外した物件・言い直した条件・再来と、今の一通との照らし（実行: npx tsx app/lib/__tests__/customer-fact-ledger-three.test.ts）
//   実物の形（名前・物件名は伏せた）: 12548（数日前の「12月に異動・会社の上限」）・12370（外した物件の再依頼・10万はこのエリアだけか）・12306（再来）
import { factsThree, turnFactMarks, turnFactMarksLine, factLedgerThreeOn, memoItemsToThree } from "../customer-fact-ledger";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, d = "") => { if (ok) pass++; else { fail++; console.log(`NG ${n} ${d}`); } };
t("既定 off", !factLedgerThreeOn({}) && factLedgerThreeOn({ FACT_LEDGER_THREE: "on" }));
// 12548
const x1 = { circumstances: [{ text: "12月に異動・法人契約で会社の上限が8万円", at: "2026-11-05T01:00:00Z" }] };
const m1 = turnFactMarks("会社の規定だと8万までなんですがありますか？", x1);
t("12548: 事情（会社の上限）を前提にしている", m1.some((m) => m.mark === "前提"), JSON.stringify(m1));
// 12370
const x2 = { excluded: [{ name: "グランシャトー難波 802", why: "線路が近い" }], restated: [{ field: "rent_max", from: "90000", to: "100000", scope: "難波周辺だけ" }] };
const m2 = turnFactMarks("やっぱりグランシャトー難波も見たいです。家賃10万でお願いします", x2);
t("12370: 外した物件の再依頼＝取り消し", m2.some((m) => m.mark === "取り消し"), JSON.stringify(m2));
t("12370: 10万の言い直し（範囲: 難波周辺だけ）", m2.some((m) => m.mark === "言い直し" && m.fact.includes("難波周辺だけ")), JSON.stringify(m2));
// 12306
const x3 = { revisit: { result: "won", endedAt: "2025-03-20T00:00:00Z", propertyName: "前回の契約の物件" } };
t("12306: 再来の印", turnFactMarks("お久しぶりです、また引っ越しを考えてます", x3).some((m) => m.mark === "再来"));
t("帳面に4種の事実", factsThree({ ...x1, ...x2, ...x3 }).length === 4, JSON.stringify(factsThree({ ...x1, ...x2, ...x3 }).map((f) => f.value)));
t("言い直しの事実は日本語の欄名と範囲", factsThree(x2).some((f) => f.value === "言い直した条件: 家賃の上限 90000→100000（範囲: 難波周辺だけ）"));
t("照らしの行（印が無ければ空）", turnFactMarksLine([]) === "" && turnFactMarksLine(m2).startsWith("【今の一通と帳面の照らし"));
t("関係ない一通は印なし", turnFactMarks("ありがとうございます", x2).length === 0);
// メモの項目 → 事情・外した物件（kind の名前はメモのまま）
{
  const r = memoItemsToThree([
    { kind: "circumstance", text: "12月に異動・法人契約で会社の上限8万", sourceAt: "2026-11-05T01:00:00Z" },
    { kind: "people", text: "奥様が最後に決める" },
    { kind: "ng", text: "線路が近いので無し", property: "グランシャトー難波 802" },
    { kind: "ng", text: "1階は無し" },
    { kind: "circumstance", text: "古い事情", retiredAt: "2026-11-01T00:00:00Z" },
  ]);
  t("メモ: 事情と決める人が事情に（外した行は入れない）", (r.circumstances ?? []).length === 2 && (r.circumstances ?? [])[1].text === "決める人: 奥様が最後に決める");
  t("メモ: NG で物件を名指しした物だけ外した物件に", (r.excluded ?? []).length === 1 && (r.excluded ?? [])[0].name === "グランシャトー難波 802");
}
console.log(`customer-fact-ledger-three: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
