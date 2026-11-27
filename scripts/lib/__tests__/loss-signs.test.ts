// scripts/lib/__tests__/loss-signs.test.ts — 失注の兆しの地図（#805・2026-11-27 作業員A）
//   実行: npx tsx scripts/lib/__tests__/loss-signs.test.ts
import { lossSignalsOf, lossReasonOf, lossSignalTable, lossRecovery, leftSoonAndRecovered, lossLines, type LossTurn } from "../loss-signs";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const S = (texts: string[], o: Partial<{ gapH: number | null; prevGapH: number | null; medLen: number | null; prevWarm: boolean | null }> = {}) =>
  lossSignalsOf({ texts, gapH: o.gapH ?? null, prevGapH: o.prevGapH ?? null, len: texts.join("").length, medLen: o.medLen ?? null, prevWarm: o.prevWarm ?? null });

t("間が延びた: 24時間以上・前の番の3倍以上", S(["はい"], { gapH: 30 }).includes("間が延びた") && S(["はい"], { gapH: 9, prevGapH: 2 }).includes("間が延びた") && !S(["はい"], { gapH: 4, prevGapH: 2 }).includes("間が延びた"));
t("通が短くなった: 会話の中ほどの4割以下", S(["了解です"], { medLen: 60 }).includes("通が短くなった") && !S(["了解です"], { medLen: 10 }).includes("通が短くなった"));
t("言葉: 保留・他社・費用", S(["一旦検討します"]).includes("保留の言葉") && S(["他社で決まりました"]).includes("他社の言葉") && S(["初期費用が高いですね"]).includes("費用の言葉"));
t("温度が下がった: 前の塊に温度の言葉があり今は無い", S(["わかりました"], { prevWarm: true }).includes("温度が下がった") && !S(["ありがとうございます！"], { prevWarm: true }).includes("温度が下がった") && !S(["わかりました"], { prevWarm: false }).includes("温度が下がった"));
t("離れた訳: 他社・費用・言葉なし＝途絶えた", lossReasonOf(["他社さんで契約しました"]) === "他社に決めた" && lossReasonOf(["予算的に厳しいです"]) === "費用で止まった" && lossReasonOf(null) === "途絶えた");

// 照らしの json の行: 同じ会話の後の2番の内に left があれば離れた番・後に前へが出れば戻せた
const rows = [
  { conv: "c1", at: "2026-11-01T00:00:00Z", outcome: "engaged" },
  { conv: "c1", at: "2026-11-02T00:00:00Z", outcome: "stuck" },
  { conv: "c1", at: "2026-11-03T00:00:00Z", outcome: "left" },
  { conv: "c2", at: "2026-11-01T00:00:00Z", outcome: "stuck" },
  { conv: "c2", at: "2026-11-02T00:00:00Z", outcome: "advanced" },
];
t("離れる前の2〜3番: その番か後の2番に left", leftSoonAndRecovered(rows, 0).leftSoon && leftSoonAndRecovered(rows, 1).leftSoon && !leftSoonAndRecovered(rows, 3).leftSoon);
t("戻せた: 後に前へ（advanced・back）", leftSoonAndRecovered(rows, 3).recovered && !leftSoonAndRecovered(rows, 1).recovered);

const turns: LossTurn[] = [
  { conv: "a", at: "1", signals: ["間が延びた"], leftSoon: true, act: "reply:promise", recovered: false },
  { conv: "b", at: "1", signals: ["間が延びた"], leftSoon: false, act: "reply:invite_viewing", recovered: true },
  { conv: "c", at: "1", signals: [], leftSoon: false, act: "reply:answer", recovered: true },
  { conv: "d", at: "1", signals: [], leftSoon: false, act: "reply:answer", recovered: true },
];
const tb = lossSignalTable(turns);
const g = tb.find((x) => x.signal === "間が延びた")!;
t("表: 出た番の離れた割合と出なかった番の割合・差", g.withN === 2 && g.withPct === 50 && g.withoutN === 2 && g.withoutPct === 0 && g.diffPt === 50);
const rc = lossRecovery(turns).find((x) => x.signal === "間が延びた")!;
t("戻す一手: 合図の出た番の一手ごとに戻せた数", rc.acts.length === 2 && rc.acts.some((a) => a.act === "reply:invite_viewing" && a.back === 1 && a.n === 1));
const lines = lossLines(tb, lossRecovery(turns), { 途絶えた: 1 }, turns.length);
t("行: 見出し・合図ごと・戻す一手", /失注の兆しの地図/.test(lines[0]) && lines.some((l) => l.startsWith("- 間が延びた: 出た番 2")) && lines.some((l) => l.startsWith("- 戻す一手（間が延びた）")));
console.log(`loss-signs: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
