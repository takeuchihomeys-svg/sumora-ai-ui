// app/lib/__tests__/switch-regress-watch.test.ts — on にしたスイッチの悪化の見張り（#813・2026-11-27 作業員A）
//   実行: npx tsx app/lib/__tests__/switch-regress-watch.test.ts
//   行の形は本番の quality_daily（value は文字列の数・n・source が line-watch-eval と scripts/self-improve.ts の2つ）
import { switchOnDays, compareAround, decideSwitchRegress, regressMorningLine, zDrop, switchesToWatch, groupByOnDay, type QualityRow } from "../switch-regress-watch";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

// 本番の 11/21〜25 の形（今朝の返信の一致は5番・0%）
const real: QualityRow[] = [
  { day: "2026-11-25", metric: "reply_match", scope: "all", value: "0", n: 5, source: "scripts/self-improve.ts" },
  { day: "2026-11-25", metric: "reply_match", scope: "takeuchi", value: "0", n: 1, source: "scripts/self-improve.ts" },
  { day: "2026-11-25", metric: "aix_first_match", scope: "takeuchi", value: null, n: 0, source: "scripts/self-improve.ts" },
  { day: "2026-11-24", metric: "reply_match", scope: "all", value: "76.5", n: 17, source: "line-watch-eval" },
  { day: "2026-11-23", metric: "reply_match", scope: "all", value: "66.7", n: 3, source: "line-watch-eval" },
  { day: "2026-11-22", metric: "reply_match", scope: "all", value: "50", n: 4, source: "line-watch-eval" },
];
const r1 = compareAround({ rows: real, metric: "reply_match", scope: "all", onDay: "2026-11-24", todayYmd: "2026-11-27" });
t("番が少ない日は「分からない」（今朝の 5番・0% を下がったにしない）", r1.verdict === "unknown" && r1.dropPt === null && /番が少ない/.test(r1.why));
t("値が null・n 0 の行は数えない", compareAround({ rows: real, metric: "aix_first_match", scope: "takeuchi", onDay: "2026-11-24", todayYmd: "2026-11-27" }).after.n === 0);
t("同じ日に出所が2つあれば番の多い方", compareAround({ rows: [...real, { day: "2026-11-24", metric: "reply_match", scope: "all", value: "10", n: 2, source: "scripts/self-improve.ts" }], metric: "reply_match", scope: "all", onDay: "2026-11-23", todayYmd: "2026-11-27" }).after.n === 17 + 5);

// 作った7日ずつ（前 80%・後 60%・各 7日×10番）
const mk = (from: string, days: number, value: number, n: number, metric = "reply_match", scope = "all"): QualityRow[] =>
  Array.from({ length: days }, (_, i) => ({ day: new Date(Date.parse(`${from}T00:00:00Z`) + i * 864e5).toISOString().slice(0, 10), metric, scope, value: String(value), n, source: "line-watch-eval" }));
const big = [...mk("2026-11-10", 7, 80, 10), { day: "2026-11-17", metric: "reply_match", scope: "all", value: "0", n: 30 }, ...mk("2026-11-18", 7, 60, 10)];
const r2 = compareAround({ rows: big, metric: "reply_match", scope: "all", onDay: "2026-11-17", todayYmd: "2026-11-27" });
t("下がった: 80%→60%・各70番・z が線を越える", r2.verdict === "down" && r2.dropPt === 20 && (r2.z ?? 0) >= 1.64);
t("on にした日そのものは入れない（11/17 の 0% 30番は混ざらない）", r2.before.n === 70 && r2.after.n === 70);
const small = [...mk("2026-11-10", 7, 80, 3), ...mk("2026-11-18", 7, 74, 3)];
const r3 = compareAround({ rows: small, metric: "reply_match", scope: "all", onDay: "2026-11-17", todayYmd: "2026-11-27" });
t("揺れの内: 6pt 下がっても各21番では z が線に届かない＝変わらない", r3.verdict === "keep" && (r3.dropPt ?? 0) >= 5 && /揺れの内/.test(r3.why));
t("z: 同じ比率なら 0", Math.abs(zDrop({ n: 50, match: 40, days: 5 }, { n: 50, match: 40, days: 5 })) < 1e-9);

// スイッチ1つ: どれか下がれば知らせて台帳へ・全部分からなければ unknown
const sv = decideSwitchRegress({ name: "FOO_LINE", onDay: "2026-11-17", rows: big, todayYmd: "2026-11-27" });
t("どれか1つ下がった＝down・知らせて台帳に積む（自動では切らない）", sv.verdict === "down" && sv.action === "notify_ledger");
t("全部分からない＝unknown", decideSwitchRegress({ name: "BAR", onDay: "2026-11-24", rows: real, todayYmd: "2026-11-27" }).verdict === "unknown");

// 版の並びから on にした日（JST）
const onDays = switchOnDays([
  { switches: "A=on\nB=off", first_seen_at: "2026-11-03T05:40:19Z" },
  { switches: "A=on\nB=on\nC=on", first_seen_at: "2026-11-05T13:35:19Z" },
  { switches: "A=on\nB=on", first_seen_at: "2026-11-15T03:35:19Z" },
]);
t("on にした日: 前の版に無く今の版で on になった日（JST）・off に戻った物は消す", onDays.get("A") === "2026-11-03" && onDays.get("B") === "2026-11-05" && !onDays.has("C"));
t("見る物: 60日より前の on は見ない", switchesToWatch(new Map([["A", "2026-09-01"], ["B", "2026-11-20"]]), "2026-11-27").map((x) => x.name).join() === "B");

const g = groupByOnDay([{ name: "A", onDay: "2026-11-15" }, { name: "B", onDay: "2026-11-15" }, { name: "C", onDay: "2026-11-05" }]);
t("同じ日に on の物は束で1つ（11/15 に 41本が一度に on の本番の形）", g.length === 2 && g[0].name === "2026-11-15 の束（2本）" && g[0].members.join() === "A,B" && g[1].name === "C");
const line = regressMorningLine([sv, decideSwitchRegress({ name: "BAR", onDay: "2026-11-24", rows: real, todayYmd: "2026-11-27" })]);
t("朝の1行: 下がった物の名前と物差し・自動では切らない・分からないの数", /下がった 1＝FOO_LINE（2026-11-17 on・返信の一致\/all 80→60%）/.test(line) && /自動では切らない/.test(line) && /分からない 1/.test(line));
console.log(`switch-regress-watch: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
