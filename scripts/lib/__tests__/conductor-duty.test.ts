// 統括の受け持ち表（scripts/lib/conductor-duty.ts）
// 実行: npx tsx scripts/lib/__tests__/conductor-duty.test.ts（全 PASS で exit 0）
import { CONDUCTOR_DUTY, conductorDutyOf, conductorDutySummary, conductorDutyGapsToAdd, dutyGapPrefix, type DutyRow } from "../conductor-duty";
import { LINKAGE_MAP } from "../../../app/lib/linkage-map";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };

const known = new Set(LINKAGE_MAP.map((r) => r.id));
ok("表の行はどれも連携の地図にある", CONDUCTOR_DUTY.every((r) => [...r.have, ...r.use, ...r.reflect].every((x) => known.has(x))), CONDUCTOR_DUTY.flatMap((r) => [...r.have, ...r.use, ...r.reflect]).filter((x) => !known.has(x)));
const T: DutyRow[] = [
  { id: "a", name: "A", owner: "作業員A", have: ["r1"], use: ["c1"], reflect: ["w1"] },
  { id: "b", name: "B", owner: "作業員L", have: ["r1"], use: ["c2"], reflect: ["w1"], parts: ["X_ON"] },
  { id: "c", name: "C", owner: "作業員N", have: ["r9"], use: ["c1"], reflect: ["w1"] },
];
const k = new Set(["r1", "c1", "c2", "w1"]);
const res = conductorDutyOf(T, k, { cut: new Set(), off: new Set(["c2"]), unmeasured: new Set() });
ok("全部つながっていれば反映まで", res[0].reach === "reflect" && res[0].stages.reflect.state === "済");
ok("使うの行が親 off なら 持つまで・使うが欠け", res[1].reach === "have" && res[1].stages.use.state === "欠け" && res[1].stages.use.bad[0] === "c2");
ok("地図に無い行は未確認（持つが未）", res[2].reach === null && res[2].stages.have.state === "未確認");
ok("見張りの結果が無ければ全部未確認", conductorDutyOf(T, k, null).every((r) => r.reach === null));
ok("測れない行は未確認", conductorDutyOf(T, k, { cut: new Set(), off: new Set(), unmeasured: new Set(["w1"]) })[0].stages.reflect.state === "未確認");
const sm = conductorDutySummary(res);
ok("毎朝の1行", sm.line.startsWith("統括の受け持ち: 持つ 2/3・使う 1/3・反映 1/3") && sm.notReflected.length === 2 && sm.line.includes("使うが欠け c2"), sm.line);
const g = conductorDutyGapsToAdd(res, [`${dutyGapPrefix("C")} 前の行`]);
ok("欠けのある土台だけ台帳へ・部品を先につなぐ案", g.length === 1 && g[0].title.startsWith(dutyGapPrefix("B")) && g[0].next.includes("X_ON") && g[0].owner === "作業員L");
ok("同じ土台の行が開いていれば足さない", conductorDutyGapsToAdd(res, [`${dutyGapPrefix("B")} 前の行`]).length === 0);

console.log(`conductor-duty: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
