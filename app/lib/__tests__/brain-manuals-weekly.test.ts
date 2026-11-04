// app/lib/__tests__/brain-manuals-weekly.test.ts — 取扱説明書の毎週の書き直し（竹内さんの番だけで数える・手の本文を残す）
//   実行: npx tsx app/lib/__tests__/brain-manuals-weekly.test.ts
import { hitOf, tallyWeekly, weeklyRows, writerOfTurn, sceneExtremes, brainManualsWeeklyOn, THIN_N, type WeeklyTurn } from "../brain-manuals-weekly";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const T = (o: Partial<WeeklyTurn>): WeeklyTurn => ({ writer: "takeuchi", scene: "s", brainMode: "auto_reply", brainAction: null, staffAix: [], verdict: "same", hasStaff: true, ...o });

t("道: ブレイン AIX × スタッフ AIX は当たり・返信 × AIX は外れ", hitOf("judge", T({ brainMode: "aix", brainAction: "estimate_sheet", staffAix: ["estimate_sheet"] })) === true && hitOf("judge", T({ staffAix: ["estimate_sheet"] })) === false);
t("AIX の種類: 両方 AIX の時だけ・種類が同じで当たり", hitOf("aix", T({ brainMode: "aix", brainAction: "a", staffAix: ["b", "a"] })) === true && hitOf("aix", T({ brainMode: "aix", brainAction: "a", staffAix: ["b"] })) === false && hitOf("aix", T({})) === null);
t("文: 両方返信の番だけ・same/same_meaning が当たり・na は数えない", hitOf("compose", T({ verdict: "same_meaning" })) === true && hitOf("compose", T({ verdict: "partial" })) === false && hitOf("compose", T({ verdict: "na" })) === null && hitOf("compose", T({ staffAix: ["x"] })) === null);
t("スタッフが答えていない番は数えない", hitOf("judge", T({ hasStaff: false })) === null);

const st = tallyWeekly([T({}), T({ verdict: "different" }), T({ writer: "employee" }), T({ writer: null })]);
t("竹内さんの番だけが基準・従業員は参考に別・書き手不明は数えない", st.compose.takeuchi.n === 2 && st.compose.takeuchi.hit === 1 && st.compose.employee.n === 1 && st.judge.takeuchi.n === 2);
t("場面の数えも竹内さんの番だけ", st.compose.scenes["s"].n === 2);

const many = tallyWeekly([...Array(6)].map(() => T({ scene: "強" })).concat([...Array(6)].map(() => T({ scene: "弱", verdict: "different" }))));
const ex = sceneExtremes(many.compose);
t("強い・弱い場面（5件以上）", ex.strong[0].startsWith("強 100%") && ex.weak[0].startsWith("弱 0%"));

const rows = weeklyRows(st, [{ brain: "compose", item: "hit_rate", body: "手の本文", source: "manual", stats: {} }], { days: 30, day: "2026-11-04" });
const ch = rows.find((r) => r.brain === "compose" && r.item === "hit_rate")!;
t("手の本文（manual）は消さずに後ろ・stats.base に残す", ch.body.endsWith("\n手の本文") && ch.stats.base === "手の本文" && ch.source === "weekly");
t("少ない（20件未満）の印", ch.body.includes("・少ない") && THIN_N === 20);
const rows2 = weeklyRows(st, [{ brain: "compose", item: "hit_rate", body: ch.body, source: "weekly", stats: ch.stats }], { days: 30, day: "2026-11-11" });
t("翌週は前の weekly の行の base から作り直す（本番の行が重ならない）", rows2.find((r) => r.brain === "compose" && r.item === "hit_rate")!.body.split("\n").length === 2);
t("測れない担当（物件検索・見積書・内覧・やる事）は書かない", rows.every((r) => ["judge", "aix", "compose"].includes(r.brain)));
t("本文にお客様の文が入らない形（数と設計の言葉だけ）", /^本番（2026-11-04・直近30日・竹内さんの番だけ）/.test(ch.body));

const ms = [{ created_at: "2026-11-01T01:00:30Z", staff_writer: "takeuchi", staff_writer_confidence: "sure" }, { created_at: "2026-11-01T01:05:00Z", staff_writer: "employee", staff_writer_confidence: "sure" }];
t("書き手: 番の後の最初の送信・sure だけ", writerOfTurn("2026-11-01T01:00:00Z", "2026-11-01T01:00:30Z", ms) === "takeuchi" && writerOfTurn("2026-11-01T01:00:00Z", null, ms) === null && writerOfTurn("2026-11-01T01:00:00Z", "2026-11-01T01:00:30Z", [{ ...ms[0], staff_writer_confidence: "guess" }]) === null);
t("2026-11-04 既定 on・=off で止まる", brainManualsWeeklyOn({}) === true && brainManualsWeeklyOn({ BRAIN_MANUALS_WEEKLY: "off" }) === false);

{ const few = tallyWeekly([...Array(5)].map(() => T({ scene: "A" })).concat([...Array(5)].map(() => T({ scene: "B", verdict: "different" }))));
  const e2 = sceneExtremes(few.compose);
  t("2026-11-04 場面が少ない時、同じ場面を強いと弱いの両方に出さない", !e2.weak.some((w) => e2.strong.includes(w)) && e2.strong.length === 1 && e2.weak.length === 1 && e2.strong[0].startsWith("A 100%")); }
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
